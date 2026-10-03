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
//      notify callback, and the recipient now comes from the escrow
//      snapshot; parseYourTurnEscrow rejects an escrow without one.)
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
//
// TRIGGER (2026-09-27): the nudge says the pot is full and the payout is
// ready to collect, which is true from the contribution that fills the
// pot until the recipient collects it. It used to fire on
// `CycleFinalized`, but the app's Collect button calls
// `finalize_and_redeem`, which emits CycleFinalized AND ClaimRedeemed in
// the same transaction (testnet tx FLtRuWh…, 2026-09-07), so every nudge
// arrived after the payout had been collected. The stream is now
// `ContributionRecorded`: a nudge goes out for the contribution that
// brings `contributors_so_far` up to the snapshot's
// `required_contributors` (the contract's own finalize gate), and only
// while the escrow is neither claimed nor refunded when the cron reads it.
// A CycleFinalized from the permissionless `finalize_to_recipient` needs
// no nudge of its own: finalizing requires a full pot, so the
// contribution that filled it came first and was nudged under the same
// dedupe key.

import { randomUUID } from 'crypto';
import { getSharedPgPool } from './pg-pool';
import { getCoinLabelFromType } from './whatsapp-bot/circle-events';
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
// "Your turn" trigger: the contribution that fills the pot (pure helpers)
// ---------------------------------------------------------------------------

type RawRecord = Record<string, unknown>;

function asRecord(value: unknown): RawRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as RawRecord)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** A u64 as decimal digits. u64s arrive as strings (numbers on some nodes). */
function u64Digits(value: unknown): string | null {
  const text =
    typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  return typeof text === 'string' && /^\d+$/.test(text) ? text : null;
}

