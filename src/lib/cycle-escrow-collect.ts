// cycle-escrow-collect.ts — Which stage a round's pot is in, and what the
// recipient's Collect button signs.
//
// `njangi_cycle_escrow::finalize_to_recipient<T>` is permissionless: once a
// round's pot is full, anyone may pay the gas to settle it. It mints a
// `Claim<T>`, transfers it to the snapshot recipient and sets `finalized`;
// `claimed` stays false until the recipient redeems. Collect used to build
// `finalize_and_redeem*` unconditionally, and that mints a claim of its own,
// so on such an escrow it aborts 205 `E_ALREADY_FINALIZED`. The recipient saw
// a Collect button that could never work, and the pot sat until
// `refund_expired_claim` returned it to the contributors after the 30-day
// claim window. Nothing in the app finalizes that way, but a keeper, a third
// party or the recipient's own hand-rolled PTB can.
//
// The contract always had the second half of that path: `redeem_claim` pays
// out a Claim to its recipient, and to nobody else. So Collect on a
// finalized escrow finds the Claim in the recipient's wallet and redeems it,
// chaining `advance_circle_after_claim` exactly as the one-step collect does.
//
// The package version behind `isFinalizedEscrowCollectEnabled` makes
// `finalize_and_redeem*` pay out a finalized escrow from the escrow itself,
// with no Claim object. Once that flag is on, Collect is the one-step call in
// every collectable state, and the Claim lookup below is not used.
//
// Doctrine (shared with cycle-escrow-discovery.ts): a lookup that FAILED is
// unknown, never "no claim". The two get different words in the panel —
// "try again" versus "it isn't in this wallet".

import type { SuiClient, SuiObjectResponse } from '@mysten/sui/client';
import type { NetworkType } from '@/config/public-env';
import { getPublishedPackageMetadata } from './circle-chain';
import type { CycleEscrowLiveState } from './cycle-escrow-discovery';
import { getPackageIdForNetwork } from '@/services/network-config';

// ---------------------------------------------------------------------------
// Stage — what the panel renders for the current round
// ---------------------------------------------------------------------------

export type EscrowStage =
  | 'loading'
  | 'no-round-open'
  | 'in-progress'
  /**
   * Open, partly paid, and past its due date plus the 7-day grace on the
   * chain clock (or its circle was stopped by a recovery vote): anyone may
   * cancel it now with `cancel_unfinalized_escrow`, which sends each
   * recorded share back to the member who paid it. Paying in still works
   * until someone does, so a late payer can still complete the round.
   */
  | 'stalled'
  | 'full-waiting-for-claim'
  /**
   * Finalized, never collected, and past its claim window on the chain
   * clock: nobody can collect any more, and `refund_expired_claim` sends the
   * pot back to the contributors.
   */
  | 'claim-expired'
  | 'completed'
  /** Refunds began on chain; only a re-open (by the admin) moves the round on. */
  | 'refunded';

export type EscrowStageState = Pick<
  CycleEscrowLiveState,
  'finalized' | 'claimed' | 'refunded' | 'claimExpiresAtMs' | 'dueAtMs'
>;

/**
 * The contract's `CANCEL_GRACE_MS` (njangi_cycle_escrow.move): how long after
 * the snapshot due date `cancel_unfinalized_escrow` keeps aborting 224
 * `E_CANCEL_TOO_EARLY`. Mirrored, not read: the constant is not exposed as an
 * object field, and `due_at_ms` itself comes from the chain, so a Move change
 * to how the due date is derived needs nothing here.
 */
export const CANCEL_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The first chain-clock ms at which the round can be cancelled: due date plus
 * grace, the same sum the contract compares. Null when the snapshot carried no
 * due date, which never opens a window.
 */
export function cancelAvailableAtMs(state: Pick<EscrowStageState, 'dueAtMs'>): number | null {
  return state.dueAtMs > 0 ? state.dueAtMs + CANCEL_GRACE_MS : null;
}

/**
 * Whether an open round's cancel window has opened, judged on the CHAIN clock.
 *
 * `false` when no window can apply (finalized, collected or refunded: the
 * contract refuses the cancel there, 205/226). `null` when it could apply but
 * the answer is unknown: the chain clock could not be read, or the snapshot
 * carries no due date. Callers must not read null as either answer, exactly
 * as for `claimWindowClosed`.
 *
 * Open means at or after the sum, the same boundary as
 * `cancel_unfinalized_escrow` (`now >= due_at_ms + CANCEL_GRACE_MS`).
 */
