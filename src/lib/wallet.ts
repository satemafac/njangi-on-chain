import { getGraphqlUrlForNetwork } from '@/services/network-config';
import { getPooledSuiClient } from '@/services/sui-rpc-failover';
import { SUI_COIN_TYPE, usdcCoinTypeForNetwork } from '@/config/coin-types';

export type WalletNetwork = 'testnet' | 'mainnet';

export interface WalletBalanceResult {
  walletAddress: string;
  network: WalletNetwork;
  coinType: string;
  symbol: 'SUI' | 'USDC';
  totalBalance: string;
  updatedAt: string;
  source: 'chain' | 'cache';
}

export interface WalletBalancesSnapshot {
  walletAddress: string;
  network: WalletNetwork;
  sui: WalletBalanceResult;
  usdc: WalletBalanceResult;
  updatedAt: string;
  source: 'chain' | 'cache';
}

interface RefreshBalanceOptions {
  forceRefresh?: boolean;
  network?: WalletNetwork;
  rpcUrl?: string;
  usdcCoinType?: string;
}

interface CachedBalanceEntry {
  expiresAt: number;
  value: WalletBalanceResult;
}

const BALANCE_CACHE_TTL_MS = 30_000;
const balanceCache = new Map<string, CachedBalanceEntry>();

// Sui GraphQL first, JSON-RPC as the fallback, as src/lib/sui-epoch.ts reads
// the epoch: every configured JSON-RPC endpoint can refuse at once (NJA-2830)
// while GraphQL still answers. A read that fails is not a fact: an unreadable
// answer from either source throws, so it is never cached or read as '0'.
const BALANCE_QUERY =
  'query WalletBalance($owner: SuiAddress!, $coinType: String!) { address(address: $owner) { balance(coinType: $coinType) { totalBalance } } }';
const GRAPHQL_TIMEOUT_MS = 8_000;
/** Base units as a decimal integer string: the rule wallet-balances.ts parseNode applies. */
const DECIMAL_BALANCE = /^\d+$/;

function resolveNetwork(input?: WalletNetwork): WalletNetwork {
  if (input === 'mainnet' || input === 'testnet') {
    return input;
  }
  return process.env.NEXT_PUBLIC_SUI_NETWORK === 'mainnet'
    ? 'mainnet'
    : 'testnet';
}

function resolveRpcUrl(network: WalletNetwork, override?: string): string {
  if (override && override.trim()) {
    return override.trim();
  }
  // `||` after trim, not `??`: a blank env value is unset, not an empty URL.
  if (network === 'mainnet') {
    return (
      process.env.NEXT_PUBLIC_MAINNET_RPC_URL?.trim() ||
      'https://sui-rpc.publicnode.com'
    );
  }
  return (
    process.env.NEXT_PUBLIC_TESTNET_RPC_URL?.trim() || 'https://sui-testnet-rpc.publicnode.com'
  );
}

function resolveUsdcCoinType(
  network: WalletNetwork,
  override?: string,
): string {
  if (override && override.trim()) {
    return override.trim();
  }
  // The shared resolver, not a local `env ?? default`: `??` kept an empty
  // NEXT_PUBLIC_<NET>_USDC as "", so this read a balance of type "" while
  // every other surface used the default.
  return usdcCoinTypeForNetwork(network);
}

function assertWalletAddress(walletAddress: string): void {
  const normalized = walletAddress.trim();
  if (!/^0x[a-fA-F0-9]{1,64}$/.test(normalized)) {
    throw new Error('Invalid Sui wallet address format.');
  }
}

function getCacheKey(
  walletAddress: string,
  network: WalletNetwork,
  symbol: 'SUI' | 'USDC',
): string {
  return `${network}:${walletAddress.toLowerCase()}:${symbol}`;
}

function readCachedBalance(
  key: string,
): WalletBalanceResult | null {
  const cached = balanceCache.get(key);
  if (!cached) {
    return null;
  }
  if (cached.expiresAt <= Date.now()) {
    balanceCache.delete(key);
    return null;
  }
  return { ...cached.value, source: 'cache' };
}

