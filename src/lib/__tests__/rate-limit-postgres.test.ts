/**
 * Tests for the Postgres-backed rate limiter mode (Vercel serverless
 * migration, June 2026). The pg pool is mocked; assertions cover the
 * atomic upsert contract, window rollover, fail-open fallback, and the
 * unchanged in-memory dev path.
 */

jest.mock('../pg-pool', () => {
  const query = jest.fn();
  return {
    getSharedPgPool: () => ({ query }),
    isPostgresConfigured: () => Boolean(process.env.DATABASE_URL),
    assertDatabaseUrlInProduction: jest.fn(),
    resolvePgSsl: jest.fn(),
    __resetSharedPgPoolForTests: jest.fn(),
  };
});

import {
  consumeRateLimit,
  peekRateLimit,
  isSweepDue,
  STALE_WINDOW_RETENTION_MS,
  SWEEP_INTERVAL_MS,
  __resetRateLimitForTests,
} from '../rate-limit';
import { getSharedPgPool } from '../pg-pool';

const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

function getQueryMock(): jest.Mock {
  return (getSharedPgPool() as unknown as { query: jest.Mock }).query;
}

afterEach(() => {
  if (ORIGINAL_DATABASE_URL) {
    process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
  } else {
    delete process.env.DATABASE_URL;
  }
  __resetRateLimitForTests();
  jest.restoreAllMocks();
});

describe('in-memory mode (no DATABASE_URL)', () => {
  beforeEach(() => {
    delete process.env.DATABASE_URL;
    __resetRateLimitForTests();
  });

  it('allows up to the limit then blocks, without touching Postgres', async () => {
    const queryMock = getQueryMock();
    queryMock.mockReset();

    const opts = { key: 'mem-key', limit: 2, windowMs: 60_000 };
    expect((await consumeRateLimit(opts)).allowed).toBe(true);
    expect((await consumeRateLimit(opts)).allowed).toBe(true);
    const third = await consumeRateLimit(opts);
    expect(third.allowed).toBe(false);
    expect(third.remaining).toBe(0);
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe('Postgres mode', () => {
  // Fake (bucket, window_start) → count table backing the upsert.
  const counts = new Map<string, number>();

  beforeEach(() => {
    process.env.DATABASE_URL = 'postgres://unit:test@localhost:5432/fake';
    counts.clear();
    __resetRateLimitForTests();

    const queryMock = getQueryMock();
    queryMock.mockReset();
    queryMock.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('CREATE TABLE')) {
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO rate_limits')) {
        const [bucket, windowStartMs] = params as [string, number];
        const key = `${bucket}:${windowStartMs}`;
        const next = (counts.get(key) ?? 0) + 1;
        counts.set(key, next);
        return { rows: [{ count: next }] };
      }
      if (sql.startsWith('DELETE FROM rate_limits')) {
        // Table-wide stale sweep: drop every fake row whose window start is
        // older than the cutoff the limiter passed.
        const [cutoffMs] = params as [number];
        for (const key of [...counts.keys()]) {
          const windowStartMs = Number(key.slice(key.lastIndexOf(':') + 1));
          if (windowStartMs < cutoffMs) counts.delete(key);
        }
        return { rows: [], rowCount: 0 };
      }
      throw new Error(`Unexpected SQL in test: ${sql}`);
    });
  });

  it('counts via an atomic upsert keyed by bucket + window start', async () => {
    const windowMs = 60_000;
    const result = await consumeRateLimit({ key: 'pg-key', limit: 3, windowMs });

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(2);
    expect(result.resetMs).toBeGreaterThan(0);
    expect(result.resetMs).toBeLessThanOrEqual(windowMs);

    const upsertCall = getQueryMock().mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO rate_limits'),
    );
    expect(upsertCall).toBeDefined();
    const [sql, params] = upsertCall as [string, [string, number]];
    expect(sql).toContain('ON CONFLICT (bucket, window_start)');
    expect(sql).toContain('DO UPDATE SET count = rate_limits.count + 1');
    expect(params[0]).toBe('pg-key');
    // Window start is aligned to the window length.
    expect(params[1] % windowMs).toBe(0);
  });

  it('blocks once the shared count exceeds the limit', async () => {
    const opts = { key: 'pg-burst', limit: 2, windowMs: 60_000 };
    expect((await consumeRateLimit(opts)).allowed).toBe(true);
    expect((await consumeRateLimit(opts)).allowed).toBe(true);

    const third = await consumeRateLimit(opts);
    expect(third.allowed).toBe(false);
    expect(third.remaining).toBe(0);
  });

  it('isolates buckets from each other', async () => {
    const opts = { limit: 1, windowMs: 60_000 };
    expect((await consumeRateLimit({ ...opts, key: 'bucket-a' })).allowed).toBe(true);
    expect((await consumeRateLimit({ ...opts, key: 'bucket-a' })).allowed).toBe(false);
    expect((await consumeRateLimit({ ...opts, key: 'bucket-b' })).allowed).toBe(true);
  });

  it('starts a fresh window after the previous one elapses', async () => {
    const windowMs = 60_000;
    const opts = { key: 'pg-roll', limit: 1, windowMs };
    const t0 = Date.now();

    expect((await consumeRateLimit(opts)).allowed).toBe(true);
    expect((await consumeRateLimit(opts)).allowed).toBe(false);

    // Advance past the window boundary → different window_start key.
    jest.spyOn(Date, 'now').mockReturnValue(t0 + windowMs + 1);
    expect((await consumeRateLimit(opts)).allowed).toBe(true);
  });

  it('creates the window_start index alongside the table', async () => {
    await consumeRateLimit({ key: 'pg-setup', limit: 1, windowMs: 60_000 });
    const setup = getQueryMock().mock.calls.find(([sql]) => String(sql).includes('CREATE TABLE'));
    expect(setup).toBeDefined();
    expect(String(setup?.[0])).toContain(
      'CREATE INDEX IF NOT EXISTS rate_limits_window_start_idx',
    );
  });

  it('fails open onto the in-memory window when Postgres errors', async () => {
    const queryMock = getQueryMock();
    queryMock.mockReset();
    queryMock.mockRejectedValue(new Error('connection refused'));
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    const opts = { key: 'pg-down', limit: 2, windowMs: 60_000 };
    expect((await consumeRateLimit(opts)).allowed).toBe(true);
    expect((await consumeRateLimit(opts)).allowed).toBe(true);
    // The in-memory fallback still enforces the bound per instance.
    expect((await consumeRateLimit(opts)).allowed).toBe(false);
    expect(warnSpy).toHaveBeenCalled();
  });
});

