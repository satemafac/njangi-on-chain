// cycle-finalized-cron.ts — Core logic for the /api/cron/cycle-finalized
// Vercel cron, ported from scripts/cycle-finalized-notifier.mjs (the
// long-running Heroku worker) during the June 2026 serverless migration.
//
// Fixes the two bugs the June 2026 ops-readiness audit verified in the
// old worker:
//
//   1. The notify POST omitted `recipient`, so the endpoint resolved the
//      WhatsApp link for the *circle id* and every nudge silently no-oped.
//      (Fixed in the caller — the drain hands the full parsed event to the
//      notify callback, and parseCycleFinalizedEvent rejects events
//      without a recipient.)
//   2. The cursor logic was inverted: it queried ascending but assumed
//      descending, persisted the OLDEST event id of each batch, never
//      followed nextCursor, and so re-processed the batch every poll while
//      advancing one event per minute. `drainCycleFinalizedEvents` queries
//      ascending, follows nextCursor page by page until `hasNextPage` is
//      false, and persists the NEWEST processed cursor after every page so
//      a crash mid-drain resumes instead of re-notifying.
//
// Cursor storage is the `cycle_finalized_cursor` Postgres table (created
// idempotently here and by scripts/migrate-postgres.mjs) — never a file:
// serverless filesystems are ephemeral and per-instance.
//
// OVERLAP PROTECTION: Vercel does not prevent concurrent cron executions —
// a backlog drain running near the 60s maxDuration overlaps the next
// minute's tick. Two concurrent drains would load the same cursor, process
// the same events, and race the (formerly check-then-act) WhatsApp dedupe.
// The cursor row therefore doubles as a lease: `acquireCycleFinalizedLease`
// atomically claims `locked_until`/`locked_by` (the loser's run skips
// entirely), and `saveCycleFinalizedCursor` is FENCED by the lease token so
// a slow zombie run whose lease expired can never regress the cursor that a
// newer run already advanced. A TTL lease was chosen over
// `pg_try_advisory_lock` deliberately: session-scoped advisory locks are
// unreliable behind transaction-pooling proxies (Neon's PgBouncer endpoint)
// and leak when a lambda is killed mid-run, whereas an expired lease
// self-heals on the next tick.
//
// NOTE on event type tags: Sui event types use the package id that
// *defines* the module (the original publish id), not the latest upgrade
// id. Callers must build the MoveEventType filter from
// `getPublishedPackageMetadata(network).originalId` — filtering on the
// upgraded `published-at` id silently matches nothing.

import { randomUUID } from 'crypto';
import { getSharedPgPool } from './pg-pool';
import { appLogger } from '../utils/logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Mirror of @mysten/sui's EventId — kept structural so tests stay pure. */
export interface EventCursor {
  txDigest: string;
  eventSeq: string;
}

export interface CycleFinalizedEventEnvelope {
  id: EventCursor;
  parsedJson: unknown;
  /** Chain timestamp of the event, when the RPC provides one. */
  timestampMs?: string | null;
}

export interface EventPage {
  data: CycleFinalizedEventEnvelope[];
  nextCursor: EventCursor | null;
  hasNextPage: boolean;
}

/**
 * Per-event outcome reported by the notify callback:
 *   * 'sent'    — WhatsApp nudge delivered; advance.
 *   * 'skipped' — nothing to send (no link, duplicate, malformed event);
 *                 advance.
 *   * 'failed'  — send attempt failed; the failure is recorded in the
 *                 whatsapp_notifications audit table (success=false), so we
 *                 advance rather than wedge the pipeline on one bad number.
 *   * 'halt'    — infrastructure/config problem (DB down, WhatsApp
 *                 credentials missing). Stop the drain WITHOUT advancing
 *                 past this event so the next cron run retries it.
 */
export type NotifyOutcome = 'sent' | 'skipped' | 'failed' | 'halt';

export interface DrainDeps {
  /** Fetches one ascending page of events strictly AFTER `cursor`. */
  queryPage(cursor: EventCursor | null): Promise<EventPage>;
  /** Processes one event. Throwing is treated as 'halt'. */
  notify(event: CycleFinalizedEventEnvelope): Promise<NotifyOutcome>;
  /** Durably persists the newest processed cursor. */
  persistCursor(cursor: EventCursor): Promise<void>;
  /** Safety cap on pages per run (default 20 → ≤1000 events). */
  maxPages?: number;
}

export interface DrainResult {
  pages: number;
  processed: number;
  sent: number;
  skipped: number;
  failed: number;
  halted: boolean;
  /** Newest cursor persisted this run (initial cursor when nothing new). */
  finalCursor: EventCursor | null;
}

// ---------------------------------------------------------------------------
// Pure drain loop (unit-tested in __tests__/cycle-finalized-cron.test.ts)
// ---------------------------------------------------------------------------

const DEFAULT_MAX_PAGES = 20;