function writeCachedBalance(key: string, value: WalletBalanceResult): void {
  balanceCache.set(key, {
    expiresAt: Date.now() + BALANCE_CACHE_TTL_MS,
    value,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * `owner`'s balance of `coinType` from Sui GraphQL, or a throw. A non-2xx
 * status, a body that does not parse, an `errors` body, a missing address or
 * balance and a total that is not a decimal string all throw; none reads as '0'.
 */
async function readCoinBalanceViaGraphql(
  network: WalletNetwork,
  owner: string,
  coinType: string,
): Promise<string> {
  const url = getGraphqlUrlForNetwork(network);
  if (!url || !url.trim()) {
    throw new Error(`No Sui GraphQL URL is configured for ${network}`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GRAPHQL_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query: BALANCE_QUERY, variables: { owner, coinType } }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`GraphQL ${url} answered ${response.status}`);
    }
    const body: unknown = await response.json();
    if (!isRecord(body)) {
      throw new Error(`GraphQL ${url} answered with a body that is not an object`);
    }
    const errors = body.errors;
    if (errors !== undefined && errors !== null && !(Array.isArray(errors) && errors.length === 0)) {
      const first: unknown = Array.isArray(errors) ? errors[0] : undefined;
      const message = isRecord(first) ? first.message : undefined;
      throw new Error(`GraphQL ${url} returned errors${typeof message === 'string' ? `: ${message}` : ''}`);
    }
    const data = body.data;
    const address = isRecord(data) ? data.address : undefined;
    if (!isRecord(address)) {
      throw new Error(`GraphQL ${url} returned no address for ${owner}`);
    }
    const balance = address.balance;
    if (!isRecord(balance)) {
      throw new Error(`GraphQL ${url} returned no ${coinType} balance for ${owner}`);
    }
    const totalBalance = balance.totalBalance;
    if (typeof totalBalance !== 'string' || !DECIMAL_BALANCE.test(totalBalance)) {
      throw new Error(`GraphQL ${url} returned an unreadable ${coinType} balance: ${String(totalBalance)}`);
    }
    return totalBalance;
  } finally {
    clearTimeout(timer);
  }
}

/** The same balance from the pooled JSON-RPC client, held to the same rule. */
async function readCoinBalanceViaJsonRpc(
  network: WalletNetwork,
  rpcUrl: string,
  owner: string,
  coinType: string,
): Promise<string> {
  const client = getPooledSuiClient({
    network,
    rpcUrl,
  });
  const balance: unknown = await client.getBalance({
    owner,
    coinType,
  });
  const totalBalance = isRecord(balance) ? balance.totalBalance : undefined;
  if (typeof totalBalance !== 'string' || !DECIMAL_BALANCE.test(totalBalance)) {
    throw new Error(`JSON-RPC returned an unreadable ${coinType} balance: ${String(totalBalance)}`);
  }
  return totalBalance;
}

/**
 * `owner`'s balance of `coinType` on `network`: GraphQL first, then JSON-RPC.
 * Throws, naming both failures, when neither gives a readable balance; it
 * never guesses.
 */
async function readCoinBalance(
  network: WalletNetwork,
  rpcUrl: string,
  owner: string,
  coinType: string,
): Promise<string> {
  let graphqlError: unknown;
  try {
    return await readCoinBalanceViaGraphql(network, owner, coinType);
  } catch (error) {
    graphqlError = error;
    console.warn(
      `[wallet] GraphQL read of the ${coinType} balance failed on ${network}, trying JSON-RPC: ${describeError(error)}`,
    );
  }

  try {
    return await readCoinBalanceViaJsonRpc(network, rpcUrl, owner, coinType);
  } catch (rpcError) {
    throw new Error(
      `Could not read the ${coinType} balance of ${owner} on ${network}. GraphQL: ${describeError(graphqlError)}. JSON-RPC: ${describeError(rpcError)}`,
    );
  }
}

async function refreshCoinBalance(input: {
  walletAddress: string;
  symbol: 'SUI' | 'USDC';
  coinType: string;
  options?: RefreshBalanceOptions;
}): Promise<WalletBalanceResult> {
  const walletAddress = input.walletAddress.trim();
  assertWalletAddress(walletAddress);

  const network = resolveNetwork(input.options?.network);
  const cacheKey = getCacheKey(walletAddress, network, input.symbol);

  if (!input.options?.forceRefresh) {
    const cached = readCachedBalance(cacheKey);
    if (cached) {
      return cached;
    }
  }

  const rpcUrl = resolveRpcUrl(network, input.options?.rpcUrl);
  // GraphQL first, then JSON-RPC. Throws when neither gives a readable balance,
  // so a failed read is never cached and never becomes '0'.
  const totalBalance = await readCoinBalance(network, rpcUrl, walletAddress, input.coinType);

  const value: WalletBalanceResult = {
    walletAddress,
    network,
    coinType: input.coinType,
    symbol: input.symbol,
    totalBalance,
    updatedAt: new Date().toISOString(),
    source: 'chain',
  };

  writeCachedBalance(cacheKey, value);
  return value;
}

export async function refreshSuiBalance(
  walletAddress: string,
  options?: RefreshBalanceOptions,
): Promise<WalletBalanceResult> {
  return refreshCoinBalance({
    walletAddress,
    symbol: 'SUI',
    coinType: SUI_COIN_TYPE,
    options,
  });
}

export async function refreshUsdcBalance(
  walletAddress: string,
  options?: RefreshBalanceOptions,
): Promise<WalletBalanceResult> {
  const network = resolveNetwork(options?.network);
  const usdcCoinType = resolveUsdcCoinType(network, options?.usdcCoinType);

  return refreshCoinBalance({
    walletAddress,
    symbol: 'USDC',
    coinType: usdcCoinType,
    options: {
      ...options,
      network,
    },
  });
}

export async function refreshWalletBalances(
  walletAddress: string,
  options?: RefreshBalanceOptions,
): Promise<WalletBalancesSnapshot> {
  const [sui, usdc] = await Promise.all([
    refreshSuiBalance(walletAddress, options),
    refreshUsdcBalance(walletAddress, options),
  ]);

  const source =
    sui.source === 'cache' && usdc.source === 'cache' ? 'cache' : 'chain';

  return {
    walletAddress: walletAddress.trim(),
    network: sui.network,
    sui,
    usdc,
    updatedAt: new Date().toISOString(),
    source,
  };
}

export function clearWalletBalanceCache(walletAddress?: string): void {
  if (!walletAddress) {
    balanceCache.clear();
    return;
  }

  const normalized = walletAddress.trim().toLowerCase();
  for (const key of balanceCache.keys()) {
    if (key.includes(`:${normalized}:`)) {
      balanceCache.delete(key);
    }
  }
}