export function cancelWindowOpen(
  state: EscrowStageState,
  chainNowMs: number | null,
): boolean | null {
  if (state.finalized || state.claimed || state.refunded) return false;
  const availableAt = cancelAvailableAtMs(state);
  if (chainNowMs === null || availableAt === null) return null;
  return chainNowMs >= availableAt;
}

/**
 * Whether a round's claim window has closed, judged on the CHAIN clock.
 *
 * `false` when no window is running (unfinalized, collected or refunded).
 * `null` when one is running but the answer is unknown: the chain clock could
 * not be read, or the escrow carries no expiry. Callers must not read null as
 * either answer. Announcing a closed window on a guess, and offering the
 * refund that ends it, would take a payout away from its recipient.
 *
 * Closed means strictly after the expiry ms, the same boundary as
 * `refund_expired_claim` (`redeem_claim` still pays on the expiry ms itself).
 */
export function claimWindowClosed(
  state: EscrowStageState,
  chainNowMs: number | null,
): boolean | null {
  if (!state.finalized || state.claimed || state.refunded) return false;
  if (chainNowMs === null || !(state.claimExpiresAtMs > 0)) return null;
  return chainNowMs > state.claimExpiresAtMs;
}

export function resolveEscrowStage(params: {
  loading: boolean;
  /** Null when no round was found, or its escrow could not be read. */
  state: EscrowStageState | null;
  paidSoFar: number;
  totalRequired: number;
  /** `readChainClockMs`: null when unread, which never closes a window. */
  chainNowMs?: number | null;
  /**
   * `readCircleRecoveryStopped`: the circle's recovery vote executed (state
   * STOPPED or REFUNDED), which lets `cancel_unfinalized_escrow_for_recovery`
   * cancel an open round with no grace wait. Null when unread, which falls
   * back to the time rule and never widens the window.
   */
  circleStopped?: boolean | null;
}): EscrowStage {
  const {
    loading,
    state,
    paidSoFar,
    totalRequired,
    chainNowMs = null,
    circleStopped = null,
  } = params;
  if (loading) return 'loading';
  if (!state) return 'no-round-open';
  // Checked first: a refunded escrow is unfinalized/unclaimed on chain and
  // would otherwise render as an in-progress round whose "pay" aborts.
  if (state.refunded) return 'refunded';
  if (state.claimed) return 'completed';
  if (claimWindowClosed(state, chainNowMs) === true) return 'claim-expired';
  // Finalized but unclaimed is waiting on the recipient no matter who
  // finalized it: Collect redeems the Claim already in their wallet (see
  // resolveCollectRoute) instead of minting a second one.
  if (state.finalized) return 'full-waiting-for-claim';
  if (paidSoFar >= totalRequired && totalRequired > 0) return 'full-waiting-for-claim';
  // Stalled: partly paid (a cancel with nothing recorded aborts 225, so an
  // empty round has no cancel to offer) and either past the cancel window on
  // the chain clock or in a circle whose recovery vote stopped it. A full pot
  // is never stalled: it is waiting on its recipient, and cancelling it would
  // take a payout away.
  if (paidSoFar > 0 && (cancelWindowOpen(state, chainNowMs) === true || circleStopped === true)) {
    return 'stalled';
  }
  return 'in-progress';
}

// ---------------------------------------------------------------------------
// Stalled round — which cancel the panel builds
// ---------------------------------------------------------------------------

export type CancelRoundRoute =
  /** `cancel_unfinalized_escrow<T>(escrow, clock)`: the grace has elapsed. */
  | { kind: 'cancel' }
  /**
   * `cancel_unfinalized_escrow_for_recovery<T>(escrow, circle, clock)`: the
   * circle's recovery vote stopped it, so the contract waives the grace. Also
   * the right call once the grace HAS elapsed on a stopped circle: both would
   * succeed, and this one does not depend on the clock.
   */
  | { kind: 'cancel-for-recovery' };

/**
 * Which cancel a stalled round signs. The stage already decided a cancel is
 * due; this only picks the entry point. An unread recovery state (null) takes
 * the plain cancel, which the stage only reaches through the time rule.
 */