export async function drainCycleFinalizedEvents(
  initialCursor: EventCursor | null,
  deps: DrainDeps,
): Promise<DrainResult> {
  const maxPages = deps.maxPages ?? DEFAULT_MAX_PAGES;
  let cursor = initialCursor;
  const result: DrainResult = {
    pages: 0,
    processed: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
    halted: false,
    finalCursor: initialCursor,
  };

  for (let pageNo = 0; pageNo < maxPages; pageNo += 1) {
    const page = await deps.queryPage(cursor);
    result.pages += 1;

    let lastProcessed: EventCursor | null = null;
    for (const event of page.data) {
      let outcome: NotifyOutcome;
      try {
        outcome = await deps.notify(event);
      } catch (err) {
        appLogger.error('[cycle-finalized-cron] notify threw; halting drain', {
          txDigest: event.id.txDigest,
          eventSeq: event.id.eventSeq,
          error: err instanceof Error ? err.message : String(err),
        });
        outcome = 'halt';
      }

      if (outcome === 'halt') {
        // Persist progress up to the previous event so the next run resumes
        // AT this event (suix_queryEvents cursors are exclusive).
        if (lastProcessed) {
          await deps.persistCursor(lastProcessed);
          result.finalCursor = lastProcessed;
        }
        result.halted = true;
        return result;
      }

      if (outcome === 'sent') result.sent += 1;
      else if (outcome === 'skipped') result.skipped += 1;
      else result.failed += 1;
      result.processed += 1;
      lastProcessed = event.id;
    }

    if (page.data.length > 0) {
      // Persist the NEWEST processed cursor. For ascending event queries
      // nextCursor points at the last (newest) item of the page; fall back
      // to the last processed event id when the node omits it.
      const pageCursor = page.nextCursor ?? lastProcessed;
      if (pageCursor) {
        await deps.persistCursor(pageCursor);
        cursor = pageCursor;
        result.finalCursor = pageCursor;
      }
    } else if (page.hasNextPage && page.nextCursor) {
      // Defensive: empty page that still advertises more data.
      cursor = page.nextCursor;
    }

    if (!page.hasNextPage) break;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Event parsing + amount formatting (pure helpers)
// ---------------------------------------------------------------------------

export interface ParsedCycleFinalized {
  escrowId: string;
  cycleNo: number;
  recipient: string;
  amount: string;
}

/**
 * Parses the on-chain `njangi_cycle_escrow::CycleFinalized` payload:
 * `{ escrow_id: ID, cycle_no: u64, recipient: address, amount: u64,
 *    finalized_by: address }`. There is NO circle_id field — the old worker
 * expected one and dropped every event as "malformed". Returns null for
 * payloads missing the escrow id or recipient.
 */
export function parseCycleFinalizedEvent(
  parsedJson: unknown,
): ParsedCycleFinalized | null {
  if (!parsedJson || typeof parsedJson !== 'object') return null;
  const raw = parsedJson as Record<string, unknown>;
  const escrowId = typeof raw.escrow_id === 'string' ? raw.escrow_id : null;
  const recipient = typeof raw.recipient === 'string' ? raw.recipient : null;
  if (!escrowId || !recipient) return null;

  const cycleNoRaw = raw.cycle_no;
  const cycleNo =
    typeof cycleNoRaw === 'number'
      ? cycleNoRaw
      : typeof cycleNoRaw === 'string' && cycleNoRaw.trim() !== ''
        ? Number(cycleNoRaw)
        : 0;

  const amountRaw = raw.amount;
  const amount =
    typeof amountRaw === 'string'
      ? amountRaw
      : typeof amountRaw === 'number'
        ? String(amountRaw)
        : '0';

  return {
    escrowId,
    cycleNo: Number.isFinite(cycleNo) ? cycleNo : 0,
    recipient,
    amount,
  };
}

/** "1500000000" + (9, "SUI") → "1.5 SUI". Ported from the legacy worker. */
export function formatCoinAmount(
  baseUnits: string,
  decimals: number,
  symbol: string,
): string {
  try {
    const v = BigInt(baseUnits);
    if (v === 0n) return `0 ${symbol}`;
    const divisor = 10n ** BigInt(decimals);
    const whole = v / divisor;
    const frac = v % divisor;
    if (frac === 0n) return `${whole.toString()} ${symbol}`;
    const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
    return `${whole.toString()}.${fracStr} ${symbol}`;
  } catch {
    return `${String(baseUnits)} ${symbol}`;
  }
}

// ---------------------------------------------------------------------------
// Postgres cursor persistence — `cycle_finalized_cursor` table
// ---------------------------------------------------------------------------

/** Cursor row key: scoped per defining package id + network. */
export function cycleFinalizedCursorKey(
  packageId: string,
  network: string,
): string {
  return `${packageId}:${network}`;
}

let cursorTableReady: Promise<void> | null = null;

function ensureCursorTable(): Promise<void> {
  if (!cursorTableReady) {
    cursorTableReady = getSharedPgPool()
      .query(
        `CREATE TABLE IF NOT EXISTS cycle_finalized_cursor (
           key TEXT PRIMARY KEY,
           cursor JSONB,
           updated_at TIMESTAMPTZ DEFAULT NOW(),
           locked_until TIMESTAMPTZ,
           locked_by TEXT
         );
         ALTER TABLE cycle_finalized_cursor
           ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;
         ALTER TABLE cycle_finalized_cursor
           ADD COLUMN IF NOT EXISTS locked_by TEXT;`,
      )
      .then(() => undefined)
      .catch((err) => {
        // Allow a retry on the next call instead of caching the failure.
        cursorTableReady = null;
        throw err;
      });
  }
  return cursorTableReady;
}

function isEventCursor(value: unknown): value is EventCursor {
  if (!value || typeof value !== 'object') return false;
  const raw = value as Record<string, unknown>;
  return typeof raw.txDigest === 'string' && typeof raw.eventSeq === 'string';
}

export async function loadCycleFinalizedCursor(
  key: string,
): Promise<EventCursor | null> {
  await ensureCursorTable();
  const result = await getSharedPgPool().query<{ cursor: unknown }>(
    'SELECT cursor FROM cycle_finalized_cursor WHERE key = $1',
    [key],
  );
  const stored = result.rows[0]?.cursor;
  return isEventCursor(stored) ? stored : null;
}

/**
 * Persists the cursor, FENCED by the run's lease token: the UPDATE only
 * lands while this run still owns `locked_by`. Without the fence the upsert
 * was last-write-wins — a slow overlapping run could regress the persisted
 * cursor below the frontier a faster run had already advanced, re-notifying
 * everything in between. Throws `CycleFinalizedLeaseLostError` when the
 * lease was taken over (expired mid-run and re-acquired by a newer tick) so
 * the zombie run aborts loudly instead of corrupting state.
 */
export async function saveCycleFinalizedCursor(
  key: string,
  cursor: EventCursor,
  leaseToken: string,
): Promise<void> {
  await ensureCursorTable();
  const result = await getSharedPgPool().query(
    `UPDATE cycle_finalized_cursor
        SET cursor = $2, updated_at = NOW()
      WHERE key = $1 AND locked_by = $3`,
    [key, JSON.stringify(cursor), leaseToken],
  );
  if ((result.rowCount ?? 0) === 0) {
    throw new CycleFinalizedLeaseLostError(key);
  }
}

// ---------------------------------------------------------------------------
// Run lease — prevents overlapping cron invocations from double-processing
// ---------------------------------------------------------------------------

/**
 * Lease TTL. MUST exceed the route's `maxDuration` (60s in vercel.json) so
 * a live run can never lose its lease mid-drain; kept tight beyond that so
 * a hard-killed lambda only blocks the pipeline for ~one missed tick.
 */
export const CYCLE_FINALIZED_LEASE_TTL_MS = 90_000;

export class CycleFinalizedLeaseLostError extends Error {
  constructor(key: string) {
    super(
      `cycle-finalized lease for "${key}" was lost (taken over by a newer run); ` +
        'aborting without persisting the cursor',
    );
    this.name = 'CycleFinalizedLeaseLostError';
  }
}

/**
 * Atomically claims the per-(package, network) run lease. Returns an opaque
 * fencing token when this run now owns the lease, or `null` when another
 * invocation holds an unexpired lease (caller should skip the run). The
 * single INSERT … ON CONFLICT DO UPDATE … WHERE statement is the
 * check-and-set — there is no read-then-write window for two runs to both
 * win. Also creates the cursor row on first ever run (cursor stays NULL
 * until the first fenced save).
 */
export async function acquireCycleFinalizedLease(
  key: string,
  ttlMs: number = CYCLE_FINALIZED_LEASE_TTL_MS,
): Promise<string | null> {
  await ensureCursorTable();
  const token = randomUUID();
  const result = await getSharedPgPool().query(
    `INSERT INTO cycle_finalized_cursor (key, cursor, updated_at, locked_until, locked_by)
     VALUES ($1, NULL, NOW(), NOW() + ($2::int * interval '1 millisecond'), $3)
     ON CONFLICT (key) DO UPDATE
       SET locked_until = EXCLUDED.locked_until,
           locked_by = EXCLUDED.locked_by
       WHERE cycle_finalized_cursor.locked_until IS NULL
          OR cycle_finalized_cursor.locked_until < NOW()
     RETURNING key`,
    [key, ttlMs, token],
  );
  return (result.rowCount ?? 0) > 0 ? token : null;
}

/**
 * Releases the lease iff this run still owns it (token-guarded, so a
 * takeover is never clobbered). Safe to call from `finally` — releasing a
 * lease that was already taken over is a no-op.
 */
export async function releaseCycleFinalizedLease(
  key: string,
  leaseToken: string,
): Promise<void> {
  await ensureCursorTable();
  await getSharedPgPool().query(
    `UPDATE cycle_finalized_cursor
        SET locked_until = NULL, locked_by = NULL
      WHERE key = $1 AND locked_by = $2`,
    [key, leaseToken],
  );
}

/** Test helper — resets the lazy table-creation latch. */
export function __resetCycleFinalizedCronForTests(): void {
  cursorTableReady = null;
}
