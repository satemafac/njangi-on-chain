// /api/health — liveness/readiness probe for uptime checks (June 2026
// ops-readiness audit: "no health endpoint, error tracking, or alerting").
//
// Returns 200 when the app can reach Postgres, 503 otherwise. Reports the
// package.json version (inlined at build via NEXT_PUBLIC_APP_VERSION in
// next.config.js) and the active Sui network. Never echoes connection
// strings or error internals — DB failures are logged server-side and
// surfaced as a generic reason.
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSharedPgPool, isPostgresConfigured } from '../../lib/pg-pool';

const DB_CHECK_TIMEOUT_MS = 5_000;

interface DatabaseStatus {
  ok: boolean;
  latencyMs?: number;
  reason?: 'unconfigured' | 'timeout' | 'unreachable';
}

export interface HealthResponse {
  status: 'ok' | 'unhealthy';
  version: string;
  network: 'testnet' | 'mainnet';
  db: DatabaseStatus;
  timestamp: string;
}

async function checkDatabase(): Promise<DatabaseStatus> {
  if (!isPostgresConfigured()) {
    return { ok: false, reason: 'unconfigured' };
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
    return { ok: true, latencyMs: Date.now() - startedAt };
  } catch (error) {
    const isTimeout = error instanceof Error && error.message === 'health-db-timeout';
    console.error('[health] database check failed:', error);
    return { ok: false, reason: isTimeout ? 'timeout' : 'unreachable' };
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

  const db = await checkDatabase();
  const healthy = db.ok;

  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'unhealthy',
    version: process.env.NEXT_PUBLIC_APP_VERSION ?? 'unknown',
    network: process.env.NEXT_PUBLIC_SUI_NETWORK === 'mainnet' ? 'mainnet' : 'testnet',
    db,
    timestamp: new Date().toISOString(),
  });
}
