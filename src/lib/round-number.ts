// round-number.ts — The circle-wide round number people see.
//
// On chain, a circle's `current_cycle` and every escrow snapshot's `cycle_no`
// count LAPS of the rotation, not payout rounds: a collect moves
// `current_position` and leaves the cycle alone, which only `resume_cycle`
// bumps (see cycle-round-progression.ts). Printing `cycle_no` as "round N"
// gave every round of a lap the same number. On production circle
// 0xa3fada…675ed, escrows #14–#16 all read "round 5", and the round shown as
// "Round 6 complete" was the circle's 16th payout.
//
// A round's number is its lap's offset plus the recipient's seat:
//
//   (cycle_no − 1) × seats + seat + 1
//
// `seats` is the escrow snapshot's member list: the rotation order with empty
// seats and repeats removed, in order (`filter_active_members` in
// njangi_cycle_escrow.move). `seat` is the recipient's index in it. The seat
// count holds for a running circle's whole life: members can only be removed
// before activation, and a reorder between laps keeps the same members. It
// also holds for a migrated circle, whose first lap is seeded with
// `prior_rounds_completed + 1` (full passes through everybody) and starts at
// the declared seat, so its first on-chain round continues the group's count.
//
// Every function returns null when an input is missing or unreadable. Callers
// show no number rather than a guess.

import { normalizeSuiAddress } from '@mysten/sui/utils';

const EMPTY_SEAT = normalizeSuiAddress('0x0');

/** A lap number as the chain reports it (u64 as number or string), or null. */
function readLap(cycleNo: unknown): number | null {
  const lap =
    typeof cycleNo === 'number'
      ? cycleNo
      : typeof cycleNo === 'string' && /^\d+$/.test(cycleNo.trim())
        ? Number(cycleNo.trim())
        : Number.NaN;
  return Number.isSafeInteger(lap) && lap >= 1 ? lap : null;
}

function seatAddress(value: unknown): string | null {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(value.trim())) return null;
  return normalizeSuiAddress(value.trim());
}

/**
 * The round number for the `seat`-th recipient (zero-based) of lap `lap`
 * (one-based) in a rotation of `seats` members.
 */
export function roundNumberAt(lap: number, seat: number, seats: number): number | null {
  if (!Number.isSafeInteger(lap) || lap < 1) return null;
  if (!Number.isSafeInteger(seats) || seats < 1) return null;
  if (!Number.isSafeInteger(seat) || seat < 0 || seat >= seats) return null;
  const round = (lap - 1) * seats + seat + 1;
  return Number.isSafeInteger(round) ? round : null;
}

/**
 * The round number of one escrow, from its own snapshot: `cycle_no`, the
 * recipient, and the member list. Null if any of them is missing, or the
 * recipient is not on the list.
 */
export function roundNumber(snapshot: {
  cycleNo: number | string | null | undefined;
  recipient: string | null | undefined;
  members: readonly string[] | null | undefined;
}): number | null {
  const lap = readLap(snapshot.cycleNo);
  const recipient = seatAddress(snapshot.recipient);
  if (lap === null || recipient === null || !Array.isArray(snapshot.members)) return null;

  const seats: string[] = [];
  for (const member of snapshot.members) {
    const address = seatAddress(member);
    if (address === null) return null;
    if (address !== EMPTY_SEAT && !seats.includes(address)) seats.push(address);
  }
  return roundNumberAt(lap, seats.indexOf(recipient), seats.length);
}

/**
 * The round a circle's rotation pointer stands on: `current_cycle` and
 * `current_position` read off the circle itself. While a lap is paused the
 * pointer stays on the member who just collected, so this is that round.
 * `rotationOrder` is the raw `rotation_order`, which an active circle fills
 * completely (activation refuses an empty seat).
 */
export function circleRoundNumber(circle: {
  currentCycle: number | string | null | undefined;
  currentPosition: number | null | undefined;
  rotationOrder: readonly string[] | null | undefined;
}): number | null {
  const { currentPosition, rotationOrder } = circle;
  if (!Array.isArray(rotationOrder) || typeof currentPosition !== 'number') return null;
  return roundNumber({
    cycleNo: circle.currentCycle,
    recipient: rotationOrder[currentPosition],
    members: rotationOrder,
  });
}
