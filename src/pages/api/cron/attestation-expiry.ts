/**
 * GET /api/cron/attestation-expiry
 *
 * Vercel cron (vercel.json: daily 08:00 UTC, '0 8 * * *') that auto-nudges
 * members of compliance-gated circles who lack a valid ComplianceAttestation.
 * Previously an operator had to open /admin/compliance and hand-enter circle
 * ids to run the same sweep; an attestation that expires mid-cycle silently
 * blocks a member from contributing or collecting until someone notices, so
 * this makes the reminder automatic.
 *
 * One invocation: discover attestation-gated circles from `CycleEscrowOpened`
 * events -> build the stale-member report -> WhatsApp-nudge each stale member
 * (dedupe is (circle, cycle)-scoped inside nudgeStaleMembers, so overlapping
 * runs never double-ping). Shared implementation with the admin console via
 * src/lib/attestation-stale.ts.
 *
 * Auth: `Authorization: Bearer ${CRON_SECRET}` (timing-safe), same as the
 * other crons. Overlap protection reuses the cycle-finalized fenced lease
 * (the cursor table is a stream-agnostic lease store) under key
 * 'attestation-expiry': two overlapping ticks skip rather than both sweeping.
 * The lease is released in `finally`; a hard-killed lambda self-expires
 * (90s TTL). If Postgres is not configured the lease is skipped and the sweep
 * still runs (nudge dedupe then relies on the in-memory notifier store).
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { timingSafeEqualStrings } from '../../../lib/timing-safe';
import { isPostgresConfigured } from '../../../lib/pg-pool';
import {
  acquireCycleFinalizedLease,
  releaseCycleFinalizedLease,
} from '../../../lib/cycle-finalized-cron';
import {
  discoverGatedCircleIds,
  buildStaleReport,
  nudgeStaleMembers,
} from '../../../lib/attestation-stale';
import { getCurrentNetwork } from '../../../services/network-config';
import { appLogger } from '../../../utils/logger';

const LEASE_KEY = 'attestation-expiry';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const secret = process.env.CRON_SECRET;
  if (!secret) {
    appLogger.error('[cron/attestation-expiry] CRON_SECRET is not configured');
    return res.status(500).json({ error: 'CRON_SECRET is not configured' });
  }
  if (!timingSafeEqualStrings(req.headers.authorization, `Bearer ${secret}`)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const network = getCurrentNetwork();

  // Fenced lease so two overlapping ticks don't both sweep. When Postgres
  // isn't configured we can't lease — run anyway (dedupe still applies).
  let leaseToken: string | null = null;
  if (isPostgresConfigured()) {
    leaseToken = await acquireCycleFinalizedLease(LEASE_KEY);
    if (!leaseToken) {
      return res.status(200).json({ ok: true, skipped: 'lease_held' });
    }
  }

  try {
    const gatedCircles = await discoverGatedCircleIds(network);
    if (gatedCircles.length === 0) {
      return res
        .status(200)
        .json({ ok: true, network, gatedCircles: 0, staleCount: 0, nudged: 0 });
    }

    const stale = await buildStaleReport(network, gatedCircles);
    const nudged = await nudgeStaleMembers(network, stale);

    return res.status(200).json({
      ok: true,
      network,
      gatedCircles: gatedCircles.length,
      staleCount: stale.length,
      nudged,
    });
  } catch (err) {
    appLogger.error('[cron/attestation-expiry] sweep failed', err);
    return res.status(500).json({
      error: err instanceof Error ? err.message : 'attestation-expiry sweep failed',
    });
  } finally {
    if (leaseToken) {
      await releaseCycleFinalizedLease(LEASE_KEY, leaseToken).catch(() => {});
    }
  }
}
