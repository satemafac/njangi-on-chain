/**
 * GET /api/legal/status (docs/legal-drafts/ACCEPTANCE-GATE-SPEC.md):
 * acceptance-gate status for the verified session identity. Versions are
 * compared server-side against CURRENT_LEGAL_VERSIONS — the client cannot
 * influence which versions are checked.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import handler from '@/pages/api/legal/status';
import { getZkLoginSessionAccount } from '@/lib/zklogin-session-registry';
import { getLegalAcceptanceStatus } from '@/lib/legal-acceptance-server';
import { consumeRateLimit } from '@/lib/rate-limit';
import { CURRENT_LEGAL_VERSIONS, LEGAL_DOC_IDS } from '@/lib/legal-acceptance';
import type { AccountData } from '@/services/zkLoginService';

jest.mock('@/lib/zklogin-session-registry', () => ({
  getZkLoginSessionAccount: jest.fn(),
}));

jest.mock('@/lib/legal-acceptance-server', () => ({
  getLegalAcceptanceStatus: jest.fn(),
}));

jest.mock('@/lib/rate-limit', () => ({
  consumeRateLimit: jest.fn(),
}));

const mockedSession = getZkLoginSessionAccount as jest.MockedFunction<
  typeof getZkLoginSessionAccount
>;
const mockedStatus = getLegalAcceptanceStatus as jest.MockedFunction<
  typeof getLegalAcceptanceStatus
>;
const mockedRateLimit = consumeRateLimit as jest.MockedFunction<typeof consumeRateLimit>;

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

function createReq(method = 'GET', query: Record<string, unknown> = {}): NextApiRequest {
  return {
    method,
    body: undefined,
    headers: { 'x-forwarded-for': '203.0.113.7' },
    query,
    cookies: { 'session-id': 'sess-1' },
    socket: { remoteAddress: '203.0.113.7' },
  } as unknown as NextApiRequest;
}

function sessionAccount(): AccountData {
  return { sub: 'oauth-sub', aud: 'oauth-aud', userAddr: '0xabc' } as AccountData;
}

describe('GET /api/legal/status', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    mockedSession.mockResolvedValue(sessionAccount());
    mockedRateLimit.mockResolvedValue({ allowed: true, remaining: 29, resetMs: 1000 });
    mockedStatus.mockResolvedValue({
      required: LEGAL_DOC_IDS.map((doc) => ({
        doc,
        currentVersion: CURRENT_LEGAL_VERSIONS[doc],
        acceptedVersion: null,
      })),
      missing: [...LEGAL_DOC_IDS],
      allAccepted: false,
    });
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('rejects non-GET methods with 405', async () => {
    const res = createRes();
    await handler(createReq('POST'), res);
    expect(res.statusCode).toBe(405);
    expect(res.headers['Allow']).toBe('GET');
  });

  it('returns 429 with Retry-After when rate limited', async () => {
    mockedRateLimit.mockResolvedValue({ allowed: false, remaining: 0, resetMs: 15000 });
    const res = createRes();
    await handler(createReq(), res);
    expect(res.statusCode).toBe(429);
    expect(res.headers['Retry-After']).toBe('15');
    expect(mockedStatus).not.toHaveBeenCalled();
  });

  it('returns 401 without a verified zkLogin session and leaks nothing', async () => {
    mockedSession.mockResolvedValue(null);
    const res = createRes();
    await handler(createReq(), res);
    expect(res.statusCode).toBe(401);
    expect(res.jsonBody).toEqual(
      expect.objectContaining({ error: 'AUTH_REQUIRED', requiresReauth: true }),
    );
    expect(mockedStatus).not.toHaveBeenCalled();
  });

  it('reports missing docs for a first-login user (gate trigger)', async () => {
    const res = createRes();
    await handler(createReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody).toEqual({
      success: true,
      allAccepted: false,
      accepted: false,
      missing: [...LEGAL_DOC_IDS],
      required: LEGAL_DOC_IDS.map((doc) => ({
        doc,
        currentVersion: CURRENT_LEGAL_VERSIONS[doc],
        acceptedVersion: null,
      })),
    });
  });

  it('resolves versions server-side: lookup uses only the session identity', async () => {
    const res = createRes();
    // A client attempting to pin versions via the query string is ignored.
    await handler(createReq('GET', { versions: '{"terms":"0.0.1"}' }), res);
    expect(mockedStatus).toHaveBeenCalledTimes(1);
    expect(mockedStatus).toHaveBeenCalledWith('oauth-sub', 'oauth-aud');
  });

  it('reports a version bump as missing for the bumped doc only', async () => {
    mockedStatus.mockResolvedValue({
      required: [
        { doc: 'terms', currentVersion: '1.1.0', acceptedVersion: '1.0.0' },
        { doc: 'privacy', currentVersion: '1.0.0', acceptedVersion: '1.0.0' },
        { doc: 'risk', currentVersion: '1.0.0', acceptedVersion: '1.0.0' },
      ],
      missing: ['terms'],
      allAccepted: false,
    });
    const res = createRes();
    await handler(createReq(), res);
    expect(res.statusCode).toBe(200);
    expect((res.jsonBody as { missing: string[] }).missing).toEqual(['terms']);
    expect((res.jsonBody as { allAccepted: boolean }).allAccepted).toBe(false);
  });

  it('returns 500 without leaking internals when the store fails', async () => {
    mockedStatus.mockRejectedValue(new Error('connect ECONNREFUSED password=hunter2'));
    const res = createRes();
    await handler(createReq(), res);
    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(res.jsonBody)).not.toContain('hunter2');
  });
});
