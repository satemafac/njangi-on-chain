/**
 * Regression tests for the circle-admin authorization middleware
 * (gtm-readiness review, June 2026): the placeholder that accepted any
 * non-empty token is gone. The caller must hold a server-side zkLogin
 * session (HttpOnly `session-id` cookie) whose address equals the circle's
 * on-chain admin, and the wrapped handler must never run otherwise.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import {
  verifyCircleAdminRequest,
  withCircleAdminAuth,
  type AuthenticatedRequest,
} from '@/middleware/admin-auth.middleware';
import { getZkLoginSessionStore } from '@/lib/zklogin-session-registry';
import type { ZkLoginSessionRecord } from '@/lib/zklogin-session-registry';

const ADMIN_ADDRESS = '0x' + 'a1'.repeat(32);
const OTHER_ADDRESS = '0x' + 'b2'.repeat(32);
const CIRCLE_ID = '0x' + 'c3'.repeat(32);
const SESSION_ID = 'test-session-id';

function buildSessionRecord(userAddr: string): ZkLoginSessionRecord {
  return {
    provider: 'Google',
    maxEpoch: 100,
    randomness: 'rand',
    ephemeralPrivateKey: 'ephemeral-key',
    account: {
      provider: 'Google',
      userAddr,
      zkProofs: {
        proofPoints: { a: ['1'], b: [['2']], c: ['3'] },
        issBase64Details: { value: 'iss', indexMod4: 0 },
        headerBase64: 'header',
      },
      ephemeralPrivateKey: 'ephemeral-key',
      userSalt: '42',
      sub: 'sub',
      aud: 'aud',
      maxEpoch: 100,
    },
  };
}

function createReq(overrides: Partial<NextApiRequest> = {}): NextApiRequest {
  return {
    method: 'POST',
    url: '/api/whatsapp/admin-link-circle',
    headers: {},
    socket: {},
    cookies: {},
    query: {},
    body: { circleId: CIRCLE_ID, network: 'testnet' },
    ...overrides,
  } as unknown as NextApiRequest;
}

interface MockRes {
  statusCode: number;
  jsonBody: unknown;
}

function createMockRes(): NextApiResponse & MockRes {
  const res = {
    statusCode: 0,
    jsonBody: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.jsonBody = body;
      return this;
    },
    setHeader() {
      return this;
    },
  };
  return res as unknown as NextApiResponse & MockRes;
}

describe('verifyCircleAdminRequest', () => {
  const fetchAdminAddress = jest.fn();
  const deps = { fetchAdminAddress: fetchAdminAddress as never };

  beforeEach(() => {
    getZkLoginSessionStore().clear();
    fetchAdminAddress.mockReset();
    fetchAdminAddress.mockResolvedValue(ADMIN_ADDRESS);
  });

  it('rejects with 401 when there is no session cookie', async () => {
    const result = await verifyCircleAdminRequest(createReq(), {}, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
    expect(fetchAdminAddress).not.toHaveBeenCalled();
  });

  it('rejects with 401 when the session id maps to no server session', async () => {
    const result = await verifyCircleAdminRequest(
      createReq({ cookies: { 'session-id': 'unknown-session' } }),
      {},
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it('rejects with 401 when the session has no completed account/proofs', async () => {
    const record = buildSessionRecord(ADMIN_ADDRESS);
    delete record.account;
    getZkLoginSessionStore().set(SESSION_ID, record);

    const result = await verifyCircleAdminRequest(
      createReq({ cookies: { 'session-id': SESSION_ID } }),
      {},
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it('rejects with 403 when the session address is not the on-chain admin', async () => {
    getZkLoginSessionStore().set(SESSION_ID, buildSessionRecord(OTHER_ADDRESS));

    const result = await verifyCircleAdminRequest(
      createReq({ cookies: { 'session-id': SESSION_ID } }),
      {},
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
  });

  it('rejects with 403 when the claimed adminAddress differs from the session', async () => {
    getZkLoginSessionStore().set(SESSION_ID, buildSessionRecord(ADMIN_ADDRESS));

    const result = await verifyCircleAdminRequest(
      createReq({
        cookies: { 'session-id': SESSION_ID },
        body: { circleId: CIRCLE_ID, adminAddress: OTHER_ADDRESS },
      }),
      {},
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
  });

  it('rejects with 401 when the body account does not match the session', async () => {
    getZkLoginSessionStore().set(SESSION_ID, buildSessionRecord(ADMIN_ADDRESS));

    const result = await verifyCircleAdminRequest(
      createReq({
        cookies: { 'session-id': SESSION_ID },
        body: { circleId: CIRCLE_ID, account: { userAddr: OTHER_ADDRESS } },
      }),
      {},
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it('fails closed with 500 when the on-chain lookup throws', async () => {
    getZkLoginSessionStore().set(SESSION_ID, buildSessionRecord(ADMIN_ADDRESS));
    fetchAdminAddress.mockRejectedValue(new Error('rpc down'));

    const result = await verifyCircleAdminRequest(
      createReq({ cookies: { 'session-id': SESSION_ID } }),
      {},
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(500);
  });

  it('rejects with 404 when the circle has no admin on chain', async () => {
    getZkLoginSessionStore().set(SESSION_ID, buildSessionRecord(ADMIN_ADDRESS));
    fetchAdminAddress.mockResolvedValue(null);

    const result = await verifyCircleAdminRequest(
      createReq({ cookies: { 'session-id': SESSION_ID } }),
      {},
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(404);
  });

  it('accepts when the session address equals the on-chain admin', async () => {
    getZkLoginSessionStore().set(SESSION_ID, buildSessionRecord(ADMIN_ADDRESS));

    const result = await verifyCircleAdminRequest(
      createReq({ cookies: { 'session-id': SESSION_ID } }),
      {},
      deps,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.admin.suiAddress).toBe(ADMIN_ADDRESS);
      expect(result.admin.circleId).toBe(CIRCLE_ID);
      expect(result.admin.network).toBe('testnet');
    }
    expect(fetchAdminAddress).toHaveBeenCalledWith(CIRCLE_ID, 'testnet');
  });

  // Query and body are independent in a pages API request: an attacker who
  // admins circle A must not be able to authorize via ?circleId=A while the
  // body (the operation target) names circle B. Divergence → reject.
  it('rejects with 400 when query.circleId and body.circleId diverge', async () => {
    const OTHER_CIRCLE = '0x' + 'd4'.repeat(32);
    getZkLoginSessionStore().set(SESSION_ID, buildSessionRecord(ADMIN_ADDRESS));

    const result = await verifyCircleAdminRequest(
      createReq({
        cookies: { 'session-id': SESSION_ID },
        query: { circleId: OTHER_CIRCLE },
        body: { circleId: CIRCLE_ID, network: 'testnet' },
      }),
      {},
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(400);
    expect(fetchAdminAddress).not.toHaveBeenCalled();
  });

  it('rejects with 400 when query.network and body.network diverge', async () => {
    getZkLoginSessionStore().set(SESSION_ID, buildSessionRecord(ADMIN_ADDRESS));

    const result = await verifyCircleAdminRequest(
      createReq({
        cookies: { 'session-id': SESSION_ID },
        query: { network: 'mainnet' },
        body: { circleId: CIRCLE_ID, network: 'testnet' },
      }),
      {},
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(400);
    expect(fetchAdminAddress).not.toHaveBeenCalled();
  });

  it('authorizes against the body circleId when query and body agree', async () => {
    getZkLoginSessionStore().set(SESSION_ID, buildSessionRecord(ADMIN_ADDRESS));

    const result = await verifyCircleAdminRequest(
      createReq({
        cookies: { 'session-id': SESSION_ID },
        query: { circleId: CIRCLE_ID, network: 'testnet' },
        body: { circleId: CIRCLE_ID, network: 'testnet' },
      }),
      {},
      deps,
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.admin.circleId).toBe(CIRCLE_ID);
    expect(fetchAdminAddress).toHaveBeenCalledWith(CIRCLE_ID, 'testnet');
  });
});

describe('withCircleAdminAuth', () => {
  const fetchAdminAddress = jest.fn();
  const deps = { fetchAdminAddress: fetchAdminAddress as never };

  beforeEach(() => {
    getZkLoginSessionStore().clear();
    fetchAdminAddress.mockReset();
    fetchAdminAddress.mockResolvedValue(ADMIN_ADDRESS);
  });

  it('never invokes the handler (no side effects) for unauthenticated callers', async () => {
    const handler = jest.fn();
    const res = createMockRes();

    await withCircleAdminAuth(handler, {}, deps)(createReq() as AuthenticatedRequest, res);

    expect(handler).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.jsonBody).toMatchObject({ success: false, requiresReauth: true });
  });

  it('never invokes the handler for a non-admin session', async () => {
    getZkLoginSessionStore().set(SESSION_ID, buildSessionRecord(OTHER_ADDRESS));
    const handler = jest.fn();
    const res = createMockRes();

    await withCircleAdminAuth(handler, {}, deps)(
      createReq({ cookies: { 'session-id': SESSION_ID } }) as AuthenticatedRequest,
      res,
    );

    expect(handler).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it('attaches the verified admin and invokes the handler for the circle admin', async () => {
    getZkLoginSessionStore().set(SESSION_ID, buildSessionRecord(ADMIN_ADDRESS));
    const handler = jest.fn(async (req: AuthenticatedRequest, res: NextApiResponse) => {
      res.status(200).json({ success: true, admin: req.admin?.suiAddress });
    });
    const res = createMockRes();

    await withCircleAdminAuth(handler, {}, deps)(
      createReq({ cookies: { 'session-id': SESSION_ID } }) as AuthenticatedRequest,
      res,
    );

    expect(handler).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody).toMatchObject({ success: true, admin: ADMIN_ADDRESS });
  });
});
