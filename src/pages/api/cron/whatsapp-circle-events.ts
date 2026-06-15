/**
 * GET /api/cron/whatsapp-circle-events
 *
 * Vercel cron (vercel.json: every minute) replacing the retired
 * whatsapp-bot-backend's CircleLinkListenerService — a 5-second polling
 * daemon on :3001 that was unreachable in the deploy layout (June 2026
 * ops-readiness audit) and parsed a registry schema that no longer exists
 * on chain. See whatsapp-bot-backend/DEPRECATED.md for the full mapping.
 *
 * One invocation drains every stream in CIRCLE_EVENT_STREAMS (circle
 * linked/unlinked, member joined/removed, security deposits, cycle
 * contributions, rotation changes, activation, legacy payouts). Each
 * stream has its own durable cursor + run lease row in the shared
 * `cycle_finalized_cursor` table (same fenced-lease machinery as
 * /api/cron/cycle-finalized — the key is namespaced, the schema is
 * stream-agnostic), so overlapping invocations skip per stream and a
 * zombie run can never regress a cursor it no longer owns.
 *
 * Sends route through sendMemberNotification (the single Graph API
 * client) with the circle's linked phone resolved via Postgres index →
 * Walrus decrypt → on-chain registry fallback. Audit rows land in
 * whatsapp_notifications with kind 'circle_event', target = circle id,
 * dedupe key = stream:txDigest:eventSeq.
 *
 * Auth: `Authorization: Bearer ${CRON_SECRET}` (timing-safe compare).
 * Failure contract mirrors cycle-finalized: per-recipient send failures
 * advance (recorded success=false); infra/config failures halt the
 * affected stream without advancing its cursor and surface as 500.
 * Events older than WHATSAPP_EVENTS_MAX_EVENT_AGE_MS (default 24h)
 * advance without a send — a fresh cursor drains from genesis and must
 * not replay months of notifications at cutover.
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
import {
  CIRCLE_EVENT_STREAMS,
  circleEventCursorKey,
  circleEventDedupeKey,
  type CircleEventStream,
  type CircleEventMessageContext,
} from '../../../lib/whatsapp-bot/circle-events';
import {
  resolveCircleName,
  resolveCirclePhone,
} from '../../../lib/whatsapp-bot/circle-phone';
import { sendMemberNotification } from '../../../lib/whatsapp-notifier';
import { getPublishedPackageMetadata } from '../../../lib/circle-chain';
import {
  getCurrentNetwork,
  getNetworkConfig,
  getWhatsAppConfigForNetwork,
} from '../../../services/network-config';
import { getActiveWhatsAppRegistries } from '../../../services/whatsapp-registry-service';
import { getPooledSuiClient } from '../../../services/sui-rpc-failover';
import joinRequestDatabase from '../../../services/join-request-database';
import { appLogger } from '../../../utils/logger';

const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Pages per stream per run — bounds total run time across all streams. */
const MAX_PAGES_PER_STREAM = 5;

interface StreamSummary {
  stream: string;
  eventType: string;
  pages: number;
  processed: number;
  sent: number;
  skipped: number;
  failed: number;
  halted: boolean;
  skippedReason?: string;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const secret = process.env.CRON_SECRET;
  if (!secret) {
    appLogger.error('[cron/whatsapp-circle-events] CRON_SECRET is not configured');
    return res.status(500).json({ error: 'CRON_SECRET is not configured' });
  }
  if (!timingSafeEqualStrings(req.headers.authorization, `Bearer ${secret}`)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!isPostgresConfigured()) {
    return res.status(500).json({
      error: 'DATABASE_URL is required for the whatsapp-circle-events cron',
    });
  }

  const network = getCurrentNetwork();
  // Event type tags use the DEFINING package id (original publish), not
  // the latest upgrade id — same footgun the cycle-finalized cron guards.
  const corePackageId = getPublishedPackageMetadata(network).originalId;
  if (!corePackageId) {
    return res.status(500).json({ error: `No defining package id known for ${network}` });
  }

  const client = getPooledSuiClient({
    network,
    rpcUrl: getNetworkConfig(network).rpcUrl,
  });

  const maxEventAgeMs = Number(
    process.env.WHATSAPP_EVENTS_MAX_EVENT_AGE_MS ?? DEDUPE_WINDOW_MS,
  );
  const appBaseUrl = process.env.FRONTEND_URL || 'https://njangionchain.com';

