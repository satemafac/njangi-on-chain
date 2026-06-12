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

import { consumeRateLimit, __resetRateLimitForTests } from '../rate-limit';
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
