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
  completedRoundCopyKey,
  resolveNextRoundAction,
  type CircleRotationPointer,
  type NextRoundAction,
} from '@/lib/cycle-round-progression';
import { DICTIONARIES, type Locale } from '@/lib/i18n';

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

/**
 * The sentence shown above those controls.
 *
 * Found on production 2026-08-30 (same circle, paused_after_cycle = true):
 * the panel correctly pointed the admin at Resume Cycle — beneath a sentence
 * saying the admin "can open the next round whenever everyone is ready". One
 * `escrow.completed` string served every action. Each action now names its
 * own key, so the sentence and the control cannot disagree again.
 */
describe('completedRoundCopyKey', () => {
  // Typed as a Record so adding an action without copy fails to compile.
  const expected: Record<NextRoundAction, string> = {
    'open-next-round': 'escrow.completed.openNextRound',
    'resume-cycle': 'escrow.completed.resumeCycle',
    'advance-rotation': 'escrow.completed.advanceRotation',
    unknown: 'escrow.completed.unknown',
  };
  const actions = Object.keys(expected) as NextRoundAction[];
  const locales = Object.keys(DICTIONARIES) as Locale[];

  it.each(actions)('chooses a dedicated key for %s', (action) => {
    expect(completedRoundCopyKey(action)).toBe(expected[action]);
  });

  it('never lets two actions share a sentence', () => {
    expect(new Set(actions.map(completedRoundCopyKey)).size).toBe(actions.length);
  });

  // t() falls back to EN for a key a locale lacks, and to the raw key when
  // EN lacks it too — a typo here would print "escrow.completed.resumeCycle"
  // on screen. Every locale carried the old string, so every locale carries
  // all four variants, with the placeholders the panel interpolates.
  it.each(locales)('defines every variant in %s with {cycle} and {recipient}', (locale) => {
    for (const action of actions) {
      const value = DICTIONARIES[locale][completedRoundCopyKey(action)];
      expect(value).toBeDefined();
      expect(value).toContain('{cycle}');
      expect(value).toContain('{recipient}');
    }
  });

  it('drops the old single key so nothing can fall back to it', () => {
    for (const locale of locales) {
      expect(DICTIONARIES[locale]).not.toHaveProperty('escrow.completed');
    }
  });

  // The reported mismatch, pinned in EN: only the open-next-round sentence
  // may promise the next round. Resume Cycle starts a new lap and resets
  // every security deposit (njangi_circles::resume_cycle), and the sentence
  // has to say so — that is what a member needs to know.
  it('only the open-next-round sentence promises the next round', () => {
    const en = DICTIONARIES.en;
    expect(en[completedRoundCopyKey('open-next-round')]).toMatch(/open the next round/i);
    for (const action of ['resume-cycle', 'advance-rotation', 'unknown'] as const) {
      expect(en[completedRoundCopyKey(action)]).not.toMatch(/can open the next round/i);
    }
  });

  it('tells members a resumed cycle needs fresh security deposits', () => {
    const sentence = DICTIONARIES.en[completedRoundCopyKey('resume-cycle')];
    expect(sentence).toMatch(/security deposit/i);
    expect(sentence).toMatch(/resumes the cycle/i);
  });

  // A failed read is not a fact: the unknown sentence reports that the
  // state could not be read and suggests no action to anyone.
  it('suggests no action when the rotation could not be read', () => {
    const sentence = DICTIONARIES.en[completedRoundCopyKey('unknown')];
    expect(sentence).toMatch(/couldn't read/i);
    expect(sentence).not.toMatch(/admin/i);
    expect(sentence).not.toMatch(/open|advance|resume/i);
  });
});
