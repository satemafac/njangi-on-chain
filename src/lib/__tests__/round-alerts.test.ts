/**
 * The dashboard's "Ready to start the next round?" alert. It used to fire
 * when a pot FILLED (before the recipient collected, when opening is still
 * refused) and named the next lap; after the collect, the one moment the
 * admin can open, the scanner skipped the round and said nothing.
 */
import type { CircleRotationPointer } from '../cycle-round-progression';
import { adminNextRoundAlert } from '../round-alerts';

const ADMIN = '0x' + 'e8'.repeat(32);
const MEMBER_1 = '0x' + 'df'.repeat(32);
const MEMBER_2 = '0x' + '1f'.repeat(32);
const ROTATION = [ADMIN, MEMBER_1, MEMBER_2];

function pointer(over: Partial<CircleRotationPointer>): CircleRotationPointer {
  return {
    currentCycle: 6,
    currentPosition: 1,
    nextRecipient: MEMBER_1,
    pausedAfterCycle: false,
    ...over,
  };
}

describe('adminNextRoundAlert', () => {
  // Production circle 0xa3fada…675ed, 2026-10-05: escrow #17 (lap 6, the
  // admin's turn, round 16) collected; the pointer moved to MEMBER-1.
  const escrow17 = { cycleNo: 6, recipient: ADMIN, members: ROTATION };

  it('prompts the next round, by its circle-wide number, once the collect moved the rotation on', () => {
    expect(adminNextRoundAlert({ escrow: escrow17, pointer: pointer({}) })).toEqual({
      kind: 'open-next-round',
      roundNo: 17,
    });
  });

  it('stays quiet at the end of a lap, where the step is Resume Cycle', () => {
    const lastOfLap5 = { cycleNo: 5, recipient: MEMBER_2, members: ROTATION };
    expect(
      adminNextRoundAlert({
        escrow: lastOfLap5,
        pointer: pointer({ currentCycle: 5, currentPosition: 2, nextRecipient: MEMBER_2, pausedAfterCycle: true }),
      }),
    ).toEqual({ kind: 'none' });
  });

  it('stays quiet while the circle still points at the member who just collected', () => {
    expect(
      adminNextRoundAlert({
        escrow: escrow17,
        pointer: pointer({ currentPosition: 0, nextRecipient: ADMIN }),
      }),
    ).toEqual({ kind: 'none' });
  });

  it('reports an unreadable circle as unknown, not as nothing to do', () => {
    expect(adminNextRoundAlert({ escrow: escrow17, pointer: null })).toEqual({ kind: 'unreadable' });
  });

  it('still prompts when the collected round cannot be numbered', () => {
    expect(
      adminNextRoundAlert({ escrow: { ...escrow17, members: [] }, pointer: pointer({}) }),
    ).toEqual({ kind: 'open-next-round', roundNo: null });
  });
});
