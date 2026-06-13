/**
 * POST /api/legal/accept (docs/legal-drafts/ACCEPTANCE-GATE-SPEC.md):
 * records versioned legal acceptances bound to the server-verified zkLogin
 * session. Versions are server-resolved — any body attempting to supply
 * them is rejected — and identity NEVER comes from the request body.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import handler from '@/pages/api/legal/accept';
import { getZkLoginSessionAccount } from '@/lib/zklogin-session-registry';
import {
  getLegalAcceptanceStatus,
  hashAcceptanceIp,
  recordLegalAcceptances,
} from '@/lib/legal-acceptance-server';
import { consumeRateLimit } from '@/lib/rate-limit';
import { CURRENT_LEGAL_VERSIONS, LEGAL_DOC_IDS } from '@/lib/legal-acceptance';
import type { AccountData } from '@/services/zkLoginService';

jest.mock('@/lib/zklogin-session-registry', () => ({
  getZkLoginSessionAccount: jest.fn(),
}));

jest.mock('@/lib/legal-acceptance-server', () => ({
  getLegalAcceptanceStatus: jest.fn(),
  hashAcceptanceIp: jest.fn(),
  recordLegalAcceptances: jest.fn(),
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
const mockedHashIp = hashAcceptanceIp as jest.MockedFunction<typeof hashAcceptanceIp>;
const mockedRecord = recordLegalAcceptances as jest.MockedFunction<
  typeof recordLegalAcceptances
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

function createReq(body: unknown, method = 'POST'): NextApiRequest {
  return {
    method,
    body,
    headers: { 'x-forwarded-for': '203.0.113.7' },
    query: {},
    cookies: { 'session-id': 'sess-1' },
    socket: { remoteAddress: '203.0.113.7' },
  } as unknown as NextApiRequest;
}

function sessionAccount(): AccountData {
  return { sub: 'oauth-sub', aud: 'oauth-aud', userAddr: '0xabc' } as AccountData;
}

function statusOf(missing: Array<'terms' | 'privacy' | 'risk'>) {
  return {
    required: LEGAL_DOC_IDS.map((doc) => ({
      doc,
      currentVersion: CURRENT_LEGAL_VERSIONS[doc],
      acceptedVersion: missing.includes(doc) ? null : CURRENT_LEGAL_VERSIONS[doc],
    })),
    missing,
    allAccepted: missing.length === 0,
  };
}

const ALL_DOCS = ['terms', 'privacy', 'risk'] as const;

describe('POST /api/legal/accept', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    mockedSession.mockResolvedValue(sessionAccount());
    mockedRateLimit.mockResolvedValue({ allowed: true, remaining: 9, resetMs: 1000 });
    mockedStatus.mockResolvedValue(statusOf([...ALL_DOCS]));
    mockedHashIp.mockReturnValue('ip-hmac');
    mockedRecord.mockResolvedValue(
      ALL_DOCS.map((doc) => ({ doc, version: CURRENT_LEGAL_VERSIONS[doc], inserted: true })),
    );
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('rejects non-POST methods with 405', async () => {
    const res = createRes();
    await handler(createReq({}, 'GET'), res);
    expect(res.statusCode).toBe(405);
    expect(res.headers['Allow']).toBe('POST');
  });

  it('rejects a body attempting to supply versions (strict schema)', async () => {
    const res = createRes();
    await handler(
      createReq({ docs: [...ALL_DOCS], locale: 'en', versions: { terms: '9.9.9' } }),
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(mockedRecord).not.toHaveBeenCalled();
  });

  it('rejects per-doc version objects (docs must be plain ids)', async () => {
    const res = createRes();
    await handler(createReq({ docs: [{ doc: 'terms', version: '9.9.9' }], locale: 'en' }), res);
    expect(res.statusCode).toBe(400);
    expect(mockedRecord).not.toHaveBeenCalled();
  });

  it('rejects body-supplied identity fields — acceptance binds to the session only', async () => {
    const res = createRes();
    await handler(
      createReq({
        docs: [...ALL_DOCS],
        locale: 'en',
        sub: 'attacker-sub',
        userAddress: '0xattacker',
      }),
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(mockedRecord).not.toHaveBeenCalled();
  });

  it('rejects unknown document ids', async () => {
    const res = createRes();
    await handler(createReq({ docs: ['terms', 'yield-waiver'], locale: 'en' }), res);
    expect(res.statusCode).toBe(400);
  });

  it('returns 429 with Retry-After when rate limited', async () => {
    mockedRateLimit.mockResolvedValue({ allowed: false, remaining: 0, resetMs: 30000 });
    const res = createRes();
    await handler(createReq({ docs: [...ALL_DOCS], locale: 'en' }), res);
    expect(res.statusCode).toBe(429);
    expect(res.headers['Retry-After']).toBe('30');
    expect(mockedRecord).not.toHaveBeenCalled();
  });

  it('returns 401 without a verified zkLogin session', async () => {
    mockedSession.mockResolvedValue(null);
    const res = createRes();
    await handler(createReq({ docs: [...ALL_DOCS], locale: 'en' }), res);
    expect(res.statusCode).toBe(401);
    expect(res.jsonBody).toEqual(
      expect.objectContaining({ error: 'AUTH_REQUIRED', requiresReauth: true }),
    );
    expect(mockedRecord).not.toHaveBeenCalled();
  });

  it('rejects partial acceptance on first signup (all three docs required)', async () => {
    mockedStatus.mockResolvedValue(statusOf([...ALL_DOCS]));
    const res = createRes();
    await handler(createReq({ docs: ['terms'], locale: 'en' }), res);
    expect(res.statusCode).toBe(400);
    expect(res.jsonBody).toEqual(
      expect.objectContaining({ error: 'INCOMPLETE_ACCEPTANCE' }),
    );
    expect(mockedRecord).not.toHaveBeenCalled();
  });

  it('records all docs bound to the session identity with the server-resolved versions', async () => {
    const res = createRes();
    await handler(createReq({ docs: [...ALL_DOCS], locale: 'fr' }), res);

    expect(res.statusCode).toBe(200);
    expect(res.jsonBody).toEqual({
      success: true,
      allAccepted: true,
      recorded: ALL_DOCS.map((doc) => ({ doc, version: CURRENT_LEGAL_VERSIONS[doc] })),
    });
    // Identity comes from the verified session — not from any body field.
    expect(mockedRecord).toHaveBeenCalledWith(
      { sub: 'oauth-sub', aud: 'oauth-aud', userAddr: '0xabc' },
      [...ALL_DOCS],
      'fr',
      'ip-hmac',
    );
    expect(mockedHashIp).toHaveBeenCalledWith('203.0.113.7');
  });

  it('accepts only the changed doc after a version bump', async () => {
    mockedStatus.mockResolvedValue(statusOf(['terms']));
    mockedRecord.mockResolvedValue([{ doc: 'terms', version: '1.1.0', inserted: true }]);
    const res = createRes();
    await handler(createReq({ docs: ['terms'], locale: 'en' }), res);
    expect(res.statusCode).toBe(200);
    expect(mockedRecord).toHaveBeenCalledWith(
      { sub: 'oauth-sub', aud: 'oauth-aud', userAddr: '0xabc' },
      ['terms'],
      'en',
      'ip-hmac',
    );
  });

  it('treats a duplicate POST as success (idempotent unique index)', async () => {
    mockedStatus.mockResolvedValue(statusOf([]));
    mockedRecord.mockResolvedValue(
      ALL_DOCS.map((doc) => ({ doc, version: CURRENT_LEGAL_VERSIONS[doc], inserted: false })),
    );
    const res = createRes();
    await handler(createReq({ docs: [...ALL_DOCS], locale: 'en' }), res);
    expect(res.statusCode).toBe(200);
    expect((res.jsonBody as { success: boolean }).success).toBe(true);
  });

  it('returns 500 without leaking internals when the store fails', async () => {
    mockedRecord.mockRejectedValue(new Error('connect ECONNREFUSED password=hunter2'));
    const res = createRes();
    await handler(createReq({ docs: [...ALL_DOCS], locale: 'en' }), res);
    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(res.jsonBody)).not.toContain('hunter2');
  });
});
