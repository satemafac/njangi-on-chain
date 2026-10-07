// rate-limit.ts — Minimal per-key window limiter used to throttle the
// compliance endpoints and other unauthenticated routes.
//
// Vercel/serverless migration (June 2026): the original implementation was
// an in-process Map, which on serverless degrades to "one window per lambda
// instance" — i.e. effectively no limit under fan-out. When DATABASE_URL is
// configured the limiter now uses a Postgres-backed fixed window keyed by
// (bucket, window_start) with a single atomic upsert per request. The
// in-memory window remains as the dev fallback (no DATABASE_URL) and as the
// fail-open path if Postgres errors — the limiter is defense-in-depth, not
// a correctness gate.
//
// Keys (October 2026): build them with `rateLimitKey` from
// ./rate-limit-key, never by interpolating the client IP, an email or an
// address. The key is the `bucket` column of `rate_limits`, and a bucket is
// only replaced when it is hit again, so anything in it persists. The
// Postgres path also sweeps rows whose window started more than
// STALE_WINDOW_RETENTION_MS ago, at most once per SWEEP_INTERVAL_MS per
// process, on the back of a write it was already making (no cron, no extra
// database wake-ups: see the 2026-07-21 Neon compute incident).

import { getSharedPgPool, isPostgresConfigured } from './pg-pool';

interface Window {
  start: number;
  count: number;
}

const windows: Map<string, Window> = new Map();

