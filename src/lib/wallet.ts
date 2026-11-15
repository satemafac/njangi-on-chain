import { getPooledSuiClient } from '@/services/sui-rpc-failover';
import { getGraphqlUrlForNetwork } from '@/services/network-config';
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

const GRAPHQL_TIMEOUT_MS = 8_000;
const BALANCE_QUERY =
  'query($owner: SuiAddress!, $type: String!) { address(address: $owner) { balance(coinType: $type) { totalBalance } } }';

// A balance is a decimal string of base units. Anything else (undefined,
// null, a number, '', a negative value) is not a reading.
function parseTotalBalance(raw: unknown): string | null {
  return typeof raw === 'string' && /^\d+$/.test(raw) ? raw : null;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Sui GraphQL first (NJA-2839): JSON-RPC is refused by every configured
// provider. A null `address` or a GraphQL error is a failed read, never 0;
// only the literal string '0' is an empty wallet.
async function readBalanceViaGraphql(
  network: WalletNetwork,
  owner: string,
  coinType: string,
): Promise<string> {
  const url = getGraphqlUrlForNetwork(network);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GRAPHQL_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query: BALANCE_QUERY, variables: { owner, type: coinType } }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`GraphQL ${url} answered ${response.status}`);
    }
    const body = await response.json();
    const totalBalance = parseTotalBalance(body?.data?.address?.balance?.totalBalance);
    if (totalBalance === null) {
      const reason = body?.errors?.[0]?.message;
      throw new Error(`GraphQL ${url} returned no readable balance${reason ? `: ${reason}` : ''}`);
    }
    return totalBalance;
  } finally {
    clearTimeout(timer);
  }
}

async function readBalanceViaJsonRpc(
  network: WalletNetwork,
  rpcUrl: string,
  owner: string,
  coinType: string,
): Promise<string> {
  const client = getPooledSuiClient({
    network,
    rpcUrl,
  });
  const balance = await client.getBalance({ owner, coinType });
  const totalBalance = parseTotalBalance(balance?.totalBalance);
  if (totalBalance === null) {
    throw new Error(`JSON-RPC returned an unreadable balance: ${String(balance?.totalBalance)}`);
  }
  return totalBalance;
}

/**
 * The balance of `coinType` held by `owner`, as a decimal string of base
 * units. GraphQL first, JSON-RPC as the fallback. Throws when neither gives a
 * readable value; a failed read never becomes a zero balance.
 */
async function readTotalBalance(input: {
  network: WalletNetwork;
  rpcUrl: string;
  owner: string;
  coinType: string;
  symbol: 'SUI' | 'USDC';
}): Promise<string> {
  let graphqlError: unknown;
  try {
    return await readBalanceViaGraphql(input.network, input.owner, input.coinType);
  } catch (error) {
    graphqlError = error;
    console.warn(
      `[wallet] GraphQL ${input.symbol} balance read failed on ${input.network}, trying JSON-RPC: ${describeError(error)}`,
    );
  }

  try {
    return await readBalanceViaJsonRpc(input.network, input.rpcUrl, input.owner, input.coinType);
  } catch (rpcError) {
    console.error(
      `[wallet] no source answered the ${input.symbol} balance on ${input.network}. GraphQL: ${describeError(graphqlError)}. JSON-RPC: ${describeError(rpcError)}`,
    );
    throw new Error(
      `Could not read the ${input.symbol} balance (${input.coinType}) on the Sui ${input.network} network: neither GraphQL nor JSON-RPC returned a readable balance.`,
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
  const totalBalance = await readTotalBalance({
    network,
    rpcUrl,
    owner: walletAddress,
    coinType: input.coinType,
    symbol: input.symbol,
  });

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
