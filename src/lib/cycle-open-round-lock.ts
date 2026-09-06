// cycle-open-round-lock.ts — the one in-flight flag behind every control
// that opens a round.
//
// Production 2026-08-30 (circle 0xa3fada…675ed, lap 2 round 1): the admin's
// panel fired two open transactions for the SAME round 34 seconds apart,
// both landed, and the members split their contributions across two
// escrows. The second click was offered because the panel's busy flag
// cleared the moment the first transaction resolved; the follow-up read
// was served before the node had indexed the new escrow, the panel
// computed "no round open", and its OTHER open control lit up.
//
// The fix is a lock that outlives the transaction. It is taken before
// signing and stays held after the tx resolves until DISCOVERY has shown a
// live escrow the panel did not know about before the click — or a
// bounded timeout hands the controls back, so a wedged read cannot lock
// the admin out for good. Every open control ("Open this round", "Open the
// next round", the activate→open auto-chain) consults this same lock. The
// on-chain guard (`E_ROUND_ALREADY_OPEN`) is the backstop once the package
// carrying it is published; this is the UI's own half and ships first.
//
// Pure state and predicates, no React, so the panel's behaviour is
// unit-testable.

export type OpenRoundLock =
  /** No open in flight; the controls may be offered. */
  | { kind: 'idle' }
  /** The transaction is being built, signed, or executed. */
  | { kind: 'submitting'; priorEscrowId: string | null }
  /**
   * The transaction resolved. Held until discovery reports a live escrow
   * other than `priorEscrowId`, or `OPEN_ROUND_CONFIRM_TIMEOUT_MS` elapses
   * from `resolvedAtMs`.
   */
  | { kind: 'confirming'; priorEscrowId: string | null; digest: string; resolvedAtMs: number };

/**
 * How long a resolved open may go unconfirmed before the controls come
 * back. Generous on purpose: the failover pool's endpoints index at
 * different speeds, and the cost of waiting is a disabled button, while
 * the cost of releasing early is the incident above.
 */
export const OPEN_ROUND_CONFIRM_TIMEOUT_MS = 90_000;
/** How often the panel re-reads the circle while confirming. */
export const OPEN_ROUND_CONFIRM_POLL_MS = 3_000;

/** What discovery currently reports as the circle's newest escrow. */
export interface ObservedRound {
  escrowId: string;
  finalized: boolean;
  claimed: boolean;
  refunded: boolean;
}

export const IDLE_OPEN_ROUND_LOCK: OpenRoundLock = { kind: 'idle' };

export function isOpenRoundLocked(lock: OpenRoundLock): boolean {
  return lock.kind !== 'idle';
}

/**
 * Take the lock before signing. `priorEscrowId` is whatever the panel
 * showed as the current round at that moment — the one escrow a successful
 * open must NOT resolve to.
 */
export function beginOpenRound(priorEscrowId: string | null): OpenRoundLock {
  return { kind: 'submitting', priorEscrowId };
}

/**
 * The transaction resolved: move to confirming. Only a submitting lock can
 * advance; anything else is returned unchanged.
 */
export function openRoundResolved(lock: OpenRoundLock, digest: string, nowMs: number): OpenRoundLock {
  if (lock.kind !== 'submitting') return lock;
  return { kind: 'confirming', priorEscrowId: lock.priorEscrowId, digest, resolvedAtMs: nowMs };
}

export type OpenRoundSettlement =
  /** Discovery showed a live escrow the panel had not seen: released. */
  | { outcome: 'confirmed'; lock: OpenRoundLock; escrowId: string }
  /** Nothing confirmed inside the window: released, with a warning due. */
  | { outcome: 'timed-out'; lock: OpenRoundLock }
  /** Keep waiting (or: nothing to settle for this lock state). */
  | { outcome: 'pending'; lock: OpenRoundLock };

function sameEscrow(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * A live round is one that can still collect: not finalized, not claimed,
 * not refunded. Required for confirmation so that, when the panel had no
 * prior escrow to compare against (first round, or a failed read before
 * the click), a settled leftover from an earlier round cannot pass as the
 * one just opened.
 */
function isLiveRound(observed: ObservedRound): boolean {
  return !observed.finalized && !observed.claimed && !observed.refunded;
}

/**
 * Feed a discovery observation into a confirming lock. Idle and submitting
 * locks are never settled by an observation — a read that lands mid-submit
 * says nothing about a transaction that has not resolved.
 */
export function settleOpenRoundLock(
  lock: OpenRoundLock,
  observed: ObservedRound | null,
  nowMs: number,
): OpenRoundSettlement {
  if (lock.kind !== 'confirming') return { outcome: 'pending', lock };
  if (observed && !sameEscrow(observed.escrowId, lock.priorEscrowId) && isLiveRound(observed)) {
    return { outcome: 'confirmed', lock: IDLE_OPEN_ROUND_LOCK, escrowId: observed.escrowId };
  }
  if (nowMs - lock.resolvedAtMs >= OPEN_ROUND_CONFIRM_TIMEOUT_MS) {
    return { outcome: 'timed-out', lock: IDLE_OPEN_ROUND_LOCK };
  }
  return { outcome: 'pending', lock };
}

export type OpenRoundRefusal =
  /** `E_ROUND_ALREADY_OPEN` (234): a live escrow already holds this round. */
  | 'round-already-open'
  /** `E_ROUND_STILL_OPEN` (235): the chained release named an escrow that can still pay out. */
  | 'round-still-open';

const OPEN_ROUND_ABORT_CODES: ReadonlyArray<[RegExp, OpenRoundRefusal]> = [
  [/,\s*234\s*\)/, 'round-already-open'],
  [/,\s*235\s*\)/, 'round-still-open'],
];

/**
 * Recognises the escrow module's duplicate-open refusals in a failed
 * transaction's message so the panel can say "this round is already open"
 * instead of echoing a MoveAbort dump. The code is only trusted when it
 * follows a `njangi_cycle_escrow` location — 234 in another module is not
 * ours. Null for anything else.
 */
export function classifyOpenRoundError(error: unknown): OpenRoundRefusal | null {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const at = message.indexOf('njangi_cycle_escrow');
  if (at < 0) return null;
  const tail = message.slice(at);
  for (const [pattern, refusal] of OPEN_ROUND_ABORT_CODES) {
    if (pattern.test(tail)) return refusal;
  }
  return null;
}
