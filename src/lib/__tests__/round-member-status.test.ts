/**
 * Regression: after paying their share, members on production circle
 * 0xa3fada…675ed (2026-10-05) still read "Payment: Ready" and "You can
 * continue with payment." The page took that from the legacy member row's
 * `last_contribution`, which the per-round escrow never writes. The status
 * now comes from the escrow the round panel reads.
 */
import type { EscrowStage } from '../cycle-escrow-collect';
import {
  resolveRoundMemberStatus,
  roundMemberStatusCopy,
  type RoundMemberStatus,
} from '../round-member-status';

const base = {
  loadError: false,
  userHasPaid: false,
  isUserRecipient: false,
  isRoundMember: true as boolean | null,
};

function status(stage: EscrowStage, over: Partial<typeof base> = {}): RoundMemberStatus {
  return resolveRoundMemberStatus({ stage, ...base, ...over });
}

describe('resolveRoundMemberStatus', () => {
  it('says a member who paid has contributed, not that they are ready to pay', () => {
    expect(status('in-progress', { userHasPaid: true })).toBe('paid');
    expect(status('full-waiting-for-claim', { userHasPaid: true })).toBe('paid');
  });

  it('owes a share only while the round is open and the member has not paid', () => {
    expect(status('in-progress')).toBe('due');
    // An unread member list counts as a member.
    expect(status('in-progress', { isRoundMember: null })).toBe('due');
  });

  it("names the round's recipient, who pays nothing in", () => {
    expect(status('in-progress', { isUserRecipient: true })).toBe('recipient');
    expect(status('full-waiting-for-claim', { isUserRecipient: true })).toBe('recipient');
  });

  it('owes nothing to a round that is not theirs', () => {
    expect(status('in-progress', { isRoundMember: false })).toBe('not-in-round');
    // A full pot already has every member's share.
    expect(status('full-waiting-for-claim')).toBe('not-in-round');
  });

  it.each<EscrowStage>(['completed', 'refunded', 'claim-expired'])(
    'owes nothing once the round is %s',
    (stage) => {
      expect(status(stage, { userHasPaid: true })).toBe('nothing-due');
      expect(status(stage, { isUserRecipient: true })).toBe('nothing-due');
    },
  );

  it('treats a stalled round as still open: paying in works until someone cancels it', () => {
    expect(status('stalled')).toBe('due');
    expect(status('stalled', { userHasPaid: true })).toBe('paid');
    expect(status('stalled', { isUserRecipient: true })).toBe('recipient');
    expect(status('stalled', { isRoundMember: false })).toBe('not-in-round');
  });

  it('separates "no round" from "could not read the round"', () => {
    expect(status('no-round-open')).toBe('no-round');
    // The panel reports a failed read as stage no-round-open + loadError.
    expect(status('no-round-open', { loadError: true })).toBe('unknown');
    expect(status('in-progress', { loadError: true, userHasPaid: true })).toBe('unknown');
  });

  it('is still checking while the round loads', () => {
    expect(status('loading', { loadError: true })).toBe('checking');
  });
});

describe('roundMemberStatusCopy', () => {
  const all: RoundMemberStatus[] = [
    'checking',
    'unknown',
    'no-round',
    'recipient',
    'paid',
    'due',
    'not-in-round',
    'nothing-due',
  ];

  it('never tells a member who paid to continue with payment', () => {
    const copy = roundMemberStatusCopy('paid');
    expect(copy.label).toBe('Contributed');
    expect(copy.detail).not.toMatch(/continue with payment/i);
    expect(copy.label).not.toBe('Ready');
  });

  it('only says a share is due when one is', () => {
    for (const s of all) {
      const copy = roundMemberStatusCopy(s);
      expect(/share due|pay your share/i.test(`${copy.label} ${copy.detail}`)).toBe(s === 'due');
    }
  });

  it('never states a round state it could not read', () => {
    expect(roundMemberStatusCopy('unknown').roundState).toBe("Couldn't check");
    expect(roundMemberStatusCopy('checking').roundState).toBe('Checking…');
  });
});
