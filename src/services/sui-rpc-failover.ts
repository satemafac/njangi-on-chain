import {
  SuiClient,
  SuiHTTPTransport,
  type SuiTransport,
  type SuiTransportRequestOptions,
  type SuiTransportSubscribeOptions,
} from '@mysten/sui/client';

import {
  getCurrentNetwork,
  getNetworkConfig,
  type NetworkType,
} from './network-config';

const directClientPool = new Map<string, SuiClient>();
const failoverClientPool = new Map<string, SuiClient>();
const RETRIABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);
const KNOWN_NETWORKS: NetworkType[] = ['testnet', 'mainnet'];
const RATE_LIMIT_COOLDOWN_MS = 30_000;
const TRANSIENT_FAILURE_COOLDOWN_MS = 10_000;
const rpcCooldowns = new Map<string, { until: number; reason: string }>();
const SHARED_RPC_FALLBACK_URLS: Record<NetworkType, string[]> = {
  testnet: [
    'https://sui-testnet-rpc.publicnode.com',
    'https://sui-testnet-endpoint.blockvision.org',
  ],
  mainnet: [
    'https://sui-rpc.publicnode.com',
    'https://sui-mainnet-endpoint.blockvision.org',
  ],
};

/**
 * Endpoints that answer correctly but ration requests, so they are tried LAST
 * for general traffic no matter where the configuration puts them.
 *
 * The providers are not interchangeable, which is the whole reason this exists.
 * After Sui retired JSON-RPC on its public fullnodes: publicnode and suiscan
 * serve object reads but refuse event history, while blockvision serves both
 * and rate-limits. Since object reads are the overwhelming majority of traffic
 * and event scans are rare, spending blockvision's budget on reads starves the
 * one thing only it can do.
 *
 * Observed on production 2026-08-02: blockvision sat second in the candidate
 * order, so ordinary dashboard loads hit it constantly — 3 of 17 calls came
 * back 429 and the dashboard rendered 0 circles and $0 for an address holding
 * 4.15 SUI and two membership receipts. Correct endpoints, wrong order.
 */
const RATE_LIMITED_RPC_HOSTS = ['blockvision.org'];

function deprioritizeRateLimited(urls: string[]): string[] {
  const limited = (u: string) => RATE_LIMITED_RPC_HOSTS.some((h) => u.includes(h));
  return [...urls.filter((u) => !limited(u)), ...urls.filter(limited)];
}

export interface SuiRpcAttemptContext {
  attempt: number;
  isFallback: boolean;
  network: NetworkType;
  rpcUrl: string;
}

export interface HealthySuiClient {
  client: SuiClient;
  isFallback: boolean;
  rpcUrl: string;
}

export interface SharedSuiClientArgs {
  network?: NetworkType;
  rpcUrl?: string;
}

function isValidRpcUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function normalizeRpcUrl(value: string): string {
  try {
    const parsed = new URL(value.trim());
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return value.trim();
  }
}

function dedupeRpcUrls(urls: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const url of urls) {
    const normalized = normalizeRpcUrl(url);
    if (!normalized || seen.has(normalized) || !isValidRpcUrl(normalized)) {
      continue;
    }

    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}

function extractStatusCode(message: string): number | null {
  const match = message.match(/Unexpected status code:\s*(\d{3})/i);
  if (!match) {
    return null;
  }

  return Number.parseInt(match[1], 10);
}

export function getSuiRpcErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : error == null
        ? ''
        : String(error);
}

export function isRateLimitedSuiRpcError(error: unknown): boolean {
  const message = getSuiRpcErrorMessage(error);
  if (!message) {
    return false;
  }

  const statusCode = extractStatusCode(message);
  if (statusCode !== null) {
    return statusCode === 429;
  }

  const normalized = message.toLowerCase();
  return (
    normalized.includes('too many requests') ||
    normalized.includes('rate limit') ||
    normalized.includes('rate limited')
  );
}

export function getRpcCandidateUrls(network: NetworkType): string[] {
  const { rpcUrl, rpcAltUrl } = getNetworkConfig(network);
  // Deprioritize AFTER dedupe, so a rate-limited host sinks to the back even
  // when it is what NEXT_PUBLIC_*_RPC_ALT points at. Operator config decides
  // WHICH endpoints are used; this decides the order they are spent in.
  const candidates = deprioritizeRateLimited(
    dedupeRpcUrls([rpcUrl, rpcAltUrl, ...SHARED_RPC_FALLBACK_URLS[network]]),
  );

  if (candidates.length === 0) {
    throw new Error(`No valid RPC URLs configured for ${network}.`);
  }

  return candidates;
}