describe('stale-window sweep (Postgres mode)', () => {
  const sweepCalls = () =>
    getQueryMock().mock.calls.filter(([sql]) => String(sql).startsWith('DELETE FROM rate_limits'));

  beforeEach(() => {
    process.env.DATABASE_URL = 'postgres://unit:test@localhost:5432/fake';
    __resetRateLimitForTests();
    const queryMock = getQueryMock();
    queryMock.mockReset();
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO rate_limits')) return { rows: [{ count: 1 }] };
      return { rows: [], rowCount: 0 };
    });
  });

  it('isSweepDue: due on the first write of a process, then once per interval', () => {
    expect(isSweepDue(1_000, 0)).toBe(true);
    expect(isSweepDue(1_000, 1_000)).toBe(false);
    expect(isSweepDue(1_000 + SWEEP_INTERVAL_MS - 1, 1_000)).toBe(false);
    expect(isSweepDue(1_000 + SWEEP_INTERVAL_MS, 1_000)).toBe(true);
    expect(isSweepDue(5_000, 1_000, 4_000)).toBe(true);
  });

  it('runs one 24-hour sweep on the first write, then none until an hour has passed', async () => {
    const t0 = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(t0);
    const opts = { key: 'sweep-a', limit: 10, windowMs: 60_000 };

    await consumeRateLimit(opts);
    expect(sweepCalls()).toHaveLength(1);
    const [sql, params] = sweepCalls()[0] as [string, [number]];
    expect(sql).toContain('WHERE window_start < to_timestamp($1 / 1000.0)');
    expect(params[0]).toBe(t0 - STALE_WINDOW_RETENTION_MS);
    expect(STALE_WINDOW_RETENTION_MS).toBe(24 * 60 * 60 * 1000);

    await consumeRateLimit(opts);
    await consumeRateLimit({ ...opts, key: 'sweep-b' });
    expect(sweepCalls()).toHaveLength(1);

    (Date.now as jest.Mock).mockReturnValue(t0 + SWEEP_INTERVAL_MS - 1);
    await consumeRateLimit(opts);
    expect(sweepCalls()).toHaveLength(1);

    (Date.now as jest.Mock).mockReturnValue(t0 + SWEEP_INTERVAL_MS);
    await consumeRateLimit(opts);
    expect(sweepCalls()).toHaveLength(2);
  });

  it('never sweeps on a peek', async () => {
    await peekRateLimit({ key: 'sweep-peek', limit: 1, windowMs: 60_000 });
    expect(sweepCalls()).toHaveLength(0);
  });

  it('a failed sweep is logged, the request still gets its verdict, and no retry happens before the interval', async () => {
    const t0 = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(t0);
    const queryMock = getQueryMock();
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO rate_limits')) return { rows: [{ count: 1 }] };
      if (sql.startsWith('DELETE FROM rate_limits')) throw new Error('lock timeout');
      return { rows: [] };
    });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await consumeRateLimit({ key: 'sweep-fail', limit: 2, windowMs: 60_000 });
    expect(result).toMatchObject({ allowed: true, remaining: 1 });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain('sweep failed');

    await consumeRateLimit({ key: 'sweep-fail', limit: 2, windowMs: 60_000 });
    expect(sweepCalls()).toHaveLength(1);
    // The upsert itself did not fall back to the in-memory window.
    expect(queryMock.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO')).length).toBe(2);
  });
});