  // The whatsapp_integration module's defining package: derive it from the
  // registry object's TYPE (robust across republish cycles where the env
  // var lags), falling back to the configured whatsapp package id.
  let whatsappPackageId: string | null = null;
  try {
    const registryId = getActiveWhatsAppRegistries(network)?.[0]?.registryObjectId;
    if (registryId) {
      const registryObject = await client.getObject({
        id: registryId,
        options: { showType: true },
      });
      const typeTag = registryObject.data?.type;
      const prefix = typeof typeTag === 'string' ? typeTag.split('::')[0] : '';
      if (prefix.startsWith('0x')) whatsappPackageId = prefix;
    }
  } catch (err) {
    appLogger.warn('[cron/whatsapp-circle-events] registry type discovery failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  if (!whatsappPackageId) {
    const configured = getWhatsAppConfigForNetwork(network).packageId;
    whatsappPackageId = configured && configured.startsWith('0x') ? configured : null;
  }

  // Per-run caches: one circle is usually the subject of several events in
  // a drain (e.g. N contributions), so resolve phone/name once each.
  const phoneCache = new Map<string, string | null>();
  const nameCache = new Map<string, string>();

  const summaries: StreamSummary[] = [];

  try {
    for (const stream of CIRCLE_EVENT_STREAMS) {
      const definingId = stream.source === 'whatsapp' ? whatsappPackageId : corePackageId;
      if (!definingId) {
        summaries.push({
          stream: stream.name,
          eventType: '<unresolved package id>',
          pages: 0,
          processed: 0,
          sent: 0,
          skipped: 0,
          failed: 0,
          halted: false,
          skippedReason: 'no_package_id',
        });
        continue;
      }

      summaries.push(
        await drainStream(stream, definingId, {
          client,
          network,
          maxEventAgeMs,
          appBaseUrl,
          phoneCache,
          nameCache,
        }),
      );
    }
  } catch (error) {
    appLogger.error('[cron/whatsapp-circle-events] run failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'cron run failed',
      streams: summaries,
    });
  }

  const halted = summaries.some((s) => s.halted);
  const totals = summaries.reduce(
    (acc, s) => ({
      processed: acc.processed + s.processed,
      sent: acc.sent + s.sent,
      skipped: acc.skipped + s.skipped,
      failed: acc.failed + s.failed,
    }),
    { processed: 0, sent: 0, skipped: 0, failed: 0 },
  );

  const body = { network, halted, ...totals, streams: summaries };
  // 500 keeps halted streams visible in Vercel cron logs; their cursors
  // were not advanced past the failing event, so the next run retries.
  return res.status(halted ? 500 : 200).json(body);
}

interface DrainStreamContext {
  client: ReturnType<typeof getPooledSuiClient>;
  network: ReturnType<typeof getCurrentNetwork>;
  maxEventAgeMs: number;
  appBaseUrl: string;
  phoneCache: Map<string, string | null>;
  nameCache: Map<string, string>;
}

