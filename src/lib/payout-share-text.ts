// payout-share-text.ts — The plain-text card a member copies after
// collecting their turn (PayoutCelebration's "Share"). Copy rules: see the
// header of src/components/PayoutCelebration.tsx.

/**
 * `roundNo` is the circle-wide round number (round-number.ts); the escrow's
 * cycle_no counts laps, so the 16th payout of a 3-member circle used to be
 * shared as "round 6". Anything but a number (the panel's '—') leaves the
 * round out: a post people share is no place for a placeholder.
 */
export function buildShareText(input: {
  amount: string;
  roundNo: number | string;
  circleName?: string;
}): string {
  const circle = input.circleName ? ` in ${input.circleName}` : '';
  const round = typeof input.roundNo === 'number' ? `, round ${input.roundNo}` : '';
  return (
    `It's my turn: I just received my circle payout of ${input.amount}` +
    `${circle}${round}. Nobody held the pot. njangionchain.com`
  );
}