describe('peekRateLimit (read-only check)', () => {
  it('in-memory: never spends a slot, and reflects what consume() did', async () => {
    delete process.env.DATABASE_URL;
    __resetRateLimitForTests();
    const opts = { key: 'peek-mem', limit: 1, windowMs: 60_000 };
    expect((await peekRateLimit(opts)).allowed).toBe(true);
    expect((await peekRateLimit(opts)).allowed).toBe(true); // still not spent
    expect((await consumeRateLimit(opts)).allowed).toBe(true);
    const after = await peekRateLimit(opts);
    expect(after.allowed).toBe(false);
    expect(after.remaining).toBe(0);
    expect(after.resetMs).toBeGreaterThan(0);
    expect(getQueryMock()).not.toHaveBeenCalled();
  });

  it('postgres: issues a SELECT, never the upsert, and reports the window state', async () => {
    process.env.DATABASE_URL = 'postgres://example';
    __resetRateLimitForTests();
    const queryMock = getQueryMock();
    queryMock.mockReset();
    queryMock.mockResolvedValueOnce({ rows: [] }); // CREATE TABLE
    queryMock.mockResolvedValueOnce({ rows: [{ count: 1 }] }); // SELECT
    const result = await peekRateLimit({ key: 'peek-pg', limit: 1, windowMs: 60_000 });
    expect(result.allowed).toBe(false);
    const sqls = queryMock.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((q) => /SELECT count FROM rate_limits/.test(q))).toBe(true);
    expect(sqls.some((q) => /INSERT INTO rate_limits/.test(q))).toBe(false);
  });

  it('postgres: an empty window peeks as allowed with the full limit remaining', async () => {
    process.env.DATABASE_URL = 'postgres://example';
    __resetRateLimitForTests();
    const queryMock = getQueryMock();
    queryMock.mockReset();
    queryMock.mockResolvedValueOnce({ rows: [] });
    queryMock.mockResolvedValueOnce({ rows: [] });
    const result = await peekRateLimit({ key: 'peek-pg-empty', limit: 5, windowMs: 60_000 });
    expect(result).toMatchObject({ allowed: true, remaining: 5 });
  });
});
