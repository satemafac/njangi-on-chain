import { getPooledSuiClient } from '@/services/sui-rpc-failover';

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

const SUI_COIN_TYPE = '0x2::sui::SUI';
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
  if (network === 'mainnet') {
    return (
      process.env.NEXT_PUBLIC_MAINNET_RPC_URL ??
      'https://fullnode.mainnet.sui.io:443'
    );
  }
  return (
    process.env.NEXT_PUBLIC_TESTNET_RPC_URL ?? 'https://fullnode.testnet.sui.io:443'
  );
}

function resolveUsdcCoinType(
  network: WalletNetwork,
  override?: string,
): string {
  if (override && override.trim()) {
    return override.trim();
  }
  if (network === 'mainnet') {
    return (
      process.env.NEXT_PUBLIC_MAINNET_USDC ??
      '0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN'
    );
  }
  return (
    process.env.NEXT_PUBLIC_TESTNET_USDC ??
    '0x26b3bc67befc214058ca78ea9a2690298d731a2d4309485ec3d40198063c4abc::usdc::USDC'
  );
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
  const client = getPooledSuiClient({
    network,
    rpcUrl,
  });
  const balance = await client.getBalance({
    owner: walletAddress,
    coinType: input.coinType,
  });

  const value: WalletBalanceResult = {
    walletAddress,
    network,
    coinType: input.coinType,
    symbol: input.symbol,
    totalBalance: balance.totalBalance,
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
