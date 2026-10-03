/**
 * Security-deposit status helpers for the round-open gate.
 *
 * Two on-chain facts describe a member's security deposit:
 *
 *   - `deposit_paid`    — a boolean flag on the Member record, set when the
 *                         member deposits. `activate_circle` requires it for
 *                         every member (abort 21).
 *   - `deposit_balance` — the amount actually held in custody for that member.
 *                         While it is above zero the contract refuses a
 *                         second deposit (also abort 21).
 *
 * Since package v7 (PR #19) `resume_cycle` touches neither: a deposit stays
 * held, with its flag set, across laps for the life of the membership. Before
 * v7 `resume_cycle` cleared the flag on every member at the start of a lap
 * while the balance stayed held, and gating "Open the next round" on the flag
 * alone locked those circles out of their second lap. A circle that resumed
 * before v7 keeps that state (flag false, funds held) until someone calls the
 * permissionless `reconcile_deposit_paid`, which restores the flag from the
 * held balance. `open_cycle*`, contributions and claims never consult
 * deposits.
 *
 * `isDepositHeldForRounds` is the predicate for that gate ONLY: a member is
 * deposit-satisfied when the flag is set OR funds are held, so an
 * unreconciled pre-v7 circle can still open rounds. It must not be used for
 * lap-1 activation, which the contract really does gate on the flag.
 */

export interface DepositStatusLike {
  depositPaid?: boolean | null;
  depositBalanceRaw?: bigint | null;
}

/**
 * True when the member's security deposit is satisfied for the purpose of
 * opening a round: either the on-chain flag is set, or a deposit balance is
 * still held in custody (a circle that resumed before v7 and has not been
 * reconciled).
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
 * `deposit_paid` flag cleared — i.e. the circle resumed before v7 and
 * `reconcile_deposit_paid` has not restored its flags yet. Used only to label
 * diagnostics accurately; it moves no funds and gates nothing.
 */
export function depositsHeldButFlagsCleared(members: readonly DepositStatusLike[]): boolean {
  if (!allDepositsHeldForRounds(members)) return false;
  return members.some((member) => member.depositPaid !== true);
}
