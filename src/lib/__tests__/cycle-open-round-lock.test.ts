/**
 * The UI half of the duplicate-open fix (production 2026-08-30, circle
 * 0xa3fada…675ed): two open transactions for one round, 34 seconds apart,
 * because the panel's busy flag cleared when the first tx resolved and a
 * stale re-read then lit up the other open control.
 *
 * These pin the lock's contract: held through submit AND through
 * confirmation, released only by discovery showing a live escrow the panel
 * had not seen before the click, or by the bounded timeout.
 */
import {
  beginOpenRound,
  classifyOpenRoundError,
  IDLE_OPEN_ROUND_LOCK,
  isOpenRoundLocked,
  OPEN_ROUND_CONFIRM_TIMEOUT_MS,
  openRoundResolved,
  settleOpenRoundLock,
  type ObservedRound,
} from '@/lib/cycle-open-round-lock';

const live = (escrowId: string): ObservedRound => ({
  escrowId,
  finalized: false,
  claimed: false,
  refunded: false,
});
const settled = (escrowId: string): ObservedRound => ({
  escrowId,
  finalized: true,
  claimed: true,
  refunded: false,
});

describe('open-round lock', () => {
  it('replays the incident: stays held after the tx resolves until discovery shows the new escrow', () => {
    // The panel showed settled round escrow 0xa; the admin clicked
    // "Open the next round".
    const submitting = beginOpenRound('0xa');
    expect(isOpenRoundLocked(submitting)).toBe(true);

    const confirming = openRoundResolved(submitting, 'digest-1', 1_000);
    expect(isOpenRoundLocked(confirming)).toBe(true);

    // The re-read after the tx is served before the node indexed the new
    // escrow: discovery still names the settled one. This is the exact
    // moment the old panel offered "Open this round" a second time.
    const stale = settleOpenRoundLock(confirming, settled('0xa'), 2_000);
    expect(stale.outcome).toBe('pending');
    expect(isOpenRoundLocked(stale.lock)).toBe(true);

    // Or discovery finds nothing at all (a first round, indexing lag).
    expect(settleOpenRoundLock(confirming, null, 3_000).outcome).toBe('pending');

    // The new escrow shows up: confirmed, controls back.
    expect(settleOpenRoundLock(confirming, live('0xb'), 4_000)).toEqual({
      outcome: 'confirmed',
      lock: IDLE_OPEN_ROUND_LOCK,
      escrowId: '0xb',
    });
  });

  it('will not confirm on a settled or refunded escrow when it had nothing to compare against', () => {
    // priorEscrowId null: the panel had a load error (or no round) before
    // the click. A leftover from an earlier round must not pass as the
    // one just opened.
    const confirming = openRoundResolved(beginOpenRound(null), 'd', 0);
    expect(settleOpenRoundLock(confirming, settled('0xold'), 10).outcome).toBe('pending');
    expect(
      settleOpenRoundLock(
        confirming,
        { escrowId: '0xold', finalized: false, claimed: false, refunded: true },
        10,
      ).outcome,
    ).toBe('pending');
    expect(
      settleOpenRoundLock(
        confirming,
        { escrowId: '0xold', finalized: true, claimed: false, refunded: false },
        10,
      ).outcome,
    ).toBe('pending');
    expect(settleOpenRoundLock(confirming, live('0xnew'), 10).outcome).toBe('confirmed');
  });

  it('compares escrow ids case-insensitively and ignores surrounding whitespace', () => {
    const confirming = openRoundResolved(beginOpenRound('0xABC'), 'd', 0);
    // Same escrow, different casing: still the prior one, still pending.
    expect(settleOpenRoundLock(confirming, live(' 0xabc '), 10).outcome).toBe('pending');
    expect(settleOpenRoundLock(confirming, live('0xabd'), 10).outcome).toBe('confirmed');
  });

  it('hands the controls back after the bounded timeout, and not a moment before', () => {
    const confirming = openRoundResolved(beginOpenRound('0xa'), 'd', 1_000);
    expect(
      settleOpenRoundLock(confirming, null, 1_000 + OPEN_ROUND_CONFIRM_TIMEOUT_MS - 1).outcome,
    ).toBe('pending');
    expect(settleOpenRoundLock(confirming, null, 1_000 + OPEN_ROUND_CONFIRM_TIMEOUT_MS)).toEqual({
      outcome: 'timed-out',
      lock: IDLE_OPEN_ROUND_LOCK,
    });
    // A confirmation that arrives exactly at the deadline still wins over
    // the timeout: the round IS open, say so rather than warn.
    expect(
      settleOpenRoundLock(confirming, live('0xb'), 1_000 + OPEN_ROUND_CONFIRM_TIMEOUT_MS).outcome,
    ).toBe('confirmed');
  });

  it('only a submitting lock resolves, and only a confirming lock settles', () => {
    expect(openRoundResolved(IDLE_OPEN_ROUND_LOCK, 'd', 0)).toBe(IDLE_OPEN_ROUND_LOCK);
    const confirming = openRoundResolved(beginOpenRound('0xa'), 'd', 0);
    expect(openRoundResolved(confirming, 'd2', 5)).toBe(confirming);

    // An observation during submit says nothing about an unresolved tx.
    const submitting = beginOpenRound('0xa');
    expect(settleOpenRoundLock(submitting, live('0xb'), 0)).toEqual({
      outcome: 'pending',
      lock: submitting,
    });
    expect(settleOpenRoundLock(IDLE_OPEN_ROUND_LOCK, live('0xb'), 0)).toEqual({
      outcome: 'pending',
      lock: IDLE_OPEN_ROUND_LOCK,
    });
  });

  it('recognises the on-chain duplicate-open refusals, and only from the escrow module', () => {
    const abort =
      'Transaction failed: MoveAbort(MoveLocation { module: ModuleId { address: 0xabc, name: Identifier("njangi_cycle_escrow") }, function: 14, instruction: 52, function_name: Some("open_cycle_internal") }, 234) in command 0';
    expect(classifyOpenRoundError(new Error(abort))).toBe('round-already-open');
    expect(classifyOpenRoundError(abort.replace(', 234)', ', 235)'))).toBe('round-still-open');
    // 234 in another module is not ours.
    expect(classifyOpenRoundError(abort.replace('njangi_cycle_escrow', 'njangi_circles'))).toBeNull();
    // Neither is a code that merely starts with 234.
    expect(classifyOpenRoundError(abort.replace(', 234)', ', 2340)'))).toBeNull();
    expect(classifyOpenRoundError(new Error('network down'))).toBeNull();
    expect(classifyOpenRoundError(undefined)).toBeNull();
  });
});
