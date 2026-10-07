// round-sponsorship.ts — what the round panel asks the sponsor to cover.
//
// Every round transaction asks first, and the sponsor's own rules decide
// (gas-sponsorship.ts, /api/sponsor/prepare): the circle admin's plan, the
// fair-use caps, the Move-call allowlist. A decline costs the member nothing
// but their own network fee, exactly as before.
//
// The one exception is a share paid in SUI. It is split from the gas coin,
// which under sponsorship is the sponsor's coin, so it can never be sponsored
// (sponsorable-kind.ts) and asking would only add a round trip.

import type { SponsorRequest } from './sponsored-first-signer';
import type { SupportedCoin } from './supported-coins';

export type RoundSponsorAction =
  | 'payRoundShare'
  | 'collectPayout'
  | 'advanceRound'
  | 'refundExpiredClaim'
  | 'openRound';

/** Bills the circle through the round's escrow, which the transaction touches. */
export function escrowSponsorRequest(
  action: Exclude<RoundSponsorAction, 'openRound'>,
  escrowId: string,
  coinType: string,
): SponsorRequest {
  return { action, context: { escrowId, coinType } };
}

/** A member's share: never for a SUI share, which comes out of the gas coin. */
export function payShareSponsorRequest(
  coin: SupportedCoin,
  escrowId: string,
): SponsorRequest | undefined {
  if (coin.symbol === 'SUI') return undefined;
  return escrowSponsorRequest('payRoundShare', escrowId, coin.coinType);
}

/** A new round has no escrow yet, so the circle the open names is billed. */
export function openRoundSponsorRequest(circleId: string, coinType: string): SponsorRequest {
  return { action: 'openRound', context: { circleId, coinType } };
}
