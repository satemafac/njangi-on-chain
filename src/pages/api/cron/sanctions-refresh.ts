/**
 * GET /api/cron/sanctions-refresh
 *
 * Vercel cron (vercel.json: weekly Monday 06:00 UTC, '0 6 * * 1') that
 * refreshes the cached OFAC SDN digital-currency address set from
 * treasury.gov and then retro-sweeps recent screening decisions against
 * the fresh list (detect-and-respond compensation for the fail-open
 * screen — see src/lib/sanctions.ts and docs/sanctions-program.md).
 *
 * Bootstrap: the first population after a deploy is this same endpoint
 * invoked manually —
 *   curl -H "Authorization: Bearer $CRON_SECRET" https://<host>/api/cron/sanctions-refresh
 * (documented in docs/sanctions-program.md). Idempotent: a content-hash
 * match short-circuits without writes.
 *
 * Auth: `Authorization: Bearer ${CRON_SECRET}` (timing-safe), same as the
 * other crons. Overlap protection reuses the cycle-finalized fenced lease
 * under key 'sanctions-refresh'.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { timingSafeEqualStrings } from '../../../lib/timing-safe';
import { isPostgresConfigured } from '../../../lib/pg-pool';
import {
  acquireCycleFinalizedLease,
  releaseCycleFinalizedLease,
} from '../../../lib/cycle-finalized-cron';
import { refreshSanctionsList, retroSweepRecentScreens } from '../../../lib/sanctions';
import { appLogger } from '../../../utils/logger';

const LEASE_KEY = 'sanctions-refresh';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const secret = process.env.CRON_SECRET;
  if (!secret) {
    appLogger.error('[cron/sanctions-refresh] CRON_SECRET is not configured');
    return res.status(500).json({ error: 'CRON_SECRET is not configured' });
  }
  if (!timingSafeEqualStrings(req.headers.authorization, `Bearer ${secret}`)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!isPostgresConfigured()) {
    // Without Postgres there is nowhere to store the list — surface this
    // loudly rather than pretending the program ran.
    appLogger.error('[cron/sanctions-refresh] DATABASE_URL is not configured');
    return res.status(500).json({ error: 'Postgres is required for the sanctions list' });
  }

  const leaseToken = await acquireCycleFinalizedLease(LEASE_KEY);
  if (!leaseToken) {
    return res.status(200).json({ ok: true, skipped: 'lease_held' });
  }

  try {
    const refresh = await refreshSanctionsList();
    const sweep = await retroSweepRecentScreens(30);

    if (sweep.hits > 0) {
      appLogger.error(
        `[cron/sanctions-refresh] retro-sweep found ${sweep.hits} previously-passed address(es) now listed — follow docs/incident-playbook.md`,
      );
    }

    return res.status(200).json({
      ok: true,
      listVersion: refresh.listVersion,
      addressCount: refresh.count,
      skippedRefresh: refresh.skipped,
      retroSweepHits: sweep.hits,
    });
  } catch (err) {
    appLogger.error('[cron/sanctions-refresh] refresh failed (last-good list retained)', err);
    return res.status(500).json({
      error: err instanceof Error ? err.message : 'sanctions refresh failed',
    });
  } finally {
    await releaseCycleFinalizedLease(LEASE_KEY, leaseToken).catch(() => {});
  }
}
