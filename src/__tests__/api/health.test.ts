/**
 * /api/health (June 2026 platform hardening): uptime probe for the Vercel
 * deployment. Two modes: LIVENESS (default, no DB — always 200 when the app
 * is serving, so the frequent uptime ping never wakes Neon) and READINESS
 * (?deep=1 — runs SELECT 1, 200/503). The body must report version +
 * network and must never echo connection strings or raw driver errors.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import handler from '@/pages/api/health';
import { getSharedPgPool, isPostgresConfigured } from '@/lib/pg-pool';

jest.mock('@/lib/pg-pool', () => ({
  getSharedPgPool: jest.fn(),
  isPostgresConfigured: jest.fn(),
}));

const mockedIsConfigured = isPostgresConfigured as jest.MockedFunction<typeof isPostgresConfigured>;
const mockedGetPool = getSharedPgPool as jest.MockedFunction<typeof getSharedPgPool>;

interface MockRes {
  statusCode: number;
  jsonBody: unknown;
  headers: Record<string, unknown>;
}

function createMockRes(): NextApiResponse & MockRes {
  const res = {
    statusCode: 0,
    jsonBody: undefined as unknown,
    headers: {} as Record<string, unknown>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.jsonBody = body;
      return this;
    },
    setHeader(key: string, value: unknown) {
      this.headers[key] = value;
      return this;
    },
  };
  return res as unknown as NextApiResponse & MockRes;
}

function createReq(
  method = 'GET',
  query: Record<string, string> = {},
): NextApiRequest {
  return { method, headers: {}, query, cookies: {} } as unknown as NextApiRequest;
}

const DEEP = { deep: '1' };

describe('/api/health', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('liveness (default): returns 200 without touching Postgres', async () => {
    mockedIsConfigured.mockReturnValue(true);

    const res = createMockRes();
    await handler(createReq(), res);

    expect(res.statusCode).toBe(200);
    const body = res.jsonBody as Record<string, unknown>;
    expect(body.status).toBe('ok');
    expect(body.mode).toBe('liveness');
    expect(body.db).toEqual({ ok: false, checked: false, reason: 'skipped' });
    // The whole point: the frequent probe must not wake the database.
    expect(mockedGetPool).not.toHaveBeenCalled();
    expect(res.headers['Cache-Control']).toBe('no-store, max-age=0');
  });

  it('liveness stays 200 even when the DB is down (app is still serving)', async () => {
    mockedIsConfigured.mockReturnValue(false);

    const res = createMockRes();
    await handler(createReq(), res);

    expect(res.statusCode).toBe(200);
    expect((res.jsonBody as Record<string, unknown>).status).toBe('ok');
    expect(mockedGetPool).not.toHaveBeenCalled();
  });

  it('readiness (?deep=1): returns 200 with db latency when SELECT 1 succeeds', async () => {
    mockedIsConfigured.mockReturnValue(true);
    mockedGetPool.mockReturnValue({
      query: jest.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }),
    } as unknown as ReturnType<typeof getSharedPgPool>);

    const res = createMockRes();
    await handler(createReq('GET', DEEP), res);

    expect(res.statusCode).toBe(200);
    const body = res.jsonBody as Record<string, unknown>;
    expect(body.status).toBe('ok');
    expect(body.mode).toBe('readiness');
    expect(typeof body.version).toBe('string');
    expect(['testnet', 'mainnet']).toContain(body.network);
    const db = body.db as Record<string, unknown>;
    expect(db.ok).toBe(true);
    expect(db.checked).toBe(true);
    expect(typeof db.latencyMs).toBe('number');
    expect(res.headers['Cache-Control']).toBe('no-store, max-age=0');
  });

  it('readiness returns 503 with reason "unconfigured" when DATABASE_URL is missing', async () => {
    mockedIsConfigured.mockReturnValue(false);

    const res = createMockRes();
    await handler(createReq('GET', DEEP), res);

    expect(res.statusCode).toBe(503);
    const body = res.jsonBody as Record<string, unknown>;
    expect(body.status).toBe('unhealthy');
    expect(body.db).toEqual({ ok: false, checked: true, reason: 'unconfigured' });
    expect(mockedGetPool).not.toHaveBeenCalled();
  });

  it('readiness returns 503 without leaking driver error details when the query fails', async () => {
    mockedIsConfigured.mockReturnValue(true);
    mockedGetPool.mockReturnValue({
      query: jest
        .fn()
        .mockRejectedValue(new Error('connect ECONNREFUSED db.internal:5432 password=hunter2')),
    } as unknown as ReturnType<typeof getSharedPgPool>);

    const res = createMockRes();
    await handler(createReq('GET', DEEP), res);

    expect(res.statusCode).toBe(503);
    const body = res.jsonBody as Record<string, unknown>;
    expect(body.db).toEqual({ ok: false, checked: true, reason: 'unreachable' });
    expect(JSON.stringify(body)).not.toContain('hunter2');
    expect(JSON.stringify(body)).not.toContain('ECONNREFUSED');
  });

  it('rejects non-GET methods with 405', async () => {
    const res = createMockRes();
    await handler(createReq('POST'), res);

    expect(res.statusCode).toBe(405);
    expect(res.headers['Allow']).toBe('GET, HEAD');
  });
});
