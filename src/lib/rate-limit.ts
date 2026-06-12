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

import { getSharedPgPool, isPostgresConfigured } from './pg-pool';

interface Window {
  start: number;
  count: number;
}

const windows: Map<string, Window> = new Map();

export interface RateLimitOptions {
  /** Unique key (typically sha256 of the bearer secret + action). */
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

function ensureTable(): Promise<void> {
  if (!setupPromise) {
    setupPromise = getSharedPgPool()
      .query(
        `CREATE TABLE IF NOT EXISTS rate_limits (
           bucket TEXT NOT NULL,
           window_start TIMESTAMPTZ NOT NULL,
           count INTEGER NOT NULL,
           PRIMARY KEY (bucket, window_start)
         );`,
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
  if (count > opts.limit) {
    return { allowed: false, remaining: 0, resetMs };
  }
  return {
    allowed: true,
    remaining: Math.max(opts.limit - count, 0),
    resetMs,
  };
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
}