export function resolveCancelRoundRoute(circleStopped: boolean | null): CancelRoundRoute {
  return circleStopped === true ? { kind: 'cancel-for-recovery' } : { kind: 'cancel' };
}

// ---------------------------------------------------------------------------
// Expired claim — who is offered "Send the contributions back"
// ---------------------------------------------------------------------------

/**
 * Whether the panel offers `refund_expired_claim` to the signed-in viewer
 * once a round's claim window has closed — and, by the same rule, the
 * stalled-round cancel (`cancel_unfinalized_escrow*`), which sends the same
 * shares back to the same people.
 *
 * The call is permissionless and can only pay the recorded contributors, so
 * this is a product rule, not a safety check. Recovery is member-initiated:
 * every member of the round, the admin included, is offered it, and a
 * signed-in viewer outside the round is not. It is never admin-only, so
 * nobody's money waits on one person to act.
 *
 * Membership is the escrow's own frozen member list (`snapshot.members`, the
 * list `contribute` checks; it includes the recipient), which arrives in the
 * same object read as the stage. A recorded contributor is a member by
 * construction (`contribute` aborts 200 for anyone off that list), so that
 * alone settles it even when the list did not come back.
 */
export type ExpiredClaimRefundAccess =
  /** The admin, or a member of this round: offer the refund. */
  | 'offer'
  /** Signed in, the member list was read, and this address is not on it. */
  | 'not-member'
  /**
   * The member list did not come back. Neither offer nor hide the refund on
   * a guess; say it could not be checked, and let a refresh try again.
   */
  | 'unknown'
  /** No signer session, so nobody to check yet; the panel asks them to sign in. */
  | 'signed-out';

export function resolveExpiredClaimRefundAccess(params: {
  /** The signer's address (`useZkLoginSigner`), null when signed out. */
  userAddress: string | null;
  isAdmin: boolean;
  /** The escrow snapshot's members; empty or absent when unreadable. */
  members: readonly string[] | null | undefined;
  /** Recorded contributors (the escrow's `contributed` table). */
  contributors: readonly string[];
}): ExpiredClaimRefundAccess {
  const { userAddress, isAdmin, members, contributors } = params;
  if (isAdmin) return 'offer';
  if (!userAddress) return 'signed-out';
  const viewer = normalizeAddress(userAddress);
  const includesViewer = (list: readonly string[]) =>
    list.some((address) => normalizeAddress(address) === viewer);
  if (includesViewer(contributors)) return 'offer';
  // `open_cycle*` refuses to open a round with fewer than two members, so an
  // empty list is a read that came back unusable, never an empty round.
  if (!members || members.length === 0) return 'unknown';
  return includesViewer(members) ? 'offer' : 'not-member';
}

// ---------------------------------------------------------------------------
// Collect route — which transaction the recipient's Collect builds
// ---------------------------------------------------------------------------

export type CollectRoute =
  /**
   * One PTB collects and advances the rotation: `finalize_and_redeem*`
   * finalizes first if nobody has (and, with the finalized-collect package,
   * pays out an already-finalized escrow without its claim).
   */
  | { kind: 'finalize-and-redeem' }
  /**
   * Finalized by someone else, on a package without the finalized collect:
   * the `Claim<T>` sits in the recipient's wallet, so Collect redeems it
   * (`redeem_claim`).
   */
  | { kind: 'redeem-claim' }
  /** Nothing the recipient could sign would collect this escrow. */
  | { kind: 'none'; reason: CollectUnavailableReason };

export type CollectUnavailableReason =
  /** Already redeemed. */
  | 'claimed'
  /** Refunds began; the pot belongs to the contributors again. */
  | 'refunded'
  /**
   * A compliance-gated escrow that is finalized but unclaimed. The contract
   * never produces one: `finalize_to_recipient` and `finalize` both abort
   * 216 `E_COMPLIANCE_ATTESTATION_REQUIRED` on a gated escrow, and the gated
   * `finalize_and_redeem_with_attestation` redeems in the same transaction.
   * Old package versions stay callable, so this matters for all of them: the
   * check dates from the original publish (devInspect against the original,
   * v6 and v9 testnet packages, 2026-10-03), and
   * `test_gated_escrow_rejects_ungated_finalize` pins it. Refused rather than
   * redeemed if it ever shows up: `redeem_claim` has no attestation-gated
   * wrapper, so redeeming would collect from a gated escrow without the
   * check the gate exists for.
   */
  | 'gated-claim';

