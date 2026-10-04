// escrow-coin.ts — which coin a round's calls are built with.
//
// A `CycleEscrow<T>` records its coin in the snapshot (`asset_type`), and
// every call on it — contribute, collect, redeem, advance, refund, release —
// takes that `T`. The round panel used to build all of them with the
// circle's current SUI/USDC mode instead, and the admin can switch that mode
// between laps, so a round that was opened in one coin got calls typed for
// the other. Now the escrow's own type decides, by exact match
// (src/lib/supported-coins.ts), and a type that could not be read is a
// refusal, never a guess. Only opening a NEW round uses the circle's mode.
//
// Paying in is a commitment, so it needs a supported coin. Getting money
// out of a round (collect, send the contributions back, advance after a
// collect, release before a re-open) is never blocked by the app's coin
// list: it is built with the escrow's own type whenever that type was read.

import type { NetworkType } from '@/config/public-env';
import {
  classifyCoinType,
  formatCoinAmount,
  resolveSupportedCoin,
  type CoinTypeResolution,
  type SupportedCoin,
} from '@/lib/supported-coins';

/**
 * The round's coin, from the escrow's own `asset_type`. The live state is
 * read after the summary and wins; the summary covers a state read that has
 * not come back. Null when there is no round.
 */
export function resolveEscrowCoin(
  escrow: { assetType?: string | null } | null,
  fallback: { assetType?: string | null } | null,
  network: NetworkType,
): CoinTypeResolution | null {
  if (!escrow && !fallback) return null;
  const assetType = escrow?.assetType?.trim() || fallback?.assetType?.trim() || '';
  return classifyCoinType(assetType, network);
}

/**
 * The coin a payment into this round is built with: only a supported coin.
 * An unsupported coin is never offered for payment, and an unreadable one is
 * never guessed.
 */
export function escrowPayCoin(coin: CoinTypeResolution | null): SupportedCoin | null {
  return coin?.kind === 'supported' ? coin.coin : null;
}

/**
 * The type argument for every call that gets money out of this round or
 * moves it along: collect (`finalize_and_redeem*`, `redeem_claim`),
 * `refund_expired_claim`, `advance_circle_after_claim` and
 * `release_open_round`. It must be the escrow's own type, so any coin type
 * that was read qualifies, supported or not; only an unreadable one is
 * refused, since no call can be built without it.
 */
export function escrowExitCoinType(coin: CoinTypeResolution | null): string | null {
  if (coin?.kind === 'supported') return coin.coin.coinType;
  if (coin?.kind === 'unsupported') return coin.coinType;
  return null;
}

/**
 * An amount of this round's coin for display: "0.3 USDC", the unsupported
 * label (never a scaled number), or "—" while the coin (or the amount) is
 * unknown.
 */
export function formatEscrowAmount(
  base: string | bigint,
  coin: CoinTypeResolution | null,
  unsupportedLabel: string,
): string {
  if (coin?.kind === 'supported') return formatCoinAmount(base, coin.coin) ?? '—';
  if (coin?.kind === 'unsupported') return unsupportedLabel;
  return '—';
}

export interface OpenRoundCoin {
  coin: SupportedCoin;
  /** Set for USDC: `open_cycle_stable*` derives the share at these decimals. */
  stableDecimals?: number;
}

/**
 * The coin a new round opens in: the circle's mode, which must resolve to a
 * supported coin on this network. Null otherwise, and the open is refused.
 */
export function resolveOpenRoundCoin(
  modeCoinType: string | null | undefined,
  network: NetworkType,
): OpenRoundCoin | null {
  const coin = resolveSupportedCoin(modeCoinType, network);
  if (!coin) return null;
  return coin.symbol === 'USDC' ? { coin, stableDecimals: coin.decimals } : { coin };
}
