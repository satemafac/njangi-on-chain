/**
 * GET /api/cron/walrus-renewal
 *
 * Vercel cron (vercel.json: daily at 03:00 UTC, '0 3 * * *') that keeps
 * WhatsApp PII blobs alive past their Walrus storage lease. walrus-pii.ts
 * stores each encrypted envelope for WALRUS_STORAGE_EPOCHS (default 5)
 * epochs, but the on-chain `whatsapp_integration` anchors and the
 * `whatsapp_phone_index` rows that reference those blobs live forever — so
 * a lapsed lease silently breaks a circle's WhatsApp link on a timer (June
 * 2026 GTM audit, HIGH).
 *
 * One invocation: enumerate every active link from the authoritative
 * Postgres index, learn the current Sui epoch, and re-store any blob within
 * RENEWAL_THRESHOLD_EPOCHS (default 2) of its recorded end epoch. Re-storing
 * fetches + decrypts with the CURRENT master key and re-encrypts before
 * upload, so a renewal doubles as key-rotation-by-renewal. The renewed
 * (blob id, end epoch) is written back to the index row via a compare-and-
 * set + audit row in one transaction.
 *
 * The on-chain anchor keeps the OLD blob id — the index is authoritative
 * for webhook routing (it resolves the index FIRST, falling back to the
 * registry scan), so updating the index keeps links alive without a
 * signature. On-chain re-anchoring is a future admin-signed step (the cron
 * is non-custodial and has no signing authority).
 *
 * Auth: `Authorization: Bearer ${CRON_SECRET}` (timing-safe compare), same
 * as the other crons. Overlap protection reuses the cycle-finalized fenced
 * lease machinery (the `cycle_finalized_cursor` table is a stream-agnostic
 * lease store): a single per-network lease, so two overlapping daily ticks
 * skip rather than both draining. The lease is released in `finally`; if the
 * lambda is hard-killed it self-expires (90s TTL). Renewal is additionally
 * idempotent at the row level via applyWalrusRenewal's compare-and-set, so
 * even concurrent runs cannot double-advance a row.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { timingSafeEqualStrings } from '../../../lib/timing-safe';
import { isPostgresConfigured } from '../../../lib/pg-pool';
import {
  acquireCycleFinalizedLease,
  releaseCycleFinalizedLease,
} from '../../../lib/cycle-finalized-cron';
import {
  applyWalrusRenewal,
  listActiveLinksForRenewal,
} from '../../../lib/whatsapp-link-index';
import { restorePiiBlob } from '../../../lib/walrus-pii';
import {
  DEFAULT_RENEWAL_THRESHOLD_EPOCHS,
  runWalrusRenewal,
} from '../../../lib/walrus-renewal';
import { getCurrentNetwork, getNetworkConfig } from '../../../services/network-config';
import { getPooledSuiClient } from '../../../services/sui-rpc-failover';
import { appLogger } from '../../../utils/logger';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Vercel invokes crons with GET.
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const secret = process.env.CRON_SECRET;
  if (!secret) {
    // Fail closed: without the secret we cannot distinguish Vercel's cron
    // scheduler from an arbitrary caller.
    appLogger.error('[cron/walrus-renewal] CRON_SECRET is not configured');
    return res.status(500).json({ error: 'CRON_SECRET is not configured' });
  }
  if (!timingSafeEqualStrings(req.headers.authorization, `Bearer ${secret}`)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!isPostgresConfigured()) {
    // The index is the authoritative source of links to renew; without it
    // we have nothing to enumerate. Refuse rather than renew nothing.
    return res
      .status(500)
      .json({ error: 'DATABASE_URL is required for the walrus-renewal cron' });
  }

  const network = getCurrentNetwork();
  const threshold = Number(
    process.env.RENEWAL_THRESHOLD_EPOCHS ?? DEFAULT_RENEWAL_THRESHOLD_EPOCHS,
  );
  const thresholdEpochs =
    Number.isFinite(threshold) && threshold >= 0
      ? threshold
      : DEFAULT_RENEWAL_THRESHOLD_EPOCHS;

  const leaseKey = `walrus-renewal:${network}`;

  try {
    // Single-flight: one daily tick (or a manual re-run) at a time.
    const leaseToken = await acquireCycleFinalizedLease(leaseKey);
    if (!leaseToken) {
      appLogger.info('[cron/walrus-renewal] another invocation holds the lease; skipping', {
        leaseKey,
      });
      return res.status(200).json({ skipped: 'already_running', network });
    }

    try {
      const client = getPooledSuiClient({
        network,
        rpcUrl: getNetworkConfig(network).rpcUrl,
      });

      const result = await runWalrusRenewal({
        thresholdEpochs,
        listActiveLinks: listActiveLinksForRenewal,
        getCurrentEpoch: async () => {
          const state = await client.getLatestSuiSystemState();
          return Number(state.epoch);
        },
        restoreBlob: async (blobId: string) => {
          const { newBlobId, newEndEpoch } = await restorePiiBlob(blobId);
          if (newEndEpoch === null) {
            // Without a fresh end epoch we'd renew this row again every
            // single day (NULL → "expiry unknown"). Surface it as a failure
            // so it's visible in cron logs rather than churning silently.
            throw new Error(
              `Walrus publisher returned no end epoch for re-stored blob ${newBlobId}`,
            );
          }
          return { newBlobId, newEndEpoch };
        },
        applyRenewal: applyWalrusRenewal,
      });

      const summary = { network, thresholdEpochs, ...result };
      appLogger.info('[cron/walrus-renewal] run complete', summary);
      return res.status(200).json(summary);
    } finally {
      await releaseCycleFinalizedLease(leaseKey, leaseToken).catch((err) => {
        // Best-effort: an unreleased lease self-expires after the TTL.
        appLogger.warn('[cron/walrus-renewal] failed to release lease', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  } catch (error) {
    appLogger.error('[cron/walrus-renewal] run failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'cron run failed',
    });
  }
}
