// attestation-stale.ts — shared logic for finding members of
// compliance-gated circles who lack a valid ComplianceAttestation, and
// nudging them via WhatsApp.
//
// Extracted from src/pages/api/admin/compliance/stale.ts so the same
// implementation backs BOTH the operator console (manual, circle-ids
// supplied) and the daily /api/cron/attestation-expiry cron (automatic,
// self-discovers gated circles). An expired/absent attestation silently
// locks a member out of contributing or claiming mid-cycle, so the cron
// turns a manual chore into an automatic reminder.

import {
  findCurrentCycleEscrow,
  readCycleEscrowState,
  listContributors,
  eventTypePackageIdFor,
} from './cycle-escrow-discovery';
import { fetchValidAttestations } from './compliance-gate';
import { getNetworkConfig } from '../services/network-config';
import { getPooledSuiClient } from '../services/sui-rpc-failover';
import { sendMemberNotification } from './whatsapp-notifier';
import type { NetworkType } from '../services/whatsapp-registry-service';

export interface StaleMember {
  circleId: string;
  cycleNo: number;
  memberAddress: string;
  reason: 'no_attestation' | 'expired_attestation' | 'revoked';
  expiresAtMs?: number;
}

export interface StaleReport {
  stale: StaleMember[];
  /**
   * Circles this run could not fully check: a read of the round, its
   * contributors or a member's attestations failed. Their members are
   * UNKNOWN, not current, so callers must say these circles weren't
   * checked rather than report "nothing stale".
   */
  unchecked: string[];
}

export interface GatedCircleDiscovery {
  circleIds: string[];
  /**
   * False when the event scan failed part-way (or before its first page):
   * gated circles may be missing from `circleIds`, so an empty list is not
   * "no gated circles".
   */
  complete: boolean;
}

export const STALE_ATTESTATION_NUDGE_BODY =
  '👋 *Action needed for your njangi circle*\n\n' +
  'Your circle now requires a current KYC check before you can pay your share or collect a payout.\n' +
  'Open the Njangi app, choose a ramp partner, and complete the KYC step. ' +
  'Once it finishes, the app will let you continue automatically.';

// Cap on circles discovered per cron run — bounds RPC + keeps the run inside
// the serverless timeout even as the circle count grows.
const MAX_DISCOVERED_CIRCLES = 200;

/**
 * Discovers circle ids that currently run an attestation-gated escrow, by
 * scanning `CycleEscrowOpened` events (which carry `requires_attestation`).
 * Deduped, newest-first, capped. Used by the cron so operators don't have to
 * hand-enter circle ids.
 *
 * A failed scan keeps whatever it found and reports `complete: false`: an
 * empty list from a scan that never ran used to read as "no gated circles",
 * and the cron reported a clean sweep that had checked nothing.
 */
export async function discoverGatedCircleIds(
  network: NetworkType,
  opts?: { limit?: number },
): Promise<GatedCircleDiscovery> {
  const client = getPooledSuiClient({
    network,
    rpcUrl: getNetworkConfig(network).rpcUrl,
  });
  const packageId = eventTypePackageIdFor(network);
  const cap = opts?.limit ?? MAX_DISCOVERED_CIRCLES;
  const seen = new Set<string>();
  let complete = true;

  try {
    let cursor: { txDigest: string; eventSeq: string } | null | undefined =
      undefined;
    // Page until we hit the cap or run out. Each event is one opened cycle;
    // a circle can appear many times (one per cycle) — we dedupe on circle_id.
    for (let page = 0; page < 20 && seen.size < cap; page += 1) {
      const events = await client.queryEvents({
        query: { MoveEventType: `${packageId}::njangi_cycle_escrow::CycleEscrowOpened` },
        limit: 50,
        order: 'descending',
        cursor: cursor ?? null,
      });
      for (const event of events.data) {
        const parsed = (event.parsedJson ?? {}) as Record<string, unknown>;
        if (parsed.requires_attestation !== true) continue;
        const circleId = typeof parsed.circle_id === 'string' ? parsed.circle_id : '';
        if (circleId) seen.add(circleId);
        if (seen.size >= cap) break;
      }
      if (!events.hasNextPage || !events.nextCursor) break;
      cursor = events.nextCursor;
    }
  } catch (err) {
    console.warn('[attestation-stale] gated-circle discovery failed', err);
    complete = false;
  }

  return { circleIds: Array.from(seen), complete };
}

