// supported-coins.ts — which coin a type is, by exact type, and nothing else.
//
// The app supports two coins: SUI (9 decimals) and the network's USDC
// (6 decimals), both from src/config/coin-types.ts. Every place that turns
// base units into an amount, or an amount into base units, must know the coin
// by its exact type. Guessing used to be the rule: an unknown coin was 9
// decimals on the dashboard (so its send flow moved 10^3 times the typed
// amount of a 6-decimal coin) and "USDC, 6 decimals" in the goal pools, the
// swap service and the stablecoin labels, and any `::usdc::USDC` struct from
// any package was merged into the real USDC balance by name.
//
// Anything else is unsupported: shown as "unsupported coin", never scaled,
// never offered for a new payment.

import { normalizeStructTag } from '@mysten/sui/utils';
import type { NetworkType } from '@/config/public-env';
import { COIN_TYPE_PATTERN, SUI_COIN_TYPE, usdcCoinTypeForNetwork } from '@/config/coin-types';

export type SupportedCoinSymbol = 'SUI' | 'USDC';

export interface SupportedCoin {
  symbol: SupportedCoinSymbol;
  /** The type as the app configures it: the form every Move call is built with. */
  coinType: string;
  decimals: 9 | 6;
}

/** English label for surfaces without translations. */
export const UNSUPPORTED_COIN_LABEL = 'unsupported coin';

/**
 * Also accepts an address without `0x`: an escrow snapshot's `asset_type` is
 * `type_name::into_string`, which spells SUI as `0000…0002::sui::SUI`.
 */
const LOOSE_COIN_TYPE_PATTERN = /^(?:0x)?[0-9a-fA-F]{1,64}::[A-Za-z_][A-Za-z0-9_]*::[A-Za-z_][A-Za-z0-9_]*$/;

/** `0x` + 64 hex digits `::module::Name`, or null for anything that is not a coin type. */
export function normalizeCoinType(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!LOOSE_COIN_TYPE_PATTERN.test(trimmed)) return null;
  try {
    return normalizeStructTag(trimmed);
  } catch {
    return null;
  }
}

/**
 * SUI and the network's USDC. A malformed USDC setting leaves USDC out, so a
 * misconfigured deployment refuses USDC instead of signing with a bad type.
 */
export function supportedCoins(network: NetworkType): SupportedCoin[] {
  const coins: SupportedCoin[] = [{ symbol: 'SUI', coinType: SUI_COIN_TYPE, decimals: 9 }];
  const usdc = usdcCoinTypeForNetwork(network);
  if (COIN_TYPE_PATTERN.test(usdc)) coins.push({ symbol: 'USDC', coinType: usdc, decimals: 6 });
  return coins;
}

/** The supported coin `coinType` is, by exact type; null for every other value. */
export function resolveSupportedCoin(coinType: unknown, network: NetworkType): SupportedCoin | null {
  const wanted = normalizeCoinType(coinType);
  if (!wanted) return null;
  return supportedCoins(network).find((coin) => normalizeCoinType(coin.coinType) === wanted) ?? null;
}

export function supportedCoinBySymbol(symbol: SupportedCoinSymbol, network: NetworkType): SupportedCoin | null {
  return supportedCoins(network).find((coin) => coin.symbol === symbol) ?? null;
}

export type CoinTypeResolution =
  | { kind: 'supported'; coin: SupportedCoin }
  /** A real coin type, and not one this app supports. Normalized. */
  | { kind: 'unsupported'; coinType: string }
  /** Empty or not a coin type at all: the read that should have named it failed. */
  | { kind: 'unknown' };

/** Supported, unsupported, or unknown: the three answers a coin type read can give. */
export function classifyCoinType(coinType: unknown, network: NetworkType): CoinTypeResolution {
  const normalized = normalizeCoinType(coinType);
  if (!normalized) return { kind: 'unknown' };
  const coin = resolveSupportedCoin(normalized, network);
  return coin ? { kind: 'supported', coin } : { kind: 'unsupported', coinType: normalized };
}

/**
 * Base units as a decimal string, exactly (BigInt, no floating point):
 * `formatBaseUnits('300000', 6)` → "0.3". Trailing zeros are trimmed; with
 * `maxFractionDigits`, the fraction is cut (never rounded up) to that many
 * digits. Null when `base` is not a non-negative integer.
 */
export function formatBaseUnits(base: bigint | string, decimals: number, maxFractionDigits = decimals): string | null {
  if (typeof base === 'string' && !/^\d+$/.test(base.trim())) return null;
  const value = typeof base === 'bigint' ? base : BigInt(base.trim());
  if (value < 0n) return null;
  const divisor = 10n ** BigInt(decimals);
  const whole = value / divisor;
  const fraction = (value % divisor)
    .toString()
    .padStart(decimals, '0')
    .slice(0, Math.max(0, maxFractionDigits))
    .replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

/** "0.3 USDC" for 300000 base units of USDC; null when `base` is not an amount. */
export function formatCoinAmount(
  base: bigint | string,
  coin: Pick<SupportedCoin, 'symbol' | 'decimals'>,
  maxFractionDigits: number = coin.decimals,
): string | null {
  const amount = formatBaseUnits(base, coin.decimals, maxFractionDigits);
  return amount === null ? null : `${amount} ${coin.symbol}`;
}

/**
 * A typed amount in base units, exactly: `parseCoinAmount('0.29', 6)` is
 * 290000n, where `Math.floor(0.29 * 1e6)` is 289999. Null for anything that
 * is not a plain non-negative decimal, and for more fraction digits than the
 * coin has, rather than silently dropping them.
 */
export function parseCoinAmount(text: string, decimals: number): bigint | null {
  const trimmed = text.trim();
  const match = /^(\d*)(?:\.(\d*))?$/.exec(trimmed);
  if (!match) return null;
  const [, whole = '', fraction = ''] = match;
  if (whole === '' && fraction === '') return null;
  if (fraction.length > decimals) return null;
  return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt((fraction || '').padEnd(decimals, '0') || '0');
}
