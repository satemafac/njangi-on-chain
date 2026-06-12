// circle-settlement.ts — Resolves the per-cycle escrow settlement coin for a
// circle. A circle either auto-swaps contributions into SUI (SUI-settled) or
// keeps them as a USD-pegged stablecoin (USDC-settled). The per-cycle escrow
// (`CycleEscrow<T>`) is single-coin-typed, so the open/contribute/collect
// flow must use the circle's settlement coin — otherwise a "USDC mode" circle
// would silently run its pot in SUI.

import { getCoinType } from '@/config/constants';

export interface SettlementCoin {
  /** Canonical Move type, e.g. `0x2::sui::SUI` or the network USDC type. */
  coinType: string;
  /** Display symbol for the UI. */
  coinSymbol: 'SUI' | 'USDC';
  /** Token decimals — 9 for SUI, 6 for USDC. */
  coinDecimals: number;
}

const SUI_COIN_TYPE = '0x2::sui::SUI';

/**
 * Resolves the settlement coin from a circle's auto-swap flag.
 *
 * - `autoSwapEnabled === true`  → SUI mode: contributions are swapped to SUI,
 *   so the escrow settles in SUI.
 * - `autoSwapEnabled === false` (or undefined) → USDC mode: the escrow settles
 *   in the network's USDC.
 *
 * USDC is network-aware via `getCoinType`, so this returns the correct type
 * for whichever network is active.
 */
export function resolveCircleSettlementCoin(
  autoSwapEnabled: boolean | undefined | null,
): SettlementCoin {
  if (autoSwapEnabled) {
    return { coinType: SUI_COIN_TYPE, coinSymbol: 'SUI', coinDecimals: 9 };
  }
  return { coinType: getCoinType('USDC'), coinSymbol: 'USDC', coinDecimals: 6 };
}