/** A u64 that is a count or an index, so it must fit a safe integer. */
function u64Count(value: unknown): number | null {
  const digits = u64Digits(value);
  const parsed = digits === null ? Number.NaN : Number(digits);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export interface ParsedContributionRecorded {
  escrowId: string;
  cycleNo: number;
  /** Contributors recorded in the escrow, this contribution included. */
  contributorsSoFar: number;
  /** Escrow balance in base units right after this contribution. */
  totalContributed: string;
}

/**
 * Parses `njangi_cycle_escrow::ContributionRecorded`:
 * `{ escrow_id: ID, cycle_no: u64, contributor: address, amount: u64,
 *    contributors_so_far: u64, total_contributed: u64 }`. Like every escrow
 * event it names the escrow but neither the circle nor the coin. Returns
 * null when any field the trigger reads is missing or malformed.
 */
export function parseContributionRecordedEvent(
  parsedJson: unknown,
): ParsedContributionRecorded | null {
  const raw = asRecord(parsedJson);
  if (!raw) return null;
  const escrowId = nonEmptyString(raw.escrow_id);
  const cycleNo = u64Count(raw.cycle_no);
  const contributorsSoFar = u64Count(raw.contributors_so_far);
  const totalContributed = u64Digits(raw.total_contributed);
  if (!escrowId || cycleNo === null || contributorsSoFar === null || !totalContributed) {
    return null;
  }
  return { escrowId, cycleNo, contributorsSoFar, totalContributed };
}

/**
 * What the nudge reads off the `CycleEscrow<T>` an event names. The circle,
 * coin, recipient and required count are frozen when the escrow opens;
 * `claimed` and `refunded` are live, and they are the point of reading at
 * send time: they say whether "ready to collect" is still true.
 */
export interface YourTurnEscrow {
  circleId: string;
  /** `T` of `CycleEscrow<T>`, e.g. `0x2::sui::SUI` or `0x…::usdc::USDC`. */
  coinType: string;
  /** The round's scheduled payout recipient, from the snapshot. */
  recipient: string;
  /** Payers the finalize gate requires: every member except the recipient. */
  requiredContributors: number;
  /** The recipient already collected (finalize_and_redeem or redeem_claim). */
  claimed: boolean;
  /** Refunds began (cancelled round or expired claim): nothing to collect. */
  refunded: boolean;
}

const CYCLE_ESCROW_TYPE = /::njangi_cycle_escrow::CycleEscrow<(.+)>$/;

/** getObject error codes that answer "no such object" rather than fail. */
const DEFINITIVE_OBJECT_ERRORS = new Set(['notExists', 'deleted']);

/**
 * Parses a `getObject({ showType, showContent })` response for the escrow
 * a ContributionRecorded names.
 *
 * Null when the response is an answer that holds no usable escrow: the
 * object does not exist or was deleted, is some other type, or lacks a
 * field the nudge needs. The cron skips those events, since a retry would
 * read the same thing.
 *
 * THROWS when the response is not an answer: an error code other than
 * notExists/deleted, or an object without the type or content that was
 * asked for. The cron then halts without advancing its cursor, because an
 * escrow it could not read is not an escrow whose pot is still open.
 * Transport failures throw before this is reached.
 */
export function parseYourTurnEscrow(objectResponse: unknown): YourTurnEscrow | null {
  const response = asRecord(objectResponse);
  const error = asRecord(response?.error);
  if (error) {
    const code = nonEmptyString(error.code) ?? 'unknown';
    if (DEFINITIVE_OBJECT_ERRORS.has(code)) return null;
    throw new Error(`escrow read returned RPC error "${code}"`);
  }
  const data = asRecord(response?.data);
  const content = asRecord(data?.content);
  const typeTag = nonEmptyString(data?.type) ?? nonEmptyString(content?.type);
  if (!typeTag) throw new Error('escrow read returned no object type');
  const coinType = typeTag.match(CYCLE_ESCROW_TYPE)?.[1];
  if (!coinType) return null;
  const fields = asRecord(content?.fields);
  if (!fields) throw new Error('escrow read returned no object content');

  // Nested structs arrive as { type, fields } on most nodes, flattened on some.
  const snapshotRaw = asRecord(fields.snapshot);
  const snapshot = asRecord(snapshotRaw?.fields) ?? snapshotRaw;
  const circleId = nonEmptyString(fields.circle_id);
  const recipient = nonEmptyString(snapshot?.recipient);
  const requiredContributors = u64Count(snapshot?.required_contributors);
  const { claimed, refunded } = fields;
  if (
    !circleId ||
    !recipient ||
    !requiredContributors ||
    typeof claimed !== 'boolean' ||
    typeof refunded !== 'boolean'
  ) {
    return null;
  }
  return { circleId, coinType, recipient, requiredContributors, claimed, refunded };
}

export type YourTurnSkipReason = 'not_pot_filling' | 'already_collected' | 'refunded';

/**
 * Why a contribution earns no "your turn" nudge, or null when it does.
 * The pot is full from the contribution whose running count reaches the
 * snapshot's `required_contributors`, the comparison the contract's
 * finalize gate makes (`contributors_count >= required_contributors`).
 * The nudge is sent only while that pot is still there to collect.
 * Finalized but unclaimed (a Claim minted by `finalize_to_recipient` and
 * not yet redeemed) still counts as ready to collect.
 */
export function yourTurnSkipReason(
  event: ParsedContributionRecorded,
  escrow: YourTurnEscrow,
): YourTurnSkipReason | null {
  if (event.contributorsSoFar < escrow.requiredContributors) return 'not_pot_filling';
  if (escrow.claimed) return 'already_collected';
  if (escrow.refunded) return 'refunded';
  return null;
}

/**
 * Decimals by coin label. SUI and USDC are the two coins a circle settles
 * in (circle-settlement.ts); USDT is a 6-decimal stablecoin too. Matches
 * the known-decimals guard the circle-event relay applies to escrow events.
 */
const KNOWN_COIN_DECIMALS = new Map<string, number>([
  ['SUI', 9],
  ['USDC', 6],
  ['USDT', 6],
]);

/**
 * The payout in display units for the escrow's own coin, e.g.
 * "200000" + `0x…::usdc::USDC` → "0.2 USDC", or null when the coin's
 * decimals are not known. Opening an escrow is permissionless and generic
 * over `T`, and one env-wide COIN_DECIMALS could not be right for SUI and
 * USDC circles at once; a figure off by 10^3 is worse than no figure.
 */
export function formatEscrowPayout(baseUnits: string, coinType: string): string | null {
  const symbol = getCoinLabelFromType(coinType);
  const decimals = KNOWN_COIN_DECIMALS.get(symbol);
  return decimals === undefined ? null : formatCoinAmount(baseUnits, decimals, symbol);
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

/**
 * Cursor + lease row of the "your turn" stream, scoped per event type,
 * defining package id and network. The event type is in the key because a
 * cursor paged over one event type is never resumed against another: the
 * row this cron used while it read CycleFinalized (`${packageId}:${network}`)
 * is left as it was, and this row starts from genesis, where the age cap
 * skips everything older than a day before any read.
 */
export function yourTurnCursorKey(packageId: string, network: string): string {
  return `your-turn:contribution_recorded:${packageId}:${network}`;
}

/** Default nudge-worthiness window: older events advance without a send. */
export const DEFAULT_YOUR_TURN_MAX_EVENT_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * CYCLE_FINALIZED_MAX_EVENT_AGE_MS, or 24h when it is unset or malformed.
 * A malformed value must not switch the age cap off: `age > NaN` is always
 * false, so every event would count as fresh, and a fresh cursor drains
 * the stream's whole history on its first pass.
 */
export function yourTurnMaxEventAgeMs(raw: string | undefined): number {
  const trimmed = raw?.trim();
  const parsed = trimmed ? Number(trimmed) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_YOUR_TURN_MAX_EVENT_AGE_MS;
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