async function drainStream(
  stream: CircleEventStream,
  definingPackageId: string,
  ctx: DrainStreamContext,
): Promise<StreamSummary> {
  const eventType = stream.eventType(definingPackageId);
  const cursorKey = circleEventCursorKey(stream.name, definingPackageId, ctx.network);

  const base: StreamSummary = {
    stream: stream.name,
    eventType,
    pages: 0,
    processed: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
    halted: false,
  };

  // Per-stream single-flight: the loser of the lease skips THIS stream
  // only (a backlog drain on one stream must not block the others).
  const leaseToken = await acquireCycleFinalizedLease(cursorKey);
  if (!leaseToken) {
    return { ...base, skippedReason: 'already_running' };
  }

  try {
    const initialCursor = await loadCycleFinalizedCursor(cursorKey);
    const result = await drainCycleFinalizedEvents(initialCursor, {
      maxPages: MAX_PAGES_PER_STREAM,
      queryPage: async (cursor: EventCursor | null) => {
        const page = await ctx.client.queryEvents({
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
      notify: (event) => notifyCircleEvent(stream, event, ctx),
      persistCursor: (cursor: EventCursor) =>
        saveCycleFinalizedCursor(cursorKey, cursor, leaseToken),
    });

    return {
      ...base,
      pages: result.pages,
      processed: result.processed,
      sent: result.sent,
      skipped: result.skipped,
      failed: result.failed,
      halted: result.halted,
    };
  } finally {
    await releaseCycleFinalizedLease(cursorKey, leaseToken).catch((err) => {
      appLogger.warn('[cron/whatsapp-circle-events] failed to release stream lease', {
        stream: stream.name,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
}

async function notifyCircleEvent(
  stream: CircleEventStream,
  event: { id: EventCursor; parsedJson: unknown; timestampMs?: string | null },
  ctx: DrainStreamContext,
): Promise<NotifyOutcome> {
  const parsed = stream.parse(event.parsedJson);
  if (!parsed) {
    // Malformed payload or filtered (e.g. CustodyDeposited that is not a
    // security deposit) — advance without a send.
    return 'skipped';
  }

  // Fresh-cursor / outage protection: never replay old history as
  // notifications. Events without a chain timestamp count as fresh.
  const eventAgeMs = event.timestampMs ? Date.now() - Number(event.timestampMs) : 0;
  if (eventAgeMs > ctx.maxEventAgeMs) {
    return 'skipped';
  }

  // Resolve the circle's linked phone. THROWS on registry-read infra
  // failures, which the drain maps to 'halt' (cursor not advanced).
  // Unlink confirmations bypass the cache — they need the disabled link.
  let phone: string | null;
  if (parsed.includeDisabledLink) {
    phone = await resolveCirclePhone(ctx.client, parsed.circleId, ctx.network, {
      includeDisabled: true,
    });
  } else if (ctx.phoneCache.has(parsed.circleId)) {
    phone = ctx.phoneCache.get(parsed.circleId) ?? null;
  } else {
    phone = await resolveCirclePhone(ctx.client, parsed.circleId, ctx.network);
    ctx.phoneCache.set(parsed.circleId, phone);
  }
  if (!phone) {
    // Circle not linked to WhatsApp — a routing decision, not an error.
    return 'skipped';
  }

  // Best-effort enrichment; failures degrade the copy, never the send.
  let circleName = ctx.nameCache.get(parsed.circleId);
  if (!circleName) {
    circleName = await resolveCircleName(ctx.client, parsed.circleId);
    ctx.nameCache.set(parsed.circleId, circleName);
  }

  let memberName: string | null = null;
  if (parsed.memberAddress) {
    try {
      const row = await joinRequestDatabase.getUserByAddress(
        parsed.circleId,
        parsed.memberAddress,
      );
      memberName = row?.user_name ?? null;
    } catch (err) {
      appLogger.warn('[cron/whatsapp-circle-events] member name lookup failed', {
        circleId: parsed.circleId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  let resolvedCoinType: string | null = null;
  if (stream.name === 'security_deposit') {
    resolvedCoinType = await resolveDepositCoinType(ctx, event, parsed.circleId);
  }

  const messageCtx: CircleEventMessageContext = {
    circleName,
    memberName,
    resolvedCoinType,
    appBaseUrl: ctx.appBaseUrl,
  };
  const body = parsed.buildBody(messageCtx);
  // Meta rejects business-initiated freeform text outside the 24h service
  // window (error 131047), so the dispatcher sends the approved template
  // INSTEAD of `body` when WHATSAPP_TEMPLATES_ENABLED=true. Streams whose
  // approved template needs aggregates the cron can't compute return null
  // here and keep the text fallback. `?? undefined` keeps the optional
  // `template` field unset rather than passing null.
  const template = parsed.buildTemplate?.(messageCtx) ?? undefined;

  const sendResult = await sendMemberNotification({
    // Audit/dedupe target: the circle the notification is about. The
    // phone is pre-resolved, so no member-address lookup happens.
    memberAddress: parsed.circleId,
    phoneOverride: phone,
    body,
    template,
    kind: 'circle_event',
    network: ctx.network,
    dedupeKey: circleEventDedupeKey(stream.name, event.id.txDigest, event.id.eventSeq),
    dedupeWindowMs: DEDUPE_WINDOW_MS,
  });

  if (sendResult.sent) {
    appLogger.info('[cron/whatsapp-circle-events] notification sent', {
      stream: stream.name,
      circleId: parsed.circleId,
      txDigest: event.id.txDigest,
    });
    return 'sent';
  }
  if (sendResult.reason === 'missing_credentials') {
    // Config problem affecting every event — halt and retry next run.
    appLogger.error('[cron/whatsapp-circle-events] WhatsApp credentials missing; halting');
    return 'halt';
  }
  if (sendResult.reason === 'send_failed') {
    return 'failed';
  }
  // 'duplicate' (crash-retry window) or 'no_link'.
  return 'skipped';
}

/**
 * CustodyDeposited carries no coin type; the legacy bot resolved it from
 * the CoinDeposited event in the same transaction. Best effort — null
 * makes the message omit the amount rather than misreport units.
 */
async function resolveDepositCoinType(
  ctx: DrainStreamContext,
  event: { id: EventCursor; parsedJson: unknown },
  circleId: string,
): Promise<string | null> {
  try {
    const tx = await ctx.client.getTransactionBlock({
      digest: event.id.txDigest,
      options: { showEvents: true },
    });
    const match = tx.events?.find((candidate) => {
      if (
        typeof candidate?.type !== 'string' ||
        !candidate.type.endsWith('::njangi_custody::CoinDeposited')
      ) {
        return false;
      }
      const json = candidate.parsedJson as Record<string, unknown> | undefined;
      return json?.circle_id === circleId;
    });
    const coinType = (match?.parsedJson as Record<string, unknown> | undefined)?.coin_type;
    return typeof coinType === 'string' && coinType.trim() !== '' ? coinType : null;
  } catch (err) {
    appLogger.warn('[cron/whatsapp-circle-events] coin type resolution failed', {
      txDigest: event.id.txDigest,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
