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
import { findCurrentCycleEscrow, readCircleEscrowHistory } from '@/lib/cycle-escrow-discovery';
import { readBalanceField } from '@/lib/custody-wallet-balance';

/** Is a round of this circle still open? `unknown` when the reads could not say. */
export type RoundOpenRead = 'none' | 'open' | 'unknown';


function u64Field(value: unknown): bigint | null {
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  return null;
}

async function readMoveFields(client: Pick<SuiClient, 'getObject'>, objectId: string): Promise<Record<string, unknown> | null> {
  const response = await client.getObject({ id: objectId, options: { showContent: true } });
  const content = response.data?.content;
  return content && content.dataType === 'moveObject' ? (content.fields as Record<string, unknown>) : null;
}

/**
 * Has the circle ever started? `activate_circle` sets `current_cycle` to 1
 * (or, for a migrated circle, past it) and nothing resets it, so a circle
 * that is not active with `current_cycle` 0 has never started. `unknown`
 * when the circle could not be read.
 */
export async function readCircleStarted(
  client: Pick<SuiClient, 'getObject'>,
  circleId: string,
): Promise<'never-started' | 'started' | 'unknown'> {
  const fields = await readMoveFields(client, circleId);
  const cycle = u64Field(fields?.current_cycle);
  const active = fields?.is_active;
  if (cycle === null || typeof active !== 'boolean') return 'unknown';
  return !active && cycle === 0n ? 'never-started' : 'started';
}

/**
 * Whether one escrow is an open round: it has neither paid out (`claimed`)
 * nor sent every contribution back (`refunded`), and it holds or may still
 * hold members' money. An escrow that was never finalized and that nobody
 * has paid into holds none, and never will be claimed or refunded (there is
 * nothing to send back), so it does not count. Every field must read; a
 * malformed one is `unknown`, never an empty round.
 */
async function readEscrowRoundOpen(client: Pick<SuiClient, 'getObject'>, escrowId: string): Promise<RoundOpenRead> {
  const fields = await readMoveFields(client, escrowId);
  const { claimed, refunded, finalized } = fields ?? {};
  const contributors = u64Field(fields?.contributors_count);
  const balance = fields ? readBalanceField(fields.balance) : null;
  if (
    typeof claimed !== 'boolean' ||
    typeof refunded !== 'boolean' ||
    typeof finalized !== 'boolean' ||
    contributors === null ||
    balance === null
  ) {
    return 'unknown';
  }
  if (claimed || refunded) return 'none';
  if (!finalized && contributors === 0n && balance === 0n) return 'none';
  return 'open';
}

/**
 * Is the circle's current round open? Finalized-but-uncollected and
 * expired-but-unrefunded rounds still hold members' money in their coin;
 * a round nobody has paid into does not.
 *
 * A circle without an escrow history that has never started has no round to
 * find, so the lookup stops there instead of falling back to discovery's
 * event scan, which is slow, rate-limited, and served by one endpoint. A
 * started circle without the history (rounds that predate it) still gets
 * the scan.
 */
export async function readRoundOpen(
  network: NetworkType,
  circleId: string,
  client: SuiClient,
): Promise<RoundOpenRead> {
  try {
    const history = await readCircleEscrowHistory(client, circleId);
    if (history.kind === 'unknown') return 'unknown';
    if (history.kind === 'absent') {
      const started = await readCircleStarted(client, circleId);
      if (started === 'unknown') return 'unknown';
      if (started === 'never-started') return 'none';
    }
    const escrow = await findCurrentCycleEscrow(network, circleId, { client });
    if (!escrow) return 'none';
    return await readEscrowRoundOpen(client, escrow.escrowId);
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
