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
  | 'cancelStalledRound'
  | 'openRound';

/** Bills the circle through the round's escrow, which the transaction touches. */
export function escrowSponsorRequest(
  action: Exclude<RoundSponsorAction, 'openRound'>,
  escrowId: string,
  coinType: string,
): SponsorRequest {
  return { action, context: { escrowId, coinType } };
}

/**
 * Cancelling a stalled round (`cancel_unfinalized_escrow*`): billed through
 * the round's escrow like the expired-claim refund it mirrors. Both cancel
 * entry points take the escrow as an input, so prepare's binding check passes
 * for either; the recovery variant's extra `&Circle` changes nothing here.
 * Permissionless and gas-less-safe: a member holding no SUI can still get the
 * shares back for everyone.
 */
export function cancelStalledRoundSponsorRequest(escrowId: string, coinType: string): SponsorRequest {
  return escrowSponsorRequest('cancelStalledRound', escrowId, coinType);
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