export type CollectRouteState = Pick<
  CycleEscrowLiveState,
  'finalized' | 'claimed' | 'refunded' | 'requiresAttestation'
>;

export function resolveCollectRoute(
  state: CollectRouteState,
  options: {
    /**
     * `isFinalizedEscrowCollectEnabled()`: the published package's
     * `finalize_and_redeem*` also pays out a finalized escrow.
     */
    finalizedCollect?: boolean;
  } = {},
): CollectRoute {
  // Terminal states first, in the stage's order.
  if (state.refunded) return { kind: 'none', reason: 'refunded' };
  if (state.claimed) return { kind: 'none', reason: 'claimed' };
  // Before the finalized-collect package, `finalize_and_redeem*` re-mints
  // the claim, so it only works while the escrow is unfinalized; on a
  // finalized one it aborts 205. With it, the one call serves both states,
  // and a gated escrow keeps its attestation check (the gated variant).
  if (!state.finalized || options.finalizedCollect) return { kind: 'finalize-and-redeem' };
  if (state.requiresAttestation) return { kind: 'none', reason: 'gated-claim' };
  return { kind: 'redeem-claim' };
}

// ---------------------------------------------------------------------------
// Claim lookup — the recipient's `Claim<T>` for one escrow
// ---------------------------------------------------------------------------

/** Pages of the owner's `Claim<T>` objects read before the answer is declared unknown. */
export const MAX_CLAIM_PAGES = 10;

const CLAIM_TYPE_PATTERN = /^(0x[0-9a-fA-F]+)::njangi_cycle_escrow::Claim</;

/**
 * The package `Claim` types are anchored to. Struct types keep the id of the
 * package version that DEFINED them, and `Claim` shipped in the original
 * publish (testnet's type origin table names 0x89cddf4d…), so this is the
 * original id, never the published-at that calls go to — a filter built from
 * the latest id matches nothing, the bug fetchValidAttestations had in
 * compliance-gate.ts.
 */
export function claimTypePackageId(network: NetworkType): string {
  const { originalId } = getPublishedPackageMetadata(network);
  if (originalId) return originalId;
  const fallback = getPackageIdForNetwork(network);
  if (!fallback || fallback.trim() === '') {
    throw new Error(`No package id configured for ${network}; cannot look up payout claims.`);
  }
  return fallback.trim();
}

/** The `getOwnedObjects` StructType filter for one coin's claims. */
export function claimStructType(network: NetworkType, coinType: string): string {
  return `${claimTypePackageId(network)}::njangi_cycle_escrow::Claim<${coinType}>`;
}

export interface RecipientClaim {
  claimId: string;
  escrowId: string;
  cycleNo: number;
  recipient: string;
  /** The whole pot, in the escrow coin's base units. */
  amount: string;
  /** Last chain-clock ms at which `redeem_claim` accepts this claim. */
  expiresAtMs: number;
}

export type RecipientClaimLookup =
  /** A claim the owner can redeem against this escrow. */
  | { kind: 'found'; claim: RecipientClaim }
  /**
   * Every `Claim<T>` the owner holds was read and none is this escrow's.
   * A real answer, but a narrow one: right after a finalize the owner index
   * may not have caught up yet, so it earns "try again shortly", never
   * "there is no payout".
   */
  | { kind: 'absent' }
  /** A read failed or could not be accounted for in full. Nothing may be inferred. */
  | { kind: 'unknown' };

// Pads as well as prefixing, so an unpadded id still compares equal to the
// 64-hex form the RPC returns (the same helper as cycle-escrow-discovery.ts).
function normalizeAddress(value: string): string {
  return '0x' + value.trim().toLowerCase().replace(/^0x/, '').padStart(64, '0');
}

type ParsedOwnedClaim =
  | { kind: 'claim'; claim: RecipientClaim }
  /** Not a `Claim` of this package: the endpoint did not apply the filter. */
  | { kind: 'other' }
  /** Listed, but its contents could not be read. Could have been ours. */
  | { kind: 'unreadable' };

