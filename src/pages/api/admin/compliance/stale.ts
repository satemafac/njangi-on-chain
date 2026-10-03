/**
 * GET  /api/admin/compliance/stale
 * POST /api/admin/compliance/stale  { nudge: true }
 *
 * Lists members in compliance-gated CycleEscrows that don't currently
 * hold a valid ComplianceAttestation. POST flips into "nudge" mode: for
 * every stale member with a linked WhatsApp number, send a localized
 * reminder via the central dispatcher.
 *
 * Returns `{ stale, unchecked, nudged? }`. `unchecked` lists the circles
 * whose reads failed: their members are unknown, so an empty `stale` with
 * a non-empty `unchecked` is not "nobody is blocked".
 *
 * Auth: shared `COMPLIANCE_ISSUANCE_SECRET`
 * via `guardComplianceRequest`.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { guardComplianceRequest } from '../../../../lib/compliance-auth';
import { buildStaleReport, nudgeStaleMembers } from '../../../../lib/attestation-stale';
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
    const { stale, unchecked } = await buildStaleReport(network, circleIds);
    if (req.method === 'GET') {
      return res.status(200).json({ stale, unchecked });
    }
    if (req.method !== 'POST' || !(req.body as RequestBody).nudge) {
      return res.status(200).json({ stale, unchecked });
    }

    const nudged = await nudgeStaleMembers(network, stale);
    return res.status(200).json({ stale, unchecked, nudged });
  } catch (err) {
    console.error('[compliance/stale] failed', err);
    return res.status(500).json({
      error: err instanceof Error ? err.message : 'Failed to compute stale report',
    });
  }
}
