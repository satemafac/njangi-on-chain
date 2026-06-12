/**
 * GET  /api/admin/compliance/stale
 * POST /api/admin/compliance/stale  { nudge: true }
 *
 * Lists members in compliance-gated CycleEscrows that don't currently
 * hold a valid ComplianceAttestation. POST flips into "nudge" mode: for
 * every stale member with a linked WhatsApp number, send a localized
 * reminder via the central dispatcher.
 *
 * Auth: shared `INTERNAL_NOTIFY_SECRET` / `COMPLIANCE_ISSUANCE_SECRET`
 * via `guardComplianceRequest`.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { guardComplianceRequest } from '../../../../lib/compliance-auth';
import {
  findCurrentCycleEscrow,
  readCycleEscrowState,
  listContributors,
} from '../../../../lib/cycle-escrow-discovery';
import { fetchValidAttestations } from '../../../../lib/compliance-gate';
import { getNetworkConfig } from '../../../../services/network-config';
import { getPooledSuiClient } from '../../../../services/sui-rpc-failover';
import { sendMemberNotification } from '../../../../lib/whatsapp-notifier';
import type { NetworkType } from '../../../../services/whatsapp-registry-service';

interface RequestQuery {
  network?: NetworkType;
  circleIds?: string;
}

interface RequestBody {
  network?: NetworkType;
  circleIds?: string[];
  nudge?: boolean;
}

interface StaleMember {
  circleId: string;
  cycleNo: number;
  memberAddress: string;
  reason: 'no_attestation' | 'expired_attestation' | 'revoked';
  expiresAtMs?: number;
}

const NUDGE_BODY =
  '👋 *Action needed for your njangi circle*\n\n' +
  'Your circle now requires a current KYC check before you can pay your share or collect a payout.\n' +
  'Open the Njangi app, choose a ramp partner, and complete the KYC step. ' +
  'Once it finishes, the app will let you continue automatically.';

async function buildStaleReport(
  network: NetworkType,
  circleIds: string[],
): Promise<StaleMember[]> {
  const client = getPooledSuiClient({
    network,
    rpcUrl: getNetworkConfig(network).rpcUrl,
  });
  const stale: StaleMember[] = [];

  for (const circleId of circleIds) {
    let escrowSummary;
    try {
      escrowSummary = await findCurrentCycleEscrow(client, network, circleId);
    } catch (err) {
      console.warn('[compliance/stale] discovery failed', { circleId, err });
      continue;
    }
    if (!escrowSummary) continue;
    const state = await readCycleEscrowState(escrowSummary.escrowId, network, client);
    if (!state) continue;
    if (!state.requiresAttestation) continue;
    if (state.claimed) continue;

    const contributors = await listContributors(escrowSummary.escrowId, network, client);
    const candidates = new Set<string>();
    for (const member of contributors) candidates.add(member.toLowerCase());
    candidates.add(state.recipient.toLowerCase());

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
        console.warn('[compliance/stale] attestation check failed', { member, err });
      }
    }
  }

  return stale;
}

function parseCircleIds(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith('0x'));
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!(await guardComplianceRequest(req, res, 'stale-attestation'))) return;

  const network: NetworkType =
    (req.method === 'POST'
      ? (req.body as RequestBody).network
      : ((req.query as RequestQuery).network as NetworkType | undefined)) ?? 'testnet';

  const circleIds: string[] =
    req.method === 'POST'
      ? Array.isArray((req.body as RequestBody).circleIds)
        ? ((req.body as RequestBody).circleIds as string[])
        : []
      : parseCircleIds((req.query as RequestQuery).circleIds);

  if (circleIds.length === 0) {
    return res.status(400).json({
      error:
        'circleIds is required (comma-separated query string for GET, array body for POST).',
    });
  }

  try {
    const stale = await buildStaleReport(network, circleIds);
    if (req.method === 'GET') {
      return res.status(200).json({ stale });
    }
    if (req.method !== 'POST' || !(req.body as RequestBody).nudge) {
      return res.status(200).json({ stale });
    }

    let nudged = 0;
    for (const entry of stale) {
      const result = await sendMemberNotification({
        memberAddress: entry.memberAddress,
        network,
        body: NUDGE_BODY,
        kind: 'stale_attestation_admin',
        // Cycle-scoped dedupe: a single member won't be nudged twice for
        // the same round even if the admin re-runs the report.
        dedupeKey: `${entry.circleId}:${entry.cycleNo}`,
        dedupeWindowMs: 12 * 60 * 60 * 1000,
      });
      if (result.sent) nudged += 1;
    }
    return res.status(200).json({ stale, nudged });
  } catch (err) {
    console.error('[compliance/stale] failed', err);
    return res.status(500).json({
      error: err instanceof Error ? err.message : 'Failed to compute stale report',
    });
  }
}
