/**
 * Regression: the round panel printed the LAP number as the round number.
 * On production circle 0xa3fada…675ed (rotation admin → …04a97d → …ba897b)
 * escrows #14, #15 and #16 all carry `cycle_no` 5 and all read "round 5";
 * escrow #17 (`cycle_no` 6, the admin's turn) read "Round 6 complete" though
 * it was the circle's 16th payout (#4 is an orphan from a duplicate open,
 * not a round).
 */
import { circleRoundNumber, roundNumber, roundNumberAt } from '../round-number';

const ADMIN = '0x' + 'e8'.repeat(32);
const MEMBER_1 = '0x' + 'df'.repeat(32);
const MEMBER_2 = '0x' + '1f'.repeat(32);
const ROTATION = [ADMIN, MEMBER_1, MEMBER_2];

describe('roundNumber', () => {
  it('numbers the production pilot rounds across laps', () => {
    // Escrows #14–#16: lap 5, one per seat. Escrow #17: lap 6, seat 0.
    expect(roundNumber({ cycleNo: 5, recipient: ADMIN, members: ROTATION })).toBe(13);
    expect(roundNumber({ cycleNo: 5, recipient: MEMBER_1, members: ROTATION })).toBe(14);
    expect(roundNumber({ cycleNo: 5, recipient: MEMBER_2, members: ROTATION })).toBe(15);
    expect(roundNumber({ cycleNo: 6, recipient: ADMIN, members: ROTATION })).toBe(16);
    // The first lap starts at round 1.
    expect(roundNumber({ cycleNo: 1, recipient: ADMIN, members: ROTATION })).toBe(1);
    expect(roundNumber({ cycleNo: 1, recipient: MEMBER_2, members: ROTATION })).toBe(3);
  });

  it('reads cycle_no the way JSON-RPC renders a u64', () => {
    expect(roundNumber({ cycleNo: '6', recipient: ADMIN, members: ROTATION })).toBe(16);
  });

  it("continues a migrated circle's count from its declared seat", () => {
    // Five members, two full passes finished off-platform, the first two
    // members of the third pass already collected: activation seeds
    // current_cycle = 2 + 1 and the pointer at seat 2.
    const five = [ADMIN, MEMBER_1, MEMBER_2, '0x' + 'aa'.repeat(32), '0x' + 'bb'.repeat(32)];
    expect(roundNumber({ cycleNo: 3, recipient: five[2], members: five })).toBe(13);
    expect(roundNumber({ cycleNo: 3, recipient: five[4], members: five })).toBe(15);
    // After resume_cycle the next lap starts at seat 0.
    expect(roundNumber({ cycleNo: 4, recipient: five[0], members: five })).toBe(16);
  });

  it('matches addresses by identity, not spelling', () => {
    const shortRecipient = '0xa';
    const padded = '0x' + '0'.repeat(63) + 'a';
    expect(roundNumber({ cycleNo: 2, recipient: shortRecipient, members: [ADMIN, padded] })).toBe(4);
    expect(
      roundNumber({ cycleNo: 1, recipient: MEMBER_1.toUpperCase().replace('0X', '0x'), members: ROTATION }),
    ).toBe(2);
  });

  it('skips empty seats and repeats like filter_active_members', () => {
    const raw = [ADMIN, '0x0', MEMBER_1, ADMIN, MEMBER_2];
    expect(roundNumber({ cycleNo: 2, recipient: MEMBER_2, members: raw })).toBe(6);
  });

  it.each([
    ['a lap of 0', { cycleNo: 0, recipient: ADMIN, members: ROTATION }],
    ['a negative lap', { cycleNo: -1, recipient: ADMIN, members: ROTATION }],
    ['a fractional lap', { cycleNo: 1.5, recipient: ADMIN, members: ROTATION }],
    ['an unreadable lap', { cycleNo: 'five', recipient: ADMIN, members: ROTATION }],
    ['a missing lap', { cycleNo: undefined, recipient: ADMIN, members: ROTATION }],
    ['a missing recipient', { cycleNo: 1, recipient: null, members: ROTATION }],
    ['a recipient off the list', { cycleNo: 1, recipient: '0x' + '99'.repeat(32), members: ROTATION }],
    ['no member list', { cycleNo: 1, recipient: ADMIN, members: undefined }],
    ['an empty member list', { cycleNo: 1, recipient: ADMIN, members: [] }],
    ['a malformed member', { cycleNo: 1, recipient: ADMIN, members: [ADMIN, 'not-an-address'] }],
  ])('is null for %s', (_label, snapshot) => {
    expect(roundNumber(snapshot as Parameters<typeof roundNumber>[0])).toBeNull();
  });
});

describe('roundNumberAt', () => {
  it('rejects a seat outside the rotation', () => {
    expect(roundNumberAt(1, 3, 3)).toBeNull();
    expect(roundNumberAt(1, -1, 3)).toBeNull();
    expect(roundNumberAt(1, 0, 0)).toBeNull();
    expect(roundNumberAt(2, 2, 3)).toBe(6);
  });
});

describe('circleRoundNumber', () => {
  it('numbers the round the rotation pointer stands on', () => {
    // After escrow #17 was collected the pointer moved to seat 1 of lap 6.
    expect(
      circleRoundNumber({ currentCycle: 6, currentPosition: 1, rotationOrder: ROTATION }),
    ).toBe(17);
    // A paused lap leaves the pointer on the member who just collected.
    expect(
      circleRoundNumber({ currentCycle: '5', currentPosition: 2, rotationOrder: ROTATION }),
    ).toBe(15);
  });

  it('is null before the circle starts or when the pointer is unreadable', () => {
    expect(circleRoundNumber({ currentCycle: 0, currentPosition: 0, rotationOrder: ROTATION })).toBeNull();
    expect(circleRoundNumber({ currentCycle: 2, currentPosition: 3, rotationOrder: ROTATION })).toBeNull();
    expect(circleRoundNumber({ currentCycle: 2, currentPosition: null, rotationOrder: ROTATION })).toBeNull();
    expect(circleRoundNumber({ currentCycle: 2, currentPosition: 0, rotationOrder: null })).toBeNull();
  });
});
