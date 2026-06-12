// pg-pool.ts — Shared lazy Postgres pool for serverless deployments.
//
// Before the Vercel migration every module (`postgres-adapter`,
// `whatsapp-link-index`, `attestation-queue`, …) built its own `Pool` with
// the same copy-pasted Heroku-era SSL heuristic:
//
//   ssl: url.includes('amazonaws.com') ? { rejectUnauthorized: false } : undefined
//
// That heuristic was flagged in the June 2026 ops-readiness audit: it
// disables certificate verification on AWS hosts and disables TLS entirely
// everywhere else. This module centralises the decision:
//
//   * `sslmode` from the connection URL (Neon URLs carry `sslmode=require`)
//     or the `PGSSLMODE` env var wins.
//   * `disable`      → no TLS
//   * `no-verify`    → TLS without certificate verification (legacy Heroku)
//   * anything else  → TLS with full verification
//   * No explicit mode: production defaults to TLS **with** verification;
//     development keeps the old behaviour (no TLS locally, no-verify for
//     legacy amazonaws.com URLs) so local stacks keep working.
//
// The pool is hung off `globalThis` because Next.js compiles each
// `pages/api` entrypoint into its own bundle — a module-scoped pool would
// be duplicated per bundle and exhaust the Postgres connection budget on
// serverless platforms. Keep `max` low: each lambda instance gets its own
// pool, and Neon's pooled connection string does the heavy lifting.

import { Pool } from 'pg';

const GLOBAL_POOL_KEY = Symbol.for('njangi.pg.shared-pool');

export type PgSslConfig = { rejectUnauthorized: boolean } | undefined;

function sslModeFromUrl(connectionString: string): string | null {
  try {
    return new URL(connectionString).searchParams.get('sslmode');
  } catch {
    return null;
  }
}

/**
 * Resolves the `ssl` option for a `pg` Pool from the connection string and
 * environment, defaulting to verified TLS in production.
 */
export function resolvePgSsl(connectionString: string): PgSslConfig {
  const sslmode = sslModeFromUrl(connectionString) ?? process.env.PGSSLMODE ?? null;

  if (sslmode) {
    if (sslmode === 'disable') return undefined;
    if (sslmode === 'no-verify') return { rejectUnauthorized: false };
    // require / prefer / verify-ca / verify-full → TLS with verification.
    return { rejectUnauthorized: true };
  }

  if (process.env.NODE_ENV === 'production') {
    return { rejectUnauthorized: true };
  }

  // Legacy Heroku-style AWS URLs use a self-signed chain; keep the historic
  // no-verify behaviour for local tooling pointed at old databases.
  if (connectionString.includes('amazonaws.com')) {
    return { rejectUnauthorized: false };
  }

  return undefined;
}

/** True when a Postgres connection string is configured. */
export function isPostgresConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

/**
 * Fail-fast guard for production: serverless instances must never silently
 * fall back to per-instance state (in-memory maps, SQLite files on a
 * read-only filesystem). Call where an adapter initialises.
 */
export function assertDatabaseUrlInProduction(context: string): void {
  if (process.env.NODE_ENV === 'production' && !process.env.DATABASE_URL) {
    throw new Error(
      `[${context}] DATABASE_URL is required in production. ` +
        'Refusing to fall back to in-memory/SQLite state on a serverless deployment.',
    );
  }
}

interface PoolLike {
  query: Pool['query'];
  end: Pool['end'];
}

/**
 * Returns the process-wide shared pool, creating it on first use. Throws
 * when DATABASE_URL is not configured — callers should gate on
 * `isPostgresConfigured()` if they have a dev fallback.
 */
export function getSharedPgPool(): Pool {
  const globalStore = globalThis as { [key: symbol]: unknown };
  const existing = globalStore[GLOBAL_POOL_KEY] as PoolLike | undefined;
  if (existing && typeof existing.query === 'function') {
    return existing as Pool;
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not configured.');
  }

  const pool = new Pool({
    connectionString,
    ssl: resolvePgSsl(connectionString),
    max: Number(process.env.PG_POOL_MAX ?? '5'),
    idleTimeoutMillis: Number(process.env.PG_POOL_IDLE_TIMEOUT_MS ?? '10000'),
  });
  globalStore[GLOBAL_POOL_KEY] = pool;
  return pool;
}

/** Test helper — drops the cached pool so cases can re-mock `pg`. */
export function __resetSharedPgPoolForTests(): void {
  const globalStore = globalThis as { [key: symbol]: unknown };
  delete globalStore[GLOBAL_POOL_KEY];
}
