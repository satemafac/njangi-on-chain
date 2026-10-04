// wallet-coins.ts — the member's wallet balances, one row per exact coin type.
//
// The dashboard used to merge `getAllBalances` rows by struct NAME, so any
// package's `::usdc::USDC` landed in the real USDC row (summed, under
// whichever type came first), and it scaled every unknown coin at 9
// decimals — the send flow then moved 10^3 times the typed amount of a
// 6-decimal coin. Rows are now keyed by exact type, only SUI and the
// network's USDC carry decimals, and only they can be sent from here.

import type { NetworkType } from '@/config/public-env';
import {
  normalizeCoinType,
  resolveSupportedCoin,
  type SupportedCoinSymbol,
} from '@/lib/supported-coins';

export interface WalletCoin {
  /** The configured type for a supported coin; the type the RPC reported otherwise. */
  coinType: string;
  /** "SUI" or "USDC" for a supported coin; the struct name of any other. */
  symbol: string;
  /** Base units. */
  balance: string;
  /** Null for an unsupported coin, which is never scaled. */
  decimals: number | null;
  supported: boolean;
}

function structName(coinType: string): string {
  return coinType.split('::').pop() || coinType;
}

const ORDER: Record<SupportedCoinSymbol, number> = { SUI: 0, USDC: 1 };

/**
 * One row per exact coin type: SUI first, then USDC, then every other coin
 * (unsupported) by name. A balance that is not a base-unit integer reads 0.
 */
export function buildWalletCoins(
  balances: ReadonlyArray<{ coinType: string; totalBalance?: string | null }>,
  network: NetworkType,
): WalletCoin[] {
  const byType = new Map<string, WalletCoin>();
  for (const entry of balances) {
    const balance = typeof entry.totalBalance === 'string' && /^\d+$/.test(entry.totalBalance)
      ? entry.totalBalance
      : '0';
    const key = normalizeCoinType(entry.coinType) ?? entry.coinType;
    const existing = byType.get(key);
    if (existing) {
      existing.balance = (BigInt(existing.balance) + BigInt(balance)).toString();
      continue;
    }
    const coin = resolveSupportedCoin(entry.coinType, network);
    byType.set(
      key,
      coin
        ? { coinType: coin.coinType, symbol: coin.symbol, balance, decimals: coin.decimals, supported: true }
        : { coinType: entry.coinType, symbol: structName(entry.coinType), balance, decimals: null, supported: false },
    );
  }
  return Array.from(byType.values()).sort((a, b) => {
    if (a.supported !== b.supported) return a.supported ? -1 : 1;
    if (a.supported && b.supported) {
      return ORDER[a.symbol as SupportedCoinSymbol] - ORDER[b.symbol as SupportedCoinSymbol];
    }
    return a.symbol.localeCompare(b.symbol);
  });
}

/** The row of a supported coin; never an unsupported coin that shares its name. */
export function findSupportedWalletCoin(
  coins: ReadonlyArray<WalletCoin>,
  symbol: SupportedCoinSymbol,
): WalletCoin | undefined {
  return coins.find((coin) => coin.supported && coin.symbol === symbol);
}

/**
 * The balance in whole units for display and fiat conversion, or null for a
 * coin whose decimals are not known.
 */
export function walletCoinAmount(coin: WalletCoin | undefined): number | null {
  if (!coin || coin.decimals === null) return null;
  return Number(BigInt(coin.balance)) / 10 ** coin.decimals;
}
