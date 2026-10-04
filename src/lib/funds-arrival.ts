// funds-arrival.ts — the Add funds watcher: did SUI or USDC land?
//
// The watcher polled one number, "USDC in whole units" (base units / 1e6),
// so SUI — which the guide sends Bitget users to withdraw instead — was
// never noticed, and a SUI balance read through it would have been off by
// 10^3. It now compares both supported coins in base units and reports the
// arrival in the coin's own decimals.

import { formatCoinAmount, type SupportedCoinSymbol } from '@/lib/supported-coins';

/** Base units of each supported coin in the wallet. */
export type FundingBalances = Record<SupportedCoinSymbol, bigint>;

export interface FundsArrival {
  symbol: SupportedCoinSymbol;
  /** Base units received since the baseline. */
  received: bigint;
  /** e.g. "25 USDC" or "1.5 SUI". */
  label: string;
}

const DECIMALS: Record<SupportedCoinSymbol, number> = { USDC: 6, SUI: 9 };

/**
 * The first coin whose balance rose since `baseline` (USDC is checked first:
 * it is the funding path), or null when neither did. A fall — gas spent on
 * something else meanwhile — is not an arrival.
 */
export function detectFundsArrival(baseline: FundingBalances, current: FundingBalances): FundsArrival | null {
  for (const symbol of ['USDC', 'SUI'] as const) {
    const received = current[symbol] - baseline[symbol];
    if (received > 0n) {
      const label = formatCoinAmount(received, { symbol, decimals: DECIMALS[symbol] }) ?? `${received} ${symbol}`;
      return { symbol, received, label };
    }
  }
  return null;
}
