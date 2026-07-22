/**
 * GET /api/cron/cycle-finalized
 *
 * Vercel cron (vercel.json: every minute) replacing the long-running
 * Heroku `notifier` worker (scripts/cycle-finalized-notifier.mjs, now
 * deprecated). One invocation = one full drain: query CycleFinalized
 * events after the persisted cursor (ascending, paged via nextCursor),
 * send the "your turn" WhatsApp nudge to each payout recipient
 * in-process via sendYourTurnNotification, and persist the NEWEST
 * processed cursor to the `cycle_finalized_cursor` Postgres table after
 * every page.
 *
 * Auth: `Authorization: Bearer ${CRON_SECRET}`. Vercel attaches this
 * header to cron invocations automatically when the CRON_SECRET env var
 * is set on the project. Compared with the timing-safe helper — never a
 * plain `===`.
 *
 * Overlap: Vercel does NOT prevent concurrent cron executions — a backlog
 * drain running near the 60s maxDuration overlaps the next minute's tick.
 * Each run must first win the Postgres lease on the cursor row
 * (acquireCycleFinalizedLease); the loser returns 200
 * `{ skipped: 'already_running' }` immediately. Cursor writes are fenced
 * by the lease token, so even a zombie run that outlives its lease cannot
 * regress the cursor. The lease is released in `finally`; if the lambda is
 * hard-killed it simply expires (90s TTL > 60s maxDuration).
 *
 * Failure contract: infra/config problems (RPC down, Postgres down,
 * WhatsApp credentials missing) halt the drain WITHOUT advancing the
 * cursor past the failing event and return 500, so the next minute's run
 * retries. The dispatcher settles its dedupe claim BEFORE such an error
 * propagates (see sendMemberNotification), so the retry re-claims the
 * tuple and actually sends — it is never deduped against a stale
 * 'in_flight' marker left by the halted run. Per-recipient send failures
 * advance the cursor — they are recorded with success=false in the
 * whatsapp_notifications audit table and must not wedge the pipeline
 * (same best-effort contract as the ramp KYC WhatsApp confirmations).
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { timingSafeEqualStrings } from '../../../lib/timing-safe';
import { isPostgresConfigured } from '../../../lib/pg-pool';
import {
  acquireCycleFinalizedLease,
  cycleFinalizedCursorKey,
  drainCycleFinalizedEvents,
  formatCoinAmount,
  loadCycleFinalizedCursor,
  parseCycleFinalizedEvent,
  releaseCycleFinalizedLease,
  saveCycleFinalizedCursor,
  type EventCursor,
  type NotifyOutcome,
} from '../../../lib/cycle-finalized-cron';
import { sendYourTurnNotification } from '../../../lib/your-turn-notification';
import {
  getPublishedPackageMetadata,
  normalizePackageId,
} from '../../../lib/circle-chain';
import { getCurrentNetwork, getNetworkConfig } from '../../../services/network-config';
import { getPooledSuiClient } from '../../../services/sui-rpc-failover';
import {
  isHourlyFullPassTick,
  probeForRecentEvents,
} from '../../../lib/cron-event-probe';
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
    appLogger.error('[cron/cycle-finalized] CRON_SECRET is not configured');
    return res.status(500).json({ error: 'CRON_SECRET is not configured' });
  }
  if (!timingSafeEqualStrings(req.headers.authorization, `Bearer ${secret}`)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!isPostgresConfigured()) {
    // The cursor must be durable; a serverless instance has no filesystem
    // worth trusting. Refuse to run rather than re-notify from genesis.
    return res.status(500).json({ error: 'DATABASE_URL is required for the cycle-finalized cron' });
  }

  const network = getCurrentNetwork();
  // Sui event type tags use the DEFINING package id (the original publish),
  // not the latest upgrade id — filtering on `published-at` after an
  // upgrade silently matches nothing.
  const overrideId = normalizePackageId(process.env.PACKAGE_ID);
  const definingId = getPublishedPackageMetadata(network).originalId;
  if (overrideId && definingId && overrideId !== definingId) {
    // An ops engineer mirroring the legacy Heroku env will likely set
    // PACKAGE_ID to the latest upgrade id — which matches zero events,
    // forever, with no error. Refuse loudly instead of polling nothing.
    appLogger.error('[cron/cycle-finalized] PACKAGE_ID differs from the defining package id', {
      overrideId,
      definingId,
      network,
    });
    return res.status(500).json({
      error:
        `PACKAGE_ID (${overrideId}) is not the defining package id for ${network} ` +
        `(${definingId}). Event type tags use the ORIGINAL publish id; unset ` +
        `PACKAGE_ID to use the built-in id, or set it to the original id.`,
    });
  }
  const packageId = overrideId ?? definingId;
  if (!packageId) {
    return res.status(500).json({ error: `No defining package id known for ${network}` });
  }

  const eventType = `${packageId}::njangi_cycle_escrow::CycleFinalized`;
  const coinDecimals = Number(process.env.COIN_DECIMALS ?? 9);
  const coinSymbol = process.env.COIN_SYMBOL ?? 'SUI';
  // Events older than this advance the cursor without a nudge (default 24h).
  const maxEventAgeMs = Number(
    process.env.CYCLE_FINALIZED_MAX_EVENT_AGE_MS ?? 24 * 60 * 60 * 1000,
  );
  const client = getPooledSuiClient({
    network,
    rpcUrl: getNetworkConfig(network).rpcUrl,
  });

  // The event carries escrow_id (no circle_id); resolve the parent circle
  // from the escrow object for a recognizable message + stable dedupe key,
  // falling back to the escrow id when the read fails.
  const circleByEscrow = new Map<string, string | null>();
  const resolveCircleId = async (escrowId: string): Promise<string | null> => {
    if (circleByEscrow.has(escrowId)) return circleByEscrow.get(escrowId) ?? null;
    let circleId: string | null = null;
    try {
      const obj = await client.getObject({ id: escrowId, options: { showContent: true } });
      const content = obj.data?.content;
      if (content && content.dataType === 'moveObject') {
        const fields = (content as { fields?: Record<string, unknown> }).fields;
        if (typeof fields?.circle_id === 'string') {
          circleId = fields.circle_id;
        }
      }
    } catch (err) {
      appLogger.warn('[cron/cycle-finalized] failed to resolve circle for escrow', {
        escrowId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    circleByEscrow.set(escrowId, circleId);
    return circleId;
  };

  const cursorKey = cycleFinalizedCursorKey(packageId, network);

  // Sui-first probe (no Postgres): skip the lease + cursor machinery when
  // nothing recent exists on-chain, so Neon can autosuspend between quiet
  // ticks. The first tick of each hour forces a full pass regardless, so
  // the cursor can never stall behind this early-exit.
  const probe = await probeForRecentEvents({
    client,
    eventType,
    forceFullPass: isHourlyFullPassTick(),
  });
  if (!probe.runFullPass) {
    return res.status(200).json({
      skipped: 'no_recent_events',
      network,
      eventType,
      newestEventMs: probe.newestEventMs,
    });
  }

  try {
    // Single-flight: atomically claim the run lease before reading the
    // cursor. Without this, a long backlog drain (~60s) overlaps the next
    // minute's tick — both runs load the same cursor and double-send.
    const leaseToken = await acquireCycleFinalizedLease(cursorKey);
    if (!leaseToken) {
      appLogger.info(
        '[cron/cycle-finalized] another invocation holds the run lease; skipping',
        { cursorKey },
      );
      return res.status(200).json({ skipped: 'already_running', network, eventType });
    }

    try {
      return await runDrain(res, {
        client,
        cursorKey,
        leaseToken,
        network,
        eventType,
        coinDecimals,
        coinSymbol,
        maxEventAgeMs,
        resolveCircleId,
      });
    } finally {
      await releaseCycleFinalizedLease(cursorKey, leaseToken).catch((err) => {
        // Best-effort: an unreleased lease self-expires after the TTL.
        appLogger.warn('[cron/cycle-finalized] failed to release run lease', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  } catch (error) {
    appLogger.error('[cron/cycle-finalized] run failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'cron run failed',
    });
  }
}

interface RunDrainContext {
  client: ReturnType<typeof getPooledSuiClient>;
  cursorKey: string;
  leaseToken: string;
  network: ReturnType<typeof getCurrentNetwork>;
  eventType: string;
  coinDecimals: number;
  coinSymbol: string;
  maxEventAgeMs: number;
  resolveCircleId: (escrowId: string) => Promise<string | null>;
}

/**
 * The drain body, run while holding the lease. Throws on infra errors —
 * the caller's catch maps them to a 500 and its finally releases the lease.
 */