function parseOwnedClaim(item: SuiObjectResponse, packageId: string): ParsedOwnedClaim {
  const data = item.data;
  if (item.error || !data) return { kind: 'unreadable' };
  const content = data.content;
  if (!content || content.dataType !== 'moveObject') return { kind: 'unreadable' };
  const type = data.type ?? content.type;
  const match = typeof type === 'string' ? CLAIM_TYPE_PATTERN.exec(type) : null;
  if (!match) return typeof type === 'string' ? { kind: 'other' } : { kind: 'unreadable' };
  if (normalizeAddress(match[1]) !== normalizeAddress(packageId)) return { kind: 'other' };

  const fields = content.fields as Record<string, unknown>;
  const cycleNo = Number(fields.cycle_no);
  const expiresAtMs = Number(fields.expires_at_ms);
  if (
    typeof data.objectId !== 'string' ||
    typeof fields.escrow_id !== 'string' ||
    typeof fields.recipient !== 'string' ||
    !Number.isSafeInteger(cycleNo) ||
    !Number.isSafeInteger(expiresAtMs) ||
    fields.amount === undefined ||
    fields.amount === null
  ) {
    return { kind: 'unreadable' };
  }
  return {
    kind: 'claim',
    claim: {
      claimId: data.objectId,
      escrowId: fields.escrow_id,
      cycleNo,
      recipient: fields.recipient,
      amount: String(fields.amount),
      expiresAtMs,
    },
  };
}

/**
 * The owner's `Claim<T>` for `escrowId`, if they hold it.
 *
 * Accepted only when it passes every identity assert `redeem_claim` makes
 * (njangi_cycle_escrow.move): its `escrow_id` is this escrow, its `cycle_no`
 * is the escrow snapshot's, and its `recipient` is the owner (who signs). A
 * claim failing the last two cannot happen by construction — only the module
 * packs a Claim, copying both from the escrow it finalizes — so one earns a
 * loud line and is skipped rather than handed to a transaction that aborts.
 *
 * Never throws: a failed page, a listed object whose contents did not come
 * back, or a listing longer than MAX_CLAIM_PAGES all read as `unknown`.
 */
export async function findRecipientClaim(params: {
  client: SuiClient;
  network: NetworkType;
  /** The signer — the only address `redeem_claim` will pay. */
  owner: string;
  escrowId: string;
  /** The escrow snapshot's cycle number. */
  cycleNo: number;
  /** The escrow's coin type `T`. */
  coinType: string;
}): Promise<RecipientClaimLookup> {
  const { client, network, owner, escrowId, cycleNo, coinType } = params;
  try {
    const packageId = claimTypePackageId(network);
    const structType = claimStructType(network, coinType);
    const wantedEscrow = normalizeAddress(escrowId);
    const wantedOwner = normalizeAddress(owner);
    let unreadable = false;
    let cursor: string | null | undefined;
    for (let page = 0; page < MAX_CLAIM_PAGES; page += 1) {
      const res = await client.getOwnedObjects({
        owner,
        filter: { StructType: structType },
        options: { showType: true, showContent: true },
        cursor,
      });
      for (const item of res.data) {
        const parsed = parseOwnedClaim(item, packageId);
        if (parsed.kind === 'unreadable') {
          unreadable = true;
          continue;
        }
        if (parsed.kind === 'other') continue;
        const { claim } = parsed;
        if (normalizeAddress(claim.escrowId) !== wantedEscrow) continue;
        if (claim.cycleNo !== cycleNo || normalizeAddress(claim.recipient) !== wantedOwner) {
          console.error(
            '[cycle-escrow-collect] claim for this escrow does not match its round or recipient; not redeeming it',
            { escrowId, claimId: claim.claimId, cycleNo, claimCycleNo: claim.cycleNo },
          );
          continue;
        }
        return { kind: 'found', claim };
      }
      if (!res.hasNextPage) return unreadable ? { kind: 'unknown' } : { kind: 'absent' };
      // More pages but no way to ask for them: the listing is incomplete.
      if (!res.nextCursor) return { kind: 'unknown' };
      cursor = res.nextCursor;
    }
    // Stopped before the listing ended: the claim could be on a later page.
    return { kind: 'unknown' };
  } catch (err) {
    console.warn('[cycle-escrow-collect] claim lookup failed', { escrowId, err });
    return { kind: 'unknown' };
  }
}
