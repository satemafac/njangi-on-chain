/**
 * GET /api/cron/founding-badges
 *
 * Hourly Vercel cron (vercel.json: `7 * * * *`) that awards the Founding
 * Circle badge. Spec: marketing/handoff/inbox/003-founder-moments-spec/
 * SPEC.md, decisions 1–3 (2026-09-25): badge name "Founding Circle",
 * earned when a circle the member STARTED completes its first full round,
 * and it comes with one month of Premium (src/lib/member-rewards.ts).
 *
 * Source of truth is the chain. `njangi_circles::CyclePaused
 * {circle_id, admin, cycle_completed}` is emitted exactly when the last
 * member of a lap collects (advance_rotation_position_and_cycle). The
 * circle's `admin` is never reassigned in the Move sources, so admin ==
 * creator. "First round" means `cycle_completed` equals the circle's first
 * on-platform cycle: 1 for a native circle, `starting_cycle` for a circle
 * that migrated mid-rotation (CircleMigrationActivated.starting_cycle).
 *
 * Idempotent by construction: member_badges has a UNIQUE (address, type,
 * circle) constraint and member_rewards a UNIQUE (address, source), so a
 * cursor rewind can only ever re-read, never re-award.
 *
 * Infra rules shared with the other crons: Bearer CRON_SECRET compared
 * timing-safe; Postgres required (durable cursor + lease); Sui-first probe
 * so quiet hours never wake Neon; hourly cadence (never below hourly for a
 * DB-touching cron — see the Neon compute-burn incident note in CLAUDE.md).
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { timingSafeEqualStrings } from '../../../lib/timing-safe';
import { isPostgresConfigured } from '../../../lib/pg-pool';
import {
  acquireCycleFinalizedLease,
  drainCycleFinalizedEvents,
  loadCycleFinalizedCursor,
  releaseCycleFinalizedLease,
  saveCycleFinalizedCursor,
  type EventCursor,
  type NotifyOutcome,
} from '../../../lib/cycle-finalized-cron';
import { circleEventCursorKey } from '../../../lib/whatsapp-bot/circle-events';
import {
  getPublishedPackageMetadata,
  normalizePackageId,
} from '../../../lib/circle-chain';
import { getCurrentNetwork, getNetworkConfig } from '../../../services/network-config';
import { getPooledSuiClient } from '../../../services/sui-rpc-failover';
import {
  isForcedFullPassTick,
  probeForRecentEvents,
} from '../../../lib/cron-event-probe';
import { awardBadge } from '../../../lib/member-badges';
import { grantPremiumMonths } from '../../../lib/member-rewards';
import { appLogger } from '../../../utils/logger';

const STREAM_NAME = 'founding_badges';
const MAX_PAGES = 20;
const PREMIUM_MONTHS_FOR_FOUNDERS = 1;

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
}
function str(r: Record<string, unknown>, k: string): string | null {
  const v = r[k];
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
  return null;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    appLogger.error('[cron/founding-badges] CRON_SECRET is not configured');
    return res.status(500).json({ error: 'CRON_SECRET is not configured' });
  }
  if (!timingSafeEqualStrings(req.headers.authorization, `Bearer ${secret}`)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!isPostgresConfigured()) {
    return res.status(500).json({ error: 'DATABASE_URL is required for the founding-badges cron' });
  }

  const network = getCurrentNetwork();
  const overrideId = normalizePackageId(process.env.PACKAGE_ID);
  const definingId = getPublishedPackageMetadata(network).originalId;
  if (overrideId && definingId && overrideId !== definingId) {
    return res.status(500).json({
      error: `PACKAGE_ID (${overrideId}) is not the defining package id for ${network} (${definingId}).`,
    });
  }
  const packageId = overrideId ?? definingId;
  if (!packageId) {
    return res.status(500).json({ error: `No defining package id known for ${network}` });
  }

  const eventType = `${packageId}::njangi_circles::CyclePaused`;
  const migrationEventType = `${packageId}::njangi_circles::CircleMigrationActivated`;
  const client = getPooledSuiClient({ network, rpcUrl: getNetworkConfig(network).rpcUrl });
  const cursorKey = circleEventCursorKey(STREAM_NAME, packageId, network);

  const probe = await probeForRecentEvents({
    client,
    eventType,
    forceFullPass: isForcedFullPassTick(),
  });
  if (!probe.runFullPass) {
    return res.status(200).json({ skipped: 'no_recent_events', network, eventType });
  }

  // Migrated circles start at cycle N+1; a native circle's first round is
  // cycle 1. Built lazily and once per run.
  let startingCycles: Map<string, number> | null = null;
  const startingCycleFor = async (circleId: string): Promise<number> => {
    if (!startingCycles) {
      startingCycles = new Map();
      try {
        let cursor: { txDigest: string; eventSeq: string } | null = null;
        for (let page = 0; page < MAX_PAGES; page += 1) {
          const result = await client.queryEvents({
            query: { MoveEventType: migrationEventType },
            cursor,
            limit: 50,
            order: 'ascending',
          });
          for (const ev of result.data) {
            const r = asRecord(ev.parsedJson);
            const id = r && str(r, 'circle_id');
            const start = r && num(r.starting_cycle);
            if (id && start !== null) startingCycles.set(id.toLowerCase(), start);
          }
          if (!result.hasNextPage || !result.nextCursor) break;
          cursor = { txDigest: result.nextCursor.txDigest, eventSeq: String(result.nextCursor.eventSeq) };
        }
      } catch (err) {
        // If migration history cannot be read, treat every circle as native.
        // A migrated circle then earns on `cycle_completed == 1`, which for
        // it never happens, i.e. we under-award rather than over-award.
        appLogger.warn('[cron/founding-badges] could not read migration events', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return startingCycles.get(circleId.toLowerCase()) ?? 1;
  };

  const leaseToken = await acquireCycleFinalizedLease(cursorKey);
  if (!leaseToken) {
    return res.status(200).json({ skipped: 'already_running', network, eventType });
  }

  let awarded = 0;
  try {
    const initialCursor = await loadCycleFinalizedCursor(cursorKey);
    const result = await drainCycleFinalizedEvents(initialCursor, {
      maxPages: MAX_PAGES,
      queryPage: async (cursor: EventCursor | null) => {
        const page = await client.queryEvents({
          query: { MoveEventType: eventType },
          cursor: cursor ?? null,
          limit: 50,
          order: 'ascending',
        });
        return {
          data: page.data.map((event) => ({
            id: { txDigest: event.id.txDigest, eventSeq: String(event.id.eventSeq) },
            parsedJson: event.parsedJson,
            timestampMs: event.timestampMs ?? null,
          })),
          nextCursor: page.nextCursor
            ? { txDigest: page.nextCursor.txDigest, eventSeq: String(page.nextCursor.eventSeq) }
            : null,
          hasNextPage: page.hasNextPage,
        };
      },
      notify: async (event): Promise<NotifyOutcome> => {
        const r = asRecord(event.parsedJson);
        const circleId = r && str(r, 'circle_id');
        const admin = r && str(r, 'admin');
        const completed = r && num(r.cycle_completed);
        if (!circleId || !admin || completed === null) return 'skipped';
        if (completed !== (await startingCycleFor(circleId))) return 'skipped';
        try {
          const badge = await awardBadge({
            userAddress: admin,
            badgeType: 'founding_circle',
            circleId,
            sourceTx: event.id.txDigest,
          });
          // The reward is granted even when the badge already existed: both
          // writes are idempotent on their own keys, so a tick that awarded
          // the badge and then failed on the grant (as the first prod tick
          // did on 2026-09-25) is repaired by the next tick instead of
          // leaving the member with a badge and no Premium month.
          const reward = await grantPremiumMonths({
            userAddress: admin,
            months: PREMIUM_MONTHS_FOR_FOUNDERS,
            source: `founding_circle:${circleId.toLowerCase()}`,
          });
          if (!badge && !reward) return 'skipped'; // full idempotent replay
          awarded += 1;
          return 'sent';
        } catch (err) {
          // Postgres trouble: do not advance past this event.
          appLogger.error('[cron/founding-badges] award failed', {
            circleId,
            error: err instanceof Error ? err.message : String(err),
          });
          return 'halt';
        }
      },
      persistCursor: (cursor: EventCursor) => saveCycleFinalizedCursor(cursorKey, cursor, leaseToken),
    });
    return res.status(result.halted ? 500 : 200).json({
      network,
      eventType,
      pages: result.pages,
      processed: result.processed,
      awarded,
      skipped: result.skipped,
      halted: result.halted,
    });
  } catch (error) {
    appLogger.error('[cron/founding-badges] run failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return res.status(500).json({ error: error instanceof Error ? error.message : 'cron run failed' });
  } finally {
    await releaseCycleFinalizedLease(cursorKey, leaseToken).catch(() => undefined);
  }
}
