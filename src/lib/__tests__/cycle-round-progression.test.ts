/**
 * Regression: a circle could not advance past round 1 from the UI.
 *
 * Once a payout was claimed, discovery kept resolving that same settled
 * escrow (it stays the newest `CycleEscrowOpened` event for the circle), so
 * the panel sat in its `completed` stage forever. That stage offered only
 * the recovery "advance" control — which aborts 221 E_ALREADY_ADVANCED on a
 * healthy circle, because the claim already advanced the rotation. There
 * was no path to open round 2.
 *
 * Reproduced on production 2026-08-29 with circle 0xa3fada…675ed: escrow
 * 0xaf00b3…1849 claimed at cycle_no 1, circle at current_cycle 1,
 * current_position 1 — so the cycle number was UNCHANGED and only the
 * recipient pointer had moved. The failing advance was
 * CT9ZVcEyhDsTFCPxCt4t6AmfUiaSot8ZMFm61ueRAASf.
 *
 * That is the trap these tests pin down: `current_cycle` counts laps of the
 * rotation, not rounds (`advance_rotation_position_and_cycle` moves
 * `current_position`), so every round in a lap shares a cycle number and
 * only the recipient pointer distinguishes them.
 */
import {
  resolveNextRoundAction,
  type CircleRotationPointer,
} from '@/lib/cycle-round-progression';

// The three members of the reproduced circle, in rotation order.
const PAID = '0xe833deaa9c038ac2edd397323ed5dbde1e622aadfd0d526332a214a31f9de17d';
const NEXT = '0xdf98684462fb5b3e85dffcc34fda108b7c34e7da37ab88f0ae3a530ef804a97d';
const LAST = '0x1f8d4bdfa384503b0901c73c9925c5b29dad510766542a30dc3b6904ddba897b';

const pointer = (over: Partial<CircleRotationPointer> = {}): CircleRotationPointer => ({
  currentCycle: 1,
  currentPosition: 1,
  nextRecipient: NEXT,
  pausedAfterCycle: false,
  ...over,
});

/** The settled round-1 escrow, as read back from chain. */
const settledRound1 = { escrowRecipient: PAID, escrowCycleNo: 1 };

describe('resolveNextRoundAction', () => {
  // THE BUG. Exact production state of 0xa3fada…675ed.
  it('offers the next round once the claim has rotated the circle', () => {
    expect(resolveNextRoundAction({ ...settledRound1, pointer: pointer() })).toEqual({
      action: 'open-next-round',
    });
  });

  // ...and must NOT offer the recovery advance there, which is the call
  // that aborted 221 and left the circle stuck.
  it('does not fall back to the recovery advance on a healthy circle', () => {
    const { action } = resolveNextRoundAction({ ...settledRound1, pointer: pointer() });

    expect(action).not.toBe('advance-rotation');
  });

  it('offers the recovery advance when the rotation genuinely stalled', () => {
    // Claim landed without the chained advance: the circle still points at
    // the member who just collected, on the same cycle.
    expect(
      resolveNextRoundAction({
        ...settledRound1,
        pointer: pointer({ currentPosition: 0, nextRecipient: PAID }),
      }),
    ).toEqual({ action: 'advance-rotation' });
  });

  // The double-payment guard. A paused circle also still points at the
  // just-paid member (the contract freezes `current_position` there), so
  // opening would snapshot them a second time.
  it('sends the admin to resume_cycle when the lap is complete', () => {
    expect(
      resolveNextRoundAction({
        escrowRecipient: LAST,
        escrowCycleNo: 1,
        pointer: pointer({ currentPosition: 2, nextRecipient: LAST, pausedAfterCycle: true }),
      }),
    ).toEqual({ action: 'resume-cycle' });
  });

  it('never offers to open a round while the circle points at the paid member', () => {
    const stalled = resolveNextRoundAction({
      ...settledRound1,
      pointer: pointer({ currentPosition: 0, nextRecipient: PAID }),
    });
    const paused = resolveNextRoundAction({
      escrowRecipient: LAST,
      escrowCycleNo: 1,
      pointer: pointer({ currentPosition: 2, nextRecipient: LAST, pausedAfterCycle: true }),
    });
    const offCycle = resolveNextRoundAction({
      ...settledRound1,
      pointer: pointer({ currentCycle: 2, currentPosition: 0, nextRecipient: PAID }),
    });

    for (const { action } of [stalled, paused, offCycle]) {
      expect(action).not.toBe('open-next-round');
    }
  });

  // A failed read is not a fact: one of the two guesses double-pays.
  it('offers nothing when the rotation pointer could not be read', () => {
    expect(resolveNextRoundAction({ ...settledRound1, pointer: null })).toEqual({
      action: 'unknown',
      reason: 'pointer-unavailable',
    });
  });

  it('offers nothing when the pointer names no valid recipient', () => {
    expect(
      resolveNextRoundAction({ ...settledRound1, pointer: pointer({ nextRecipient: null }) }),
    ).toEqual({ action: 'unknown', reason: 'no-recipient' });
  });

  // The comparison needs both sides. An unparsed escrow recipient must not
  // fall through to "open" — that is the branch that double-pays.
  it('offers nothing when the escrow recipient did not parse', () => {
    expect(
      resolveNextRoundAction({ escrowRecipient: '', escrowCycleNo: 1, pointer: pointer() }),
    ).toEqual({ action: 'unknown', reason: 'no-recipient' });
  });

  // `update_cycle` can bump current_cycle without moving the position, which
  // leaves both on-chain calls unusable: advance aborts on its cycle check
  // and open would double-pay.
  it('offers nothing when a stalled circle has drifted off this cycle', () => {
    expect(
      resolveNextRoundAction({
        ...settledRound1,
        pointer: pointer({ currentCycle: 2, currentPosition: 0, nextRecipient: PAID }),
      }),
    ).toEqual({ action: 'unknown', reason: 'stalled-off-cycle' });
  });

  it('compares recipients case-insensitively', () => {
    // RPC casing must not decide whether a member gets paid twice.
    expect(
      resolveNextRoundAction({
        escrowRecipient: PAID.toUpperCase().replace('0X', '0x'),
        escrowCycleNo: 1,
        pointer: pointer({ currentPosition: 0, nextRecipient: PAID }),
      }),
    ).toEqual({ action: 'advance-rotation' });
  });
});