export function getRpcCandidateUrlsForRpcUrl(args: {
  rpcUrl: string;
  network?: NetworkType;
}): string[] {
  const requestedRpcUrl = normalizeRpcUrl(args.rpcUrl);

  if (args.network) {
    return dedupeRpcUrls([requestedRpcUrl, ...getRpcCandidateUrls(args.network)]);
  }

  for (const network of KNOWN_NETWORKS) {
    const candidates = getRpcCandidateUrls(network);
    if (candidates.some((candidate) => normalizeRpcUrl(candidate) === requestedRpcUrl)) {
      return dedupeRpcUrls([requestedRpcUrl, ...candidates]);
    }
  }

  if (!isValidRpcUrl(requestedRpcUrl)) {
    throw new Error(`Invalid RPC URL: ${args.rpcUrl}`);
  }

  return [requestedRpcUrl];
}

class SuiFailoverTransport implements SuiTransport {
  private readonly transports: Array<{ rpcUrl: string; transport: SuiHTTPTransport }>;

  constructor(rpcUrls: string[]) {
    this.transports = dedupeRpcUrls(rpcUrls).map((rpcUrl) => ({
      rpcUrl,
      transport: new SuiHTTPTransport({ url: rpcUrl }),
    }));

    if (this.transports.length === 0) {
      throw new Error('Sui failover transport requires at least one valid RPC URL.');
    }
  }

  private getOrderedTransports(): {
    earliestCooldownUntil: number | null;
    orderedTransports: Array<{ rpcUrl: string; transport: SuiHTTPTransport }>;
    cooldownReasons: string[];
  } {
    const now = Date.now();
    const ready: Array<{ rpcUrl: string; transport: SuiHTTPTransport }> = [];
    const cooling: Array<{
      rpcUrl: string;
      transport: SuiHTTPTransport;
      until: number;
      reason: string;
    }> = [];

    for (const candidate of this.transports) {
      const cooldown = rpcCooldowns.get(candidate.rpcUrl);
      if (!cooldown || cooldown.until <= now) {
        if (cooldown) {
          rpcCooldowns.delete(candidate.rpcUrl);
        }
        ready.push(candidate);
        continue;
      }

      cooling.push({
        ...candidate,
        until: cooldown.until,
        reason: cooldown.reason,
      });
    }

    const orderedCooling = cooling.sort((a, b) => a.until - b.until);

    return {
      earliestCooldownUntil: orderedCooling[0]?.until ?? null,
      orderedTransports: ready,
      cooldownReasons: orderedCooling.map((candidate) => candidate.reason),
    };
  }

  private buildCooldownError(
    method: string,
    earliestCooldownUntil: number,
    cooldownReasons: string[],
  ): Error {
    const remainingSeconds = Math.max(
      1,
      Math.ceil((earliestCooldownUntil - Date.now()) / 1000),
    );
    const isRateLimited = cooldownReasons.some((reason) => isRateLimitedSuiRpcError(reason));

    if (isRateLimited) {
      return new Error(
        `[sui.transport:${method}] All configured Sui RPC endpoints are in rate limit cooldown. Retry in about ${remainingSeconds}s.`,
      );
    }

    return new Error(
      `[sui.transport:${method}] All configured Sui RPC endpoints are cooling down after transient failures. Retry in about ${remainingSeconds}s.`,
    );
  }

  private markCooldown(rpcUrl: string, error: unknown): void {
    const message = getSuiRpcErrorMessage(error);

    // A capability gap is not ill health. publicnode serves object reads
    // perfectly but has no event history, so every queryEvents against it
    // fails — benching it for 10s over that took the ONE endpoint that
    // answers the app's most common call out of rotation, cascading into
    // "all endpoints cooling down" and a dashboard showing 0 circles and $0
    // for a funded account (observed in production 2026-08-02).
    //
    // These failures still fail OVER — the request moves to the next
    // candidate — they just do not penalise the endpoint for the methods it
    // does serve.
    if (isCapabilityGapError(message)) {
      console.warn(
        `[sui.transport] ${rpcUrl} does not serve this method; failing over without cooldown: ${message}`,
      );
      return;
    }

    const statusCode = extractStatusCode(message);
    const durationMs =
      statusCode === 429 ? RATE_LIMIT_COOLDOWN_MS : TRANSIENT_FAILURE_COOLDOWN_MS;
    const until = Date.now() + durationMs;

    rpcCooldowns.set(rpcUrl, {
      until,
      reason: message,
    });

    console.warn(
      `[sui.transport] Cooling down RPC ${rpcUrl} for ${durationMs}ms after failure: ${message}`,
    );
  }