async function runDrain(res: NextApiResponse, ctx: RunDrainContext) {
  const {
    client,
    cursorKey,
    leaseToken,
    network,
    eventType,
    coinDecimals,
    coinSymbol,
    maxEventAgeMs,
    resolveCircleId,
  } = ctx;

  const initialCursor = await loadCycleFinalizedCursor(cursorKey);

  const result = await drainCycleFinalizedEvents(initialCursor, {
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
          ? {
              txDigest: page.nextCursor.txDigest,
              eventSeq: String(page.nextCursor.eventSeq),
            }
          : null,
        hasNextPage: page.hasNextPage,
      };
    },
    notify: async (event): Promise<NotifyOutcome> => {
      const parsed = parseCycleFinalizedEvent(event.parsedJson);
      if (!parsed) {
        appLogger.warn('[cron/cycle-finalized] skipping malformed event', {
          txDigest: event.id.txDigest,
          eventSeq: event.id.eventSeq,
        });
        return 'skipped';
      }

      // A fresh cursor (new DB, cutover) drains the event stream from
      // genesis; a long outage drains weeks at once. "Your payout is
      // ready" is wrong and confusing for cycles collected long ago, so
      // anything older than the age cap advances the cursor without a
      // send. Events without a chain timestamp are treated as fresh.
      const eventAgeMs = event.timestampMs ? Date.now() - Number(event.timestampMs) : 0;
      if (eventAgeMs > maxEventAgeMs) {
        appLogger.info('[cron/cycle-finalized] skipping stale event', {
          txDigest: event.id.txDigest,
          ageHours: Math.round(eventAgeMs / 3_600_000),
        });
        return 'skipped';
      }

      const circleId = (await resolveCircleId(parsed.escrowId)) ?? parsed.escrowId;
      const sendResult = await sendYourTurnNotification({
        circleId,
        cycleNo: parsed.cycleNo,
        amount: formatCoinAmount(parsed.amount, coinDecimals, coinSymbol),
        recipient: parsed.recipient,
        network,
        // Keyed by escrow id, NOT the resolved circle id: resolveCircleId
        // falls back to the escrow id on a failed read, and a key that
        // flaps between identities across retries can dedupe-miss and
        // double-send. The escrow id is stable and always available.
        dedupeKey: `${parsed.escrowId}:${parsed.cycleNo}`,
      });

      if (sendResult.sent) {
        appLogger.info('[cron/cycle-finalized] nudged recipient', {
          circleId,
          cycleNo: parsed.cycleNo,
        });
        return 'sent';
      }
      if (sendResult.reason === 'missing_credentials') {
        // Config problem affecting every event — retry the whole batch
        // next run instead of silently dropping nudges.
        appLogger.error('[cron/cycle-finalized] WhatsApp credentials missing; halting');
        return 'halt';
      }
      if (sendResult.reason === 'send_failed') {
        appLogger.warn('[cron/cycle-finalized] send failed (recorded, advancing)', {
          circleId,
          cycleNo: parsed.cycleNo,
        });
        return 'failed';
      }
      // 'no_link' (member opted out of WhatsApp) or 'duplicate'.
      return 'skipped';
    },
    // Fenced by the lease token: a zombie run that lost its lease throws
    // here instead of regressing the cursor (see saveCycleFinalizedCursor).
    persistCursor: (cursor: EventCursor) =>
      saveCycleFinalizedCursor(cursorKey, cursor, leaseToken),
  });

  const summary = {
    network,
    eventType,
    pages: result.pages,
    processed: result.processed,
    sent: result.sent,
    skipped: result.skipped,
    failed: result.failed,
    halted: result.halted,
    cursor: result.finalCursor,
  };
  if (result.halted) {
    // 500 keeps the failure visible in Vercel cron logs/alerts; the
    // cursor was not advanced past the failing event, so the next run
    // picks it back up.
    return res.status(500).json({ error: 'drain halted', ...summary });
  }
  return res.status(200).json(summary);
}
