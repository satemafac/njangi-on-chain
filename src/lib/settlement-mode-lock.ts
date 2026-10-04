// settlement-mode-lock.ts — when the admin may switch a circle between SUI
// and USDC mode (`toggle_auto_swap`).
//
// The contract allows the switch while the circle is inactive or paused
// between laps. It does not look at rounds: an escrow that is still open
// keeps running in the coin it was opened in, while every new action the
// app offers around it would follow the new mode. So the app adds one rule:
// no switch while a round is open, and no switch on a read that could not
// tell. Between laps, after the last payout, the switch stays available.

import type { SuiClient } from '@mysten/sui/client';
import type { NetworkType } from '@/config/public-env';
import { findCurrentCycleEscrow, readCycleEscrowState } from '@/lib/cycle-escrow-discovery';

/** Is a round of this circle still open? `unknown` when the reads could not say. */
export type RoundOpenRead = 'none' | 'open' | 'unknown';

/**
 * A round is open while its escrow has neither paid out (`claimed`) nor sent
 * every contribution back (`refunded`): finalized-but-uncollected and
 * expired-but-unrefunded rounds still hold members' money in their coin.
 */
export async function readRoundOpen(
  network: NetworkType,
  circleId: string,
  client: SuiClient,
): Promise<RoundOpenRead> {
  try {
    const escrow = await findCurrentCycleEscrow(network, circleId, { client });
    if (!escrow) return 'none';
    const state = await readCycleEscrowState(escrow.escrowId, network, client);
    if (!state) return 'unknown';
    return state.claimed || state.refunded ? 'none' : 'open';
  } catch (error) {
    console.warn('[settlement-mode-lock] could not check for an open round', { circleId, error });
    return 'unknown';
  }
}

export type SettlementModeLock =
  /** The circle is active and not paused: the contract refuses too. */
  | 'lap-running'
  | 'round-open'
  /** Not checked yet. */
  | 'round-checking'
  /** The check failed. */
  | 'round-unknown';

/** Why the mode cannot change now, or null when it can. `round` null = not checked yet. */
export function settlementModeLock(input: {
  isActive: boolean;
  paused: boolean;
  round: RoundOpenRead | null;
}): SettlementModeLock | null {
  if (input.isActive && !input.paused) return 'lap-running';
  if (input.round === null) return 'round-checking';
  if (input.round === 'open') return 'round-open';
  if (input.round === 'unknown') return 'round-unknown';
  return null;
}

export function settlementModeLockMessage(lock: SettlementModeLock): string {
  switch (lock) {
    case 'lap-running':
      return "The circle's coin can't change while a lap is running. Change it between laps, after the lap's last payout, or before the circle starts.";
    case 'round-open':
      return "A round is still open in the circle's current coin, so the coin can't change yet. Change it once that round has paid out or sent its contributions back.";
    case 'round-checking':
      return 'Checking whether a round is still open…';
    case 'round-unknown':
      return "We couldn't check whether a round is still open, so the coin can't change right now. Try again in a moment.";
  }
}
