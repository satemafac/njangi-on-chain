// cycle-round-progression.ts — What can an admin do once a round's payout
// has been claimed?
//
// The panel used to answer "nothing useful". A claimed escrow is still the
// newest `CycleEscrowOpened` event for its circle, so discovery kept
// resolving it, `claimed` stayed true, and the UI sat in its `completed`
// stage forever with only the recovery "advance" control — which aborts
// 221 E_ALREADY_ADVANCED on a healthy circle, because the claim already
// advanced the rotation. No circle could reach round 2 from the UI
// (observed on 0xa3fada…675ed, 2026-08-29).
//
// The fix needs a fact the escrow alone cannot supply: where the circle's
// rotation pointer now stands. Note that it is NOT the cycle number —
// `njangi_circles::advance_rotation_position_and_cycle` moves
// `current_position`, not `current_cycle`, so every round in one lap of the
// rotation shares a cycle number. The recipient pointer is the real
// discriminator, and it is exactly what `advance_circle_after_claim`
// asserts on (njangi_cycle_escrow.move:827-831).

/** Where a circle's rotation stands, read straight off the Circle object. */
export interface CircleRotationPointer {
  /** The rotation lap. Shared by every round within that lap. */
  currentCycle: number;
  /** Index into `rotation_order` of the member whose round is next. */
  currentPosition: number;
  /**
   * `rotation_order[current_position]`, mirroring
   * `njangi_circles::get_next_payout_recipient`. Null when the pointer is
   * past the end of the rotation or lands on the 0x0 placeholder — the
   * cases where that Move function returns `option::none()`.
   */
  nextRecipient: string | null;
  /**
   * True once the last member of the lap has collected. The contract
   * freezes the rotation there (leaving `current_position` on the member
   * who was just paid) until the admin calls `resume_cycle`.
   */
  pausedAfterCycle: boolean;
}

export type NextRoundAction =
  /** The rotation moved on; opening snapshots the next member. */
  | 'open-next-round'
  /** The claim landed without advancing; the recovery advance will work. */
  | 'advance-rotation'
  /** The lap is complete; only `resume_cycle` can move the circle on. */
  | 'resume-cycle'
  /** Not safe to offer any control — see `reason`. */
  | 'unknown';

export type NextRoundUnknownReason =
  /** The circle's rotation pointer could not be read (RPC failure). */
  | 'pointer-unavailable'
  /**
   * A recipient the comparison needs is missing — either the pointer names
   * none (past-the-end index, 0x0 placeholder) or the escrow's frozen
   * recipient did not parse. Without both sides there is no way to tell
   * "the circle moved on" from "it still points at the member who just
   * collected", and those call for opposite actions.
   */
  | 'no-recipient'
  /**
   * The circle still points at the member who just collected, but its cycle
   * number has moved off this escrow's. Opening would snapshot that member
   * a second time and `advance_circle_after_claim` aborts on the cycle
   * check, so there is no safe control to offer.
   */
  | 'stalled-off-cycle';

export interface NextRoundProgression {
  action: NextRoundAction;
  reason?: NextRoundUnknownReason;
}

function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Decides which control a settled round should offer, given where the
 * circle's rotation pointer now stands.
 *
 * The ordering matters, and the recipient check deliberately dominates the
 * cycle-number one: "the circle still points at the member who just
 * collected" is what makes opening a round unsafe (it would snapshot them
 * again and pay them twice), and that is true regardless of what the cycle
 * counter says.
 */
export function resolveNextRoundAction(params: {
  /** The settled escrow's frozen recipient. */
  escrowRecipient: string | null;
  /** The settled escrow's frozen cycle number. */
  escrowCycleNo: number;
  /** Null when the circle read failed — never treated as a fact. */
  pointer: CircleRotationPointer | null;
}): NextRoundProgression {
  const { escrowRecipient, escrowCycleNo, pointer } = params;

  // A failed read is not a fact. Offering a control here would be a guess
  // about on-chain state, and one of the two guesses double-pays someone.
  if (!pointer) return { action: 'unknown', reason: 'pointer-unavailable' };

  // Checked before the recipient comparison: a paused circle also still
  // points at the just-paid member, so the two states are otherwise
  // indistinguishable. Both `open_cycle` and `advance_circle_after_claim`
  // are wrong here — the latter asserts `!is_paused_after_cycle`.
  if (pointer.pausedAfterCycle) return { action: 'resume-cycle' };

  // Both sides are required: guessing here either strands the circle or
  // pays the last recipient twice.
  if (!pointer.nextRecipient || !escrowRecipient) {
    return { action: 'unknown', reason: 'no-recipient' };
  }

  if (sameAddress(pointer.nextRecipient, escrowRecipient)) {
    // The rotation never moved past this payout. That is precisely what
    // `advance_circle_after_claim` exists to repair — but only while the
    // circle also still sits on this escrow's cycle number.
    return pointer.currentCycle === escrowCycleNo
      ? { action: 'advance-rotation' }
      : { action: 'unknown', reason: 'stalled-off-cycle' };
  }

  // The pointer names a different member: this round is history and the
  // circle is ready for that member's round to be opened.
  return { action: 'open-next-round' };
}

const COMPLETED_ROUND_COPY_KEYS: Readonly<Record<NextRoundAction, string>> = {
  'open-next-round': 'escrow.completed.openNextRound',
  'resume-cycle': 'escrow.completed.resumeCycle',
  'advance-rotation': 'escrow.completed.advanceRotation',
  unknown: 'escrow.completed.unknown',
};

/**
 * The `escrow.completed.*` i18n key for the sentence a settled round shows.
 * One key per action, so the sentence and the control it sits above cannot
 * disagree.
 *
 * They did: a single `escrow.completed` string promised "the circle admin
 * can open the next round" whatever the action, and on a paused circle it
 * sat directly above the Resume Cycle instruction — which starts a new lap
 * and resets every member's security deposit, nothing like opening a round
 * (0xa3fada…675ed, paused_after_cycle = true, 2026-08-30). The `unknown`
 * variant deliberately suggests nothing: a failed read is not a fact.
 */
export function completedRoundCopyKey(action: NextRoundAction): string {
  return COMPLETED_ROUND_COPY_KEYS[action];
}