export interface RateLimitOptions {
  /**
   * Bucket key: `<scope>:<hmac-sha256 hex>` from `rateLimitKey()` in
   * ./rate-limit-key. Never put a raw IP, email or address here — with
   * DATABASE_URL set the key is stored verbatim in Postgres.
   */
  key: string;
  /** Max requests allowed inside the window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetMs: number;
}

function consumeMemoryRateLimit(opts: RateLimitOptions): RateLimitResult {
  const now = Date.now();
  const current = windows.get(opts.key);
  if (!current || now - current.start >= opts.windowMs) {
    const fresh: Window = { start: now, count: 1 };
    windows.set(opts.key, fresh);
    return { allowed: true, remaining: opts.limit - 1, resetMs: opts.windowMs };
  }
  if (current.count >= opts.limit) {
    return {
      allowed: false,
      remaining: 0,
      resetMs: opts.windowMs - (now - current.start),
    };
  }
  current.count += 1;
  return {
    allowed: true,
    remaining: opts.limit - current.count,
    resetMs: opts.windowMs - (now - current.start),
  };
}

let setupPromise: Promise<void> | null = null;
let postgresWarned = false;

/**
 * Rows whose window started this long ago are deleted by the sweep. Every
 * window the app uses is at most 10 minutes (compliance: configurable,
 * default 60 s), so a row older than this can only be a leftover: the
 * per-bucket garbage collection in the upsert never sees a bucket that is
 * not hit again. Keep this above the longest `windowMs` in use.
 */
export const STALE_WINDOW_RETENTION_MS = 24 * 60 * 60 * 1000;

/** How often one process sweeps, at most. */
export const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

let lastSweepAt = 0;

function ensureTable(): Promise<void> {
  if (!setupPromise) {
    setupPromise = getSharedPgPool()
      .query(
        `CREATE TABLE IF NOT EXISTS rate_limits (
           bucket TEXT NOT NULL,
           window_start TIMESTAMPTZ NOT NULL,
           count INTEGER NOT NULL,
           PRIMARY KEY (bucket, window_start)
         );
         CREATE INDEX IF NOT EXISTS rate_limits_window_start_idx
           ON rate_limits (window_start);`,
      )
      .then(() => undefined)
      .catch((err) => {
        setupPromise = null;
        throw err;
      });
  }
  return setupPromise;
}

async function consumePostgresRateLimit(opts: RateLimitOptions): Promise<RateLimitResult> {
  await ensureTable();
  const now = Date.now();
  const windowStartMs = Math.floor(now / opts.windowMs) * opts.windowMs;

  // Single atomic statement: garbage-collect this bucket's stale windows,
  // then upsert-increment the current one. Concurrent requests across
  // instances serialise on the (bucket, window_start) row.
  const result = await getSharedPgPool().query<{ count: number }>(
    `WITH gc AS (
       DELETE FROM rate_limits
        WHERE bucket = $1 AND window_start < to_timestamp($2 / 1000.0)
     )
     INSERT INTO rate_limits (bucket, window_start, count)
     VALUES ($1, to_timestamp($2 / 1000.0), 1)
     ON CONFLICT (bucket, window_start)
       DO UPDATE SET count = rate_limits.count + 1
     RETURNING count`,
    [opts.key, windowStartMs],
  );

  const count = Number(result.rows[0]?.count ?? 1);
  const resetMs = Math.max(windowStartMs + opts.windowMs - now, 0);

  // Piggy-back the table-wide sweep on this write. Best effort: it is
  // awaited so a serverless instance does not freeze with it half done,
  // but its failure is logged and never reaches the caller.
  await sweepStaleWindowsIfDue(now);

  if (count > opts.limit) {
    return { allowed: false, remaining: 0, resetMs };
  }
  return {
    allowed: true,
    remaining: Math.max(opts.limit - count, 0),
    resetMs,
  };
}

/** True when a sweep is due: none yet this process, or the interval elapsed. */
export function isSweepDue(now: number, lastSweep: number, intervalMs = SWEEP_INTERVAL_MS): boolean {
  return lastSweep === 0 || now - lastSweep >= intervalMs;
}

/**
 * Deletes every row whose window started more than
 * STALE_WINDOW_RETENTION_MS ago, at most once per SWEEP_INTERVAL_MS per
 * process. The per-bucket garbage collection in the upsert only ever
 * touches the bucket being written, so a visitor who never comes back left
 * a row behind forever; this is the table-wide counterpart. Marks the sweep
 * as done BEFORE running it so a failing database is not hammered on every
 * request.
 */
async function sweepStaleWindowsIfDue(now: number): Promise<void> {
  if (!isSweepDue(now, lastSweepAt)) return;
  lastSweepAt = now;
  try {
    await getSharedPgPool().query(
      `DELETE FROM rate_limits WHERE window_start < to_timestamp($1 / 1000.0)`,
      [now - STALE_WINDOW_RETENTION_MS],
    );
  } catch (err) {
    console.warn(
      '[rate-limit] stale-window sweep failed; will retry after the sweep interval:',
      err instanceof Error ? err.message : err,
    );
  }
}

function peekMemoryRateLimit(opts: RateLimitOptions): RateLimitResult {
  const now = Date.now();
  const current = windows.get(opts.key);
  if (!current || now - current.start >= opts.windowMs) {
    return { allowed: true, remaining: opts.limit, resetMs: opts.windowMs };
  }
  const resetMs = opts.windowMs - (now - current.start);
  if (current.count >= opts.limit) {
    return { allowed: false, remaining: 0, resetMs };
  }
  return { allowed: true, remaining: opts.limit - current.count, resetMs };
}

async function peekPostgresRateLimit(opts: RateLimitOptions): Promise<RateLimitResult> {
  await ensureTable();
  const now = Date.now();
  const windowStartMs = Math.floor(now / opts.windowMs) * opts.windowMs;
  const result = await getSharedPgPool().query<{ count: number }>(
    `SELECT count FROM rate_limits
      WHERE bucket = $1 AND window_start = to_timestamp($2 / 1000.0)`,
    [opts.key, windowStartMs],
  );
  const count = Number(result.rows[0]?.count ?? 0);
  const resetMs = Math.max(windowStartMs + opts.windowMs - now, 0);
  if (count >= opts.limit) {
    return { allowed: false, remaining: 0, resetMs };
  }
  return { allowed: true, remaining: opts.limit - count, resetMs };
}

/**
 * Read-only check of a window: reports whether a `consumeRateLimit` call
 * with the same options would be allowed right now, WITHOUT spending a
 * slot. For actions whose expensive step can fail after the check (the
 * faucet drip calling an upstream that throttles), peek first, do the
 * work, and consume only on success — otherwise a failed attempt locks
 * the caller out for the whole window with nothing to show for it.
 *
 * Peek-then-consume is not atomic; two concurrent callers can both pass
 * the peek. That is acceptable for defense-in-depth limits (the upstream
 * enforces its own), not for correctness gates.
 */
export async function peekRateLimit(opts: RateLimitOptions): Promise<RateLimitResult> {
  if (!isPostgresConfigured()) {
    return peekMemoryRateLimit(opts);
  }
  try {
    return await peekPostgresRateLimit(opts);
  } catch (err) {
    if (!postgresWarned) {
      postgresWarned = true;
      console.warn(
        '[rate-limit] Postgres-backed limiter failed; falling back to in-memory window:',
        err instanceof Error ? err.message : err,
      );
    }
    return peekMemoryRateLimit(opts);
  }
}

export async function consumeRateLimit(opts: RateLimitOptions): Promise<RateLimitResult> {
  if (!isPostgresConfigured()) {
    return consumeMemoryRateLimit(opts);
  }
  try {
    return await consumePostgresRateLimit(opts);
  } catch (err) {
    // Fail open onto the per-instance window: a database blip should not
    // turn the rate limiter into a denial-of-service on ourselves.
    if (!postgresWarned) {
      postgresWarned = true;
      console.warn(
        '[rate-limit] Postgres-backed limiter failed; falling back to in-memory window:',
        err instanceof Error ? err.message : err,
      );
    }
    return consumeMemoryRateLimit(opts);
  }
}

/** Test helper — clears the in-memory windows so cases don't leak. */
export function __resetRateLimitForTests(): void {
  windows.clear();
  setupPromise = null;
  postgresWarned = false;
  lastSweepAt = 0;
}
