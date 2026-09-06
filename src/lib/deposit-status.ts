/**
 * Security-deposit status helpers for the round-open gate.
 *
 * Two on-chain facts describe a member's security deposit:
 *
 *   - `deposit_paid`    — a boolean flag on the Member record. `activate_circle`
 *                         requires it for every member, and `resume_cycle`
 *                         clears it for everyone at the start of a new lap.
 *   - `deposit_balance` — the amount actually held in custody for that member.
 *                         `resume_cycle` does NOT touch it: the funds stay held.
 *
 * On a resumed circle the flag is therefore false while the balance is still
 * held, the contract refuses a re-deposit (abort 21), and `open_cycle*` never
 * consults deposits at all. Gating "Open the next round" on the flag alone
 * locked every resumed circle out of its second lap.
 *
 * `isDepositHeldForRounds` is the predicate for that gate ONLY: a member is
 * deposit-satisfied when the flag is set OR funds are held. It must not be
 * used for lap-1 activation, which the contract really does gate on the flag.
 */

export interface DepositStatusLike {
  depositPaid?: boolean | null;
  depositBalanceRaw?: bigint | null;
}

/**
 * True when the member's security deposit is satisfied for the purpose of
 * opening a round: either the on-chain flag is set, or a deposit balance is
 * still held in custody (the resumed-circle case).
 */
export function isDepositHeldForRounds(member: DepositStatusLike): boolean {
  if (member.depositPaid === true) return true;
  const balance = member.depositBalanceRaw ?? 0n;
  return balance > 0n;
}

/**
 * True when every member satisfies `isDepositHeldForRounds`. An empty member
 * list is NOT satisfied, matching the existing `allDepositsPaid` semantics.
 */
export function allDepositsHeldForRounds(members: readonly DepositStatusLike[]): boolean {
  return members.length > 0 && members.every(isDepositHeldForRounds);
}

/**
 * True when every member's deposit is held in custody but at least one has the
 * `deposit_paid` flag cleared — i.e. the circle was resumed for a new lap.
 * Used only to label diagnostics accurately; it moves no funds and gates
 * nothing.
 */
export function depositsHeldButFlagsCleared(members: readonly DepositStatusLike[]): boolean {
  if (!allDepositsHeldForRounds(members)) return false;
  return members.some((member) => member.depositPaid !== true);
}
