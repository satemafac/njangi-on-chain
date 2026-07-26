// /api/health — liveness/readiness probe for uptime checks (June 2026
// ops-readiness audit: "no health endpoint, error tracking, or alerting").
//
// Two modes, so the frequent uptime ping never wakes the database:
//   - LIVENESS (default): no DB query. 200 + status:"ok" whenever the app
//     is serving. Safe to call every few minutes — it touches no Postgres,
//     so Neon can autosuspend (a DB query more often than the ~5-min
//     suspend window pins the compute awake 24/7 and burns the free-tier
//     compute quota — the 2026-07-21 outage; see docs comment on the cron
//     probe in src/lib/cron-event-probe.ts).
//   - READINESS (?deep=1): runs `SELECT 1`. 200 when reachable, 503
//     otherwise. Call this on a slower cadence (e.g. every 30 min) so a
//     Neon outage is still caught without keeping the DB perpetually awake.
//
// Never echoes connection strings or error internals — DB failures are
// logged server-side and surfaced as a generic reason. Reports the
// package.json version (inlined at build via NEXT_PUBLIC_APP_VERSION) and
// the active Sui network.
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSharedPgPool, isPostgresConfigured } from '../../lib/pg-pool';

const DB_CHECK_TIMEOUT_MS = 5_000;

interface DatabaseStatus {
  ok: boolean;
  /** False in liveness mode — the DB was intentionally not probed. */
  checked: boolean;
  latencyMs?: number;
  reason?: 'unconfigured' | 'timeout' | 'unreachable' | 'skipped';
}

export interface HealthResponse {
  status: 'ok' | 'unhealthy';
  version: string;
  network: 'testnet' | 'mainnet';
  /** Which probe ran — 'liveness' (no DB) or 'readiness' (DB checked). */
  mode: 'liveness' | 'readiness';
  db: DatabaseStatus;
  timestamp: string;
}

async function checkDatabase(): Promise<DatabaseStatus> {
  if (!isPostgresConfigured()) {
    return { ok: false, checked: true, reason: 'unconfigured' };
  }

  const startedAt = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    const pool = getSharedPgPool();
    await Promise.race([
      pool.query('SELECT 1'),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('health-db-timeout')),
          DB_CHECK_TIMEOUT_MS,
        );
      }),
    ]);
    return { ok: true, checked: true, latencyMs: Date.now() - startedAt };
  } catch (error) {
    const isTimeout = error instanceof Error && error.message === 'health-db-timeout';
    console.error('[health] database check failed:', error);
    return { ok: false, checked: true, reason: isTimeout ? 'timeout' : 'unreachable' };
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<HealthResponse | { error: string }>,
): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const deep = req.query.deep === '1' || req.query.deep === 'true';
  // Liveness never touches Postgres, so it stays green (and leaves Neon
  // asleep) even during a DB outage — that's the point: it answers "is the
  // app serving?", which it is if we reached this handler.
  const db: DatabaseStatus = deep
    ? await checkDatabase()
    : { ok: false, checked: false, reason: 'skipped' };
  const healthy = deep ? db.ok : true;

  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'unhealthy',
    version: process.env.NEXT_PUBLIC_APP_VERSION ?? 'unknown',
    network: process.env.NEXT_PUBLIC_SUI_NETWORK === 'mainnet' ? 'mainnet' : 'testnet',
    mode: deep ? 'readiness' : 'liveness',
    db,
    timestamp: new Date().toISOString(),
  });
}
