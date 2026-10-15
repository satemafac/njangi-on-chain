// sui-epoch.ts — the current Sui epoch, for zkLogin's maxEpoch.
//
// Sign-in needs one chain fact before it can build the OAuth nonce: the
// current epoch. It used to come only from JSON-RPC `getLatestSuiSystemState`,
// so sign-in broke whenever JSON-RPC did. On 2026-10-15 that was every testnet
// provider at once: publicnode answered 503 "no available nodes found",
// blockvision -32603 / 429, and Sui's own fullnodes have retired JSON-RPC.
// Sui's GraphQL service still answered, so it is read first and JSON-RPC is
// the fallback.

import { getGraphqlUrlForNetwork, type NetworkType } from '@/services/network-config';
import { withSuiRpcFailover } from '@/services/sui-rpc-failover';

const EPOCH_QUERY = '{ epoch { epochId } }';
const GRAPHQL_TIMEOUT_MS = 8_000;

function parseEpoch(raw: unknown): number | null {
  const n =
    typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN;
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readEpochViaGraphql(network: NetworkType): Promise<number> {
  const url = getGraphqlUrlForNetwork(network);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GRAPHQL_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query: EPOCH_QUERY }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`GraphQL ${url} answered ${response.status}`);
    }
    const body = await response.json();
    const epoch = parseEpoch(body?.data?.epoch?.epochId);
    if (epoch === null) {
      const reason = body?.errors?.[0]?.message;
      throw new Error(`GraphQL ${url} returned no epoch${reason ? `: ${reason}` : ''}`);
    }
    return epoch;
  } finally {
    clearTimeout(timer);
  }
}

async function readEpochViaJsonRpc(network: NetworkType): Promise<number> {
  const { epoch } = await withSuiRpcFailover(
    network,
    'sui-epoch.getLatestSuiSystemState',
    async (client) => client.getLatestSuiSystemState(),
  );
  const parsed = parseEpoch(epoch);
  if (parsed === null) {
    throw new Error(`JSON-RPC returned an unreadable epoch: ${String(epoch)}`);
  }
  return parsed;
}

/**
 * The current epoch on `network`. Throws when neither GraphQL nor JSON-RPC
 * answers; it never guesses. A wrong epoch builds a nonce whose proof the
 * chain rejects, either as already expired or as more than 30 epochs ahead.
 */
export async function readCurrentSuiEpoch(network: NetworkType): Promise<number> {
  let graphqlError: unknown;
  try {
    return await readEpochViaGraphql(network);
  } catch (error) {
    graphqlError = error;
    console.warn(`[sui-epoch] GraphQL read failed on ${network}, trying JSON-RPC: ${describeError(error)}`);
  }

  try {
    return await readEpochViaJsonRpc(network);
  } catch (rpcError) {
    console.error(
      `[sui-epoch] no source answered on ${network}. GraphQL: ${describeError(graphqlError)}. JSON-RPC: ${describeError(rpcError)}`,
    );
    throw new Error(
      `Could not reach the Sui ${network} network to start sign-in. Please try again in a few minutes.`,
    );
  }
}
