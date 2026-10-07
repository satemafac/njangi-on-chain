// recovery-sponsorship.ts — what the recovery and deposit-return actions ask
// the sponsor to cover.
//
// The emergency stop (the admin proposes it, the members vote), the recovery
// it unlocks, the auto-release when the admin goes quiet, and the admin's
// "Return Deposit & Remove Member" are how deposits come back to members. A
// member holding no SUI must be able to get theirs back, so each asks the
// sponsor first; any decline pays the network fee as before. All of them
// bill the circle they act on, which is one of the transaction's own inputs,
// as /api/sponsor/prepare requires. None draws on the gas coin.

import type { SponsorRequest } from './sponsored-first-signer';

export type RecoverySponsorAction =
  | 'proposeEmergencyStop'
  | 'voteEmergencyStop'
  | 'executeRecovery'
  | 'triggerAutoRelease'
  | 'returnDepositAndRemoveMember';

export function circleSponsorRequest(
  action: RecoverySponsorAction,
  circleId: string,
): SponsorRequest {
  return { action, context: { circleId } };
}