/**
 * For each supplied circle: find the current gated, unclaimed escrow and
 * report every contributor + recipient who lacks a valid attestation.
 *
 * Fails soft per circle: a failed read skips that circle and lists it in
 * `unchecked`, and the sweep moves on. Before, only the round lookup was
 * caught, so one failed escrow or contributor read aborted the whole sweep
 * (the cron and the admin console both answered 500), and a failed
 * attestation read silently dropped the member it was checking.
 */
export async function buildStaleReport(
  network: NetworkType,
  circleIds: string[],
): Promise<StaleReport> {
  const client = getPooledSuiClient({
    network,
    rpcUrl: getNetworkConfig(network).rpcUrl,
  });
  const stale: StaleMember[] = [];
  const unchecked: string[] = [];

  for (const circleId of circleIds) {
    try {
      const escrowSummary = await findCurrentCycleEscrow(network, circleId);
      // null is a real answer here: no round has been opened.
      if (!escrowSummary) continue;
      const state = await readCycleEscrowState(escrowSummary.escrowId, network, client);
      if (!state) {
        // The lookup above just read and verified this escrow, so a reply
        // without its content is a failed read, not a missing round.
        console.warn('[attestation-stale] escrow state unreadable', { circleId });
        unchecked.push(circleId);
        continue;
      }
      if (!state.requiresAttestation) continue;
      if (state.claimed) continue;

      const contributors = await listContributors(escrowSummary.escrowId, network);
      const candidates = new Set<string>();
      for (const member of contributors) candidates.add(member.toLowerCase());
      candidates.add(state.recipient.toLowerCase());

      let memberCheckFailed = false;
      for (const member of candidates) {
        try {
          const rows = await fetchValidAttestations(member, network, client);
          if (rows.length === 0) {
            stale.push({
              circleId,
              cycleNo: state.cycleNo,
              memberAddress: member,
              reason: 'no_attestation',
            });
          }
        } catch (err) {
          console.warn('[attestation-stale] attestation check failed', { circleId, member, err });
          memberCheckFailed = true;
        }
      }
      // The members that were read are still reported; the circle is listed
      // as unchecked because at least one member's status is unknown.
      if (memberCheckFailed) unchecked.push(circleId);
    } catch (err) {
      console.warn('[attestation-stale] circle check failed', { circleId, err });
      unchecked.push(circleId);
    }
  }

  return { stale, unchecked };
}

/**
 * Sends a nudge to each stale member with a linked WhatsApp number. Dedupe
 * is (circle, cycle)-scoped with a 12h window by default, so re-running the
 * sweep (manual re-run OR the daily cron) never double-pings the same member
 * for the same round. Returns how many messages were actually dispatched.
 */
export async function nudgeStaleMembers(
  network: NetworkType,
  stale: StaleMember[],
  dedupeWindowMs: number = 12 * 60 * 60 * 1000,
): Promise<number> {
  let nudged = 0;
  for (const entry of stale) {
    try {
      const result = await sendMemberNotification({
        memberAddress: entry.memberAddress,
        network,
        body: STALE_ATTESTATION_NUDGE_BODY,
        kind: 'stale_attestation_admin',
        dedupeKey: `${entry.circleId}:${entry.cycleNo}`,
        dedupeWindowMs,
      });
      if (result.sent) nudged += 1;
    } catch (err) {
      console.warn('[attestation-stale] nudge failed', {
        member: entry.memberAddress,
        err,
      });
    }
  }
  return nudged;
}
