/**
 * POST /api/legal/data-deletion-request (June 2026 legal surface): records a
 * deletion request in the deletion_requests table. Unauthenticated by design
 * (a locked-out user must still be able to request deletion), so the endpoint
 * is honeypot- and rate-limit guarded. The raw client IP is never persisted —
 * only an HMAC keyed with LEGAL_ACCEPT_IP_SALT.
 */

import { createHmac } from 'node:crypto';
import type { NextApiRequest, NextApiResponse } from 'next';
import handler from '@/pages/api/legal/data-deletion-request';
import { consumeRateLimit } from '@/lib/rate-limit';
import { getSharedPgPool, isPostgresConfigured } from '@/lib/pg-pool';

jest.mock('@/lib/rate-limit', () => ({
  consumeRateLimit: jest.fn(),
}));

jest.mock('@/lib/pg-pool', () => ({
  getSharedPgPool: jest.fn(),
  isPostgresConfigured: jest.fn(),
}));

const mockedRateLimit = consumeRateLimit as jest.MockedFunction<typeof consumeRateLimit>;
const mockedIsConfigured = isPostgresConfigured as jest.MockedFunction<typeof isPostgresConfigured>;
const mockedGetPool = getSharedPgPool as jest.MockedFunction<typeof getSharedPgPool>;

type MockRes = NextApiResponse & {
  statusCode: number;
  jsonBody: unknown;
  headers: Record<string, unknown>;
};

function createRes(): MockRes {
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
  return res as unknown as MockRes;
}

function createReq(body: Record<string, unknown> = {}, method = 'POST'): NextApiRequest {
  return {
    method,
    body,
    headers: { 'x-forwarded-for': '203.0.113.7' },
    query: {},
    cookies: {},
    socket: { remoteAddress: '203.0.113.7' },
  } as unknown as NextApiRequest;
}

function mockQueryOnce(rowCount: number) {
  const query = jest.fn().mockResolvedValue({ rowCount, rows: rowCount ? [{ id: 1 }] : [] });
  mockedGetPool.mockReturnValue({ query } as unknown as ReturnType<typeof getSharedPgPool>);
  return query;
}

const VALID_BODY = {
  email: 'Member@Example.com',
  userAddress: '0xabc123',
  details: 'please delete everything',
  locale: 'fr',
};

describe('POST /api/legal/data-deletion-request', () => {
  let consoleLogSpy: jest.SpyInstance;
  let consoleWarnSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    delete process.env.LEGAL_ACCEPT_IP_SALT;
    mockedIsConfigured.mockReturnValue(true);
    mockedRateLimit.mockResolvedValue({ allowed: true, remaining: 2, resetMs: 1000 });
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    delete process.env.LEGAL_ACCEPT_IP_SALT;
    consoleLogSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('rejects non-POST methods with 405 and an Allow header', async () => {
    const res = createRes();
    await handler(createReq({}, 'GET'), res);
    expect(res.statusCode).toBe(405);
    expect(res.headers['Allow']).toBe('POST');
  });

  it('rejects an invalid email with 400 before any database work', async () => {
    const query = mockQueryOnce(1);
    const res = createRes();
    await handler(createReq({ email: 'not-an-email' }), res);
    expect(res.statusCode).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects a malformed Sui address with 400', async () => {
    const res = createRes();
    await handler(createReq({ email: 'a@b.co', userAddress: 'sui:nope' }), res);
    expect(res.statusCode).toBe(400);
  });

  it('rejects oversized details with 400', async () => {
    const res = createRes();
    await handler(createReq({ email: 'a@b.co', details: 'x'.repeat(1001) }), res);
    expect(res.statusCode).toBe(400);
  });

  it('pretends success on a tripped honeypot without touching the database', async () => {
    const query = mockQueryOnce(1);
    const res = createRes();
    await handler(createReq({ ...VALID_BODY, website: 'http://spam.example' }), res);
    expect(res.statusCode).toBe(200);
    expect((res.jsonBody as { success: boolean }).success).toBe(true);
    expect(query).not.toHaveBeenCalled();
    expect(mockedRateLimit).not.toHaveBeenCalled();
  });

  it('returns 429 with Retry-After when rate limited', async () => {
    mockedRateLimit.mockResolvedValue({ allowed: false, remaining: 0, resetMs: 30000 });
    const query = mockQueryOnce(1);
    const res = createRes();
    await handler(createReq(VALID_BODY), res);
    expect(res.statusCode).toBe(429);
    expect(res.headers['Retry-After']).toBe('30');
    expect(query).not.toHaveBeenCalled();
  });

  it('records the request with a normalized email and null ip_hash when no salt is set', async () => {
    const query = mockQueryOnce(1);
    const res = createRes();
    await handler(createReq(VALID_BODY), res);

    expect(res.statusCode).toBe(200);
    expect(res.jsonBody).toEqual({ success: true, alreadyPending: false });
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO deletion_requests');
    expect(sql).toContain("ON CONFLICT (email) WHERE status = 'pending' DO NOTHING");
    expect(params).toEqual(['member@example.com', '0xabc123', 'please delete everything', 'fr', null]);
  });

  it('stores an HMAC of the client IP — never the raw IP — when the salt is set', async () => {
    process.env.LEGAL_ACCEPT_IP_SALT = 'test-salt';
    const query = mockQueryOnce(1);
    const res = createRes();
    await handler(createReq(VALID_BODY), res);

    const params = (query.mock.calls[0] as [string, unknown[]])[1];
    const expected = createHmac('sha256', 'test-salt').update('203.0.113.7').digest('hex');
    expect(params[4]).toBe(expected);
    expect(JSON.stringify(params)).not.toContain('203.0.113.7');
  });

  it('treats a duplicate pending request as success with alreadyPending=true', async () => {
    mockQueryOnce(0);
    const res = createRes();
    await handler(createReq(VALID_BODY), res);
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody).toEqual({ success: true, alreadyPending: true });
  });

  it('returns 500 without leaking driver errors when the insert fails', async () => {
    mockedGetPool.mockReturnValue({
      query: jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED password=hunter2')),
    } as unknown as ReturnType<typeof getSharedPgPool>);
    const res = createRes();
    await handler(createReq(VALID_BODY), res);
    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(res.jsonBody)).not.toContain('hunter2');
  });

  it('accepts without persisting when Postgres is unconfigured outside production', async () => {
    mockedIsConfigured.mockReturnValue(false);
    const res = createRes();
    await handler(createReq(VALID_BODY), res);
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody).toEqual({ success: true, alreadyPending: false });
    expect(mockedGetPool).not.toHaveBeenCalled();
    expect(consoleWarnSpy).toHaveBeenCalled();
  });
});
