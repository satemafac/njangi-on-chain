// round-alerts.ts — When the dashboard tells a circle's admin to open the
// next round, and which round it names.
//
// The scanner used to raise "The previous round finished. Open round N" as
// soon as a pot FILLED, while its recipient had yet to collect and the
// contract would still refuse a second open of that round, and it named the
// next LAP (cycle_no + 1). Once the round was collected the scanner skipped
// it, so the prompt disappeared at the one moment it became true. The
// admin's step comes after the collect, and only when the collect moved the
// rotation on: resolveNextRoundAction's `open-next-round`, the same answer
// the manage page's "Open the next round" button follows. At the end of a
// lap the step is Resume Cycle instead, which this alert does not cover.

import { resolveNextRoundAction, type CircleRotationPointer } from './cycle-round-progression';
import { roundNumber } from './round-number';

export type AdminNextRoundAlert =
  /** Open the next round. `roundNo` is null when it cannot be numbered. */
  | { kind: 'open-next-round'; roundNo: number | null }
  /** The circle's pointer could not be read: unknown, never "nothing to do". */
  | { kind: 'unreadable' }
  | { kind: 'none' };

/**
 * For a COLLECTED round, as its circle's admin sees it on the dashboard.
 * `pointer` is null when the circle read failed.
 */
export function adminNextRoundAlert(params: {
  escrow: { cycleNo: number; recipient: string; members: readonly string[] };
  pointer: CircleRotationPointer | null;
}): AdminNextRoundAlert {
  const { escrow, pointer } = params;
  const next = resolveNextRoundAction({
    escrowRecipient: escrow.recipient,
    escrowCycleNo: escrow.cycleNo,
    pointer,
  });
  if (next.action === 'open-next-round') {
    const collected = roundNumber(escrow);
    return { kind: 'open-next-round', roundNo: collected === null ? null : collected + 1 };
  }
  if (next.action === 'unknown' && next.reason === 'pointer-unavailable') {
    return { kind: 'unreadable' };
  }
  return { kind: 'none' };
}