  async request<T = unknown>(input: SuiTransportRequestOptions): Promise<T> {
    let lastError: unknown;
    const { cooldownReasons, earliestCooldownUntil, orderedTransports } = this.getOrderedTransports();

    if (orderedTransports.length === 0 && earliestCooldownUntil !== null) {
      const error = this.buildCooldownError(
        input.method,
        earliestCooldownUntil,
        cooldownReasons,
      );
      console.warn(error.message);
      throw error;
    }

    for (const [index, candidate] of orderedTransports.entries()) {
      try {
        return await candidate.transport.request<T>(input);
      } catch (error) {
        lastError = error;
        const hasNextCandidate = index < orderedTransports.length - 1;
        const isRetriable = isRetriableSuiRpcError(error);

        if (isRetriable) {
          this.markCooldown(candidate.rpcUrl, error);
        }

        if (!hasNextCandidate || !isRetriable) {
          throw error;
        }

        const message = getSuiRpcErrorMessage(error);
        console.warn(
          `[sui.transport:${input.method}] RPC ${candidate.rpcUrl} failed with a retriable error, trying next RPC: ${message}`,
        );
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error(`[sui.transport:${input.method}] RPC failover exhausted all candidates.`);
  }

  async subscribe<T = unknown>(
    input: SuiTransportSubscribeOptions<T>,
  ): Promise<() => Promise<boolean>> {
    let lastError: unknown;
    const { cooldownReasons, earliestCooldownUntil, orderedTransports } = this.getOrderedTransports();

    if (orderedTransports.length === 0 && earliestCooldownUntil !== null) {
      const error = this.buildCooldownError(
        input.method,
        earliestCooldownUntil,
        cooldownReasons,
      );
      console.warn(error.message);
      throw error;
    }

    for (const [index, candidate] of orderedTransports.entries()) {
      try {
        return await candidate.transport.subscribe(input);
      } catch (error) {
        lastError = error;
        const hasNextCandidate = index < orderedTransports.length - 1;
        const isRetriable = isRetriableSuiRpcError(error);

        if (isRetriable) {
          this.markCooldown(candidate.rpcUrl, error);
        }

        if (!hasNextCandidate || !isRetriable) {
          throw error;
        }

        const message = getSuiRpcErrorMessage(error);
        console.warn(
          `[sui.transport:${input.method}] Subscription RPC ${candidate.rpcUrl} failed with a retriable error, trying next RPC: ${message}`,
        );
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error(`[sui.transport:${input.method}] Subscription failover exhausted all candidates.`);
  }
}

export function getSuiClientForRpcUrl(rpcUrl: string): SuiClient {
  const normalizedRpcUrl = normalizeRpcUrl(rpcUrl);

  if (!directClientPool.has(normalizedRpcUrl)) {
    directClientPool.set(normalizedRpcUrl, new SuiClient({ url: normalizedRpcUrl }));
  }

  return directClientPool.get(normalizedRpcUrl)!;
}

export function getPooledSuiClient(args: SharedSuiClientArgs = {}): SuiClient {
  const candidateUrls = args.rpcUrl
    ? getRpcCandidateUrlsForRpcUrl({
        rpcUrl: args.rpcUrl,
        network: args.network,
      })
    : getRpcCandidateUrls(args.network ?? getCurrentNetwork());
  const cacheKey = candidateUrls.join('|');

  if (!failoverClientPool.has(cacheKey)) {
    failoverClientPool.set(
      cacheKey,
      new SuiClient({
        transport: new SuiFailoverTransport(candidateUrls),
      }),
    );
  }

  return failoverClientPool.get(cacheKey)!;
}

export function clearSuiRpcClientPool(): void {
  directClientPool.clear();
  failoverClientPool.clear();
  rpcCooldowns.clear();
}

/**
 * True when the endpoint is healthy but does not serve THIS method or data.
 *
 * Distinct from a transient failure: retrying later against the same endpoint
 * will never work, and taking it out of rotation punishes it for calls it
 * handles fine. Sui's public fullnodes withdrew JSON-RPC entirely; publicnode
 * and suiscan serve object reads but prune event history. Both present as
 * application errors on an otherwise healthy connection.
 *
 * Callers should fail OVER on these, and must NOT cool the endpoint down.
 */
export function isCapabilityGapError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('could not find the referenced transaction') ||
    normalized.includes('method not found') ||
    normalized.includes('json-rpc on public fullnodes has been deprecated') ||
    normalized.includes('jsonrpc has been deprecated')
  );
}

export function isRetriableSuiRpcError(error: unknown): boolean {
  const message = getSuiRpcErrorMessage(error);
  if (!message) {
    return false;
  }

  const statusCode = extractStatusCode(message);
  if (statusCode !== null) {
    return RETRIABLE_STATUS_CODES.has(statusCode);
  }

  const normalized = message.toLowerCase();
  return (
    normalized.includes('no healthy upstream') ||
    normalized.includes('service unavailable') ||
    normalized.includes('failed to fetch') ||
    normalized.includes('fetch failed') ||
    normalized.includes('networkerror') ||
    normalized.includes('socket hang up') ||
    normalized.includes('timed out') ||
    normalized.includes('timeout') ||
    normalized.includes('econnreset') ||
    normalized.includes('econnrefused') ||
    normalized.includes('etimedout') ||
    normalized.includes('und_err_connect_timeout') ||
    // Per-node indexer gaps: one fullnode may not have indexed a recent
    // tx/event yet while another has. Treat as retriable so the failover
    // can ask the alternate node.
    normalized.includes('could not find the referenced transaction') ||
    normalized.includes('could not find object') ||
    normalized.includes('transaction not found') ||
    // An endpoint that has withdrawn its JSON-RPC surface. Sui deprecated
    // JSON-RPC on its public fullnodes, which `fullnode.*.sui.io` serves as
    // HTTP 200 carrying a JSON-RPC error body — so it reaches us as an
    // application error, not a transport failure, and every check above
    // misses it. The endpoint is permanently dead rather than blipping, but
    // "try the next host" is exactly the right response and is what failover
    // exists for: without this, a healthy alternate is never attempted and
    // the whole app loses chain access behind one retired primary.
    //
    // Cost when the method is genuinely absent everywhere: we walk the host
    // list before failing. That is a slower failure, not a wrong one.
    normalized.includes('method not found') ||
    normalized.includes('json-rpc on public fullnodes has been deprecated') ||
    normalized.includes('jsonrpc has been deprecated')
  );
}

/**
 * A transient RPC condition — rate-limit cooldown, failover cooldown after
 * transient upstream failures, or any retriable network blip. These mean the
 * call should be retried, not that the operation truly failed. Catch sites use
 * this to log warnings (and degrade gracefully) instead of `console.error`,
 * which Next.js dev surfaces as a blocking "Unhandled Runtime Error" overlay.
 */
export function isTransientSuiRpcError(error: unknown): boolean {
  if (isRateLimitedSuiRpcError(error) || isRetriableSuiRpcError(error)) {
    return true;
  }
  const message = getSuiRpcErrorMessage(error).toLowerCase();
  return message.includes('cooldown') || message.includes('cooling down');
}

/**
 * Log a failed best-effort Sui read at the right level: a transient condition
 * (rate-limit / failover cooldown / retriable blip) is a `console.warn` so it
 * degrades quietly, while a genuine error stays a `console.error`. Use this in
 * "log-and-continue" read catches so transient cooldowns don't trip the Next.js
 * dev "Unhandled Runtime Error" overlay (which surfaces console.error'd Errors).
 *
 * Returns `true` when the error was transient — callers can use this to suppress
 * a user-facing error toast for a blip that will self-heal on the next refresh.
 */
export function logSuiReadError(context: string, error: unknown): boolean {
  if (isTransientSuiRpcError(error)) {
    console.warn(`${context} — deferred (transient RPC):`, getSuiRpcErrorMessage(error));
    return true;
  }
  console.error(context, error);
  return false;
}

export async function withSuiRpcFailover<T>(
  network: NetworkType,
  operationName: string,
  operation: (client: SuiClient, context: SuiRpcAttemptContext) => Promise<T>,
): Promise<T> {
  const rpcUrls = getRpcCandidateUrls(network);
  let lastError: unknown;

  for (const [index, rpcUrl] of rpcUrls.entries()) {
    const context: SuiRpcAttemptContext = {
      attempt: index + 1,
      isFallback: index > 0,
      network,
      rpcUrl,
    };

    try {
      if (context.isFallback) {
        console.warn(
          `[${operationName}] Retrying with fallback RPC ${rpcUrl} (attempt ${context.attempt}/${rpcUrls.length})`,
        );
      }

      return await operation(getSuiClientForRpcUrl(rpcUrl), context);
    } catch (error) {
      lastError = error;
      const hasNextCandidate = index < rpcUrls.length - 1;

      if (!hasNextCandidate || !isRetriableSuiRpcError(error)) {
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[${operationName}] RPC ${rpcUrl} failed with a retriable error, trying next RPC: ${message}`,
      );
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`[${operationName}] RPC failover exhausted all candidates.`);
}

export async function getHealthySuiClient(
  network: NetworkType,
  operationName: string,
): Promise<HealthySuiClient> {
  return withSuiRpcFailover(network, `${operationName}.probe`, async (client, context) => {
    await client.getLatestCheckpointSequenceNumber();
    return {
      client,
      isFallback: context.isFallback,
      rpcUrl: context.rpcUrl,
    };
  });
}
