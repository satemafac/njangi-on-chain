/**
 * Session gates on /api/join-requests/* (src/lib/join-request-auth.ts).
 *
 * src/middleware.ts skips /api, and these routes used to trust the address
 * in the query or body. Now the caller is whoever the `session-id` cookie
 * resolves to:
 * - [circleId]/update and pending/[circleId]: the circle's on-chain admin;
 * - check and create: the signed-in account must be `userAddress`;
 * - lookup-user: the circle's admin or one of its members.
 * A failed chain read is an error response, never an empty answer, and so is
 * a failed read of the join-request store itself (503).
 */

import type { NextApiRequest, NextApiResponse } from 'next';

jest.mock('@/services/network-config', () => ({
  getCurrentNetwork: jest.fn(() => 'testnet'),
  getNetworkConfig: jest.fn(() => ({ rpcUrl: 'http://localhost:9000' })),
  getCurrentRpcUrl: jest.fn(() => 'http://localhost:9000'),
}));
jest.mock('@/services/sui-rpc-failover', () => ({
  getPooledSuiClient: jest.fn(),
}));
jest.mock('@/services/join-request-database', () => ({
  __esModule: true,
  default: {
    getPendingRequestsByCircleId: jest.fn(),
    checkPendingRequest: jest.fn(),
    updateJoinRequestStatus: jest.fn(),
    getUserByAddress: jest.fn(),
    createJoinRequest: jest.fn(),
  },
}));
jest.mock('@/services/database-service', () => ({
  __esModule: true,
  default: {
    getPendingRequestsByCircleId: jest.fn(),
    userHasPendingRequest: jest.fn(),
    updateJoinRequestStatus: jest.fn(),
    createJoinRequest: jest.fn(),
  },
}));
jest.mock('@/lib/circle-admin-verification', () => {
  const actual = jest.requireActual('@/lib/circle-admin-verification');
  return {
    ...actual,
    fetchCircleAdminAddress: jest.fn(),
    fetchCircleAuthority: jest.fn(),
  };
});
jest.mock('@/lib/milestone-discovery', () => ({
  isCircleMember: jest.fn(),
}));
jest.mock('@/lib/circle-chain', () => ({
  resolveCircleLifecycleState: jest.fn(() => ({ isActive: false, isPausedAfterCycle: false })),
}));
jest.mock('@/lib/rate-limit', () => ({
  consumeRateLimit: jest.fn(async () => ({ allowed: true, resetMs: 0 })),
}));
jest.mock('@/lib/embargo', () => ({
  isEmbargoedHeaders: jest.fn(() => false),
  embargoErrorBody: jest.fn(),
}));
jest.mock('@/lib/sanctions', () => ({
  screenAddress: jest.fn(),
  sanctionsErrorBody: jest.fn(() => ({
    success: false,
    error: 'SANCTIONS_BLOCKED',
    code: 'SANCTIONS_BLOCKED',
    message: 'blocked',
  })),
}));
jest.mock('@/lib/legal-acceptance-server', () => ({
  hasAcceptedAllLegalDocs: jest.fn(),
}));
jest.mock('@/lib/zklogin-address-bindings', () => ({
  getDriftStatusForIdentity: jest.fn(),
  addressDriftErrorBody: jest.fn(),
}));

import updateHandler from '@/pages/api/join-requests/[circleId]/update';
import pendingHandler from '@/pages/api/join-requests/pending/[circleId]';
import checkHandler from '@/pages/api/join-requests/check';
import lookupUserHandler from '@/pages/api/join-requests/lookup-user';
import createHandler from '@/pages/api/join-requests/create';
import * as sessionRegistry from '@/lib/zklogin-session-registry';
import { getZkLoginSessionStore } from '@/lib/zklogin-session-registry';
import type { ZkLoginSessionRecord } from '@/lib/zklogin-session-registry';
import {
  fetchCircleAdminAddress,
  fetchCircleAuthority,
} from '@/lib/circle-admin-verification';
import { isCircleMember } from '@/lib/milestone-discovery';
import { getPooledSuiClient } from '@/services/sui-rpc-failover';
import joinRequestDatabase from '@/services/join-request-database';
import databaseService from '@/services/database-service';
import { screenAddress } from '@/lib/sanctions';
import { hasAcceptedAllLegalDocs } from '@/lib/legal-acceptance-server';
import { getDriftStatusForIdentity } from '@/lib/zklogin-address-bindings';
import { JOIN_REQUESTS_UNREADABLE } from '@/lib/join-request-read-failure';
import { consumeRateLimit } from '@/lib/rate-limit';

const ADMIN = '0x' + 'a1'.repeat(32);
const MEMBER = '0x' + 'b2'.repeat(32);
const STRANGER = '0x' + 'd4'.repeat(32);
const CIRCLE_ID = '0x' + 'c3'.repeat(32);
const SESSION_ID = 'join-requests-session';

const sqlite = databaseService as unknown as Record<string, jest.Mock>;
const postgres = joinRequestDatabase as unknown as Record<string, jest.Mock>;

function signInAs(userAddr: string): Record<string, string> {
  const record: ZkLoginSessionRecord = {
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
      sub: 'sub-' + userAddr.slice(2, 6),
      aud: 'aud',
      maxEpoch: 100,
    },
  };
  getZkLoginSessionStore().set(SESSION_ID, record);
  return { 'session-id': SESSION_ID };
}

interface MockRes {
  statusCode: number;
  jsonBody: Record<string, unknown>;
}

function createRes(): NextApiResponse & MockRes {
  const res = {
    statusCode: 0,
    jsonBody: {} as Record<string, unknown>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: Record<string, unknown>) {
      this.jsonBody = body;
      return this;
    },
    setHeader() {
      return this;
    },
  };
  return res as unknown as NextApiResponse & MockRes;
}

function createReq(opts: {
  method: string;
  query?: Record<string, string>;
  body?: Record<string, unknown>;
  cookies?: Record<string, string>;
}): NextApiRequest {
  return {
    method: opts.method,
    url: '/api/join-requests',
    headers: {},
    socket: {},
    query: opts.query ?? {},
    body: opts.body,
    cookies: opts.cookies ?? {},
  } as unknown as NextApiRequest;
}

beforeEach(() => {
  getZkLoginSessionStore().clear();
  (fetchCircleAdminAddress as jest.Mock).mockResolvedValue(ADMIN);
  (fetchCircleAuthority as jest.Mock).mockResolvedValue({
    admin: ADMIN,
    membersTableId: '0xmembers',
  });
  (isCircleMember as jest.Mock).mockResolvedValue(false);
});

describe('POST /api/join-requests/[circleId]/update', () => {
  const body = { userAddress: MEMBER, status: 'approved' };

  it('refuses a caller with no session and writes nothing', async () => {
    const res = createRes();
    await updateHandler(createReq({ method: 'POST', query: { circleId: CIRCLE_ID }, body }), res);

    expect(res.statusCode).toBe(401);
    expect(res.jsonBody).toMatchObject({ success: false, requiresReauth: true });
    expect(sqlite.updateJoinRequestStatus).not.toHaveBeenCalled();
    expect(postgres.updateJoinRequestStatus).not.toHaveBeenCalled();
  });

  it('refuses a signed-in caller who is not the circle admin', async () => {
    const res = createRes();
    await updateHandler(
      createReq({ method: 'POST', query: { circleId: CIRCLE_ID }, body, cookies: signInAs(STRANGER) }),
      res,
    );

    expect(res.statusCode).toBe(403);
    expect(sqlite.updateJoinRequestStatus).not.toHaveBeenCalled();
  });

  it('fails closed when the on-chain admin cannot be read', async () => {
    (fetchCircleAdminAddress as jest.Mock).mockRejectedValue(new Error('rpc down'));
    const res = createRes();
    await updateHandler(
      createReq({ method: 'POST', query: { circleId: CIRCLE_ID }, body, cookies: signInAs(ADMIN) }),
      res,
    );

    expect(res.statusCode).toBe(500);
    expect(sqlite.updateJoinRequestStatus).not.toHaveBeenCalled();
  });

  it("updates the request for the circle's admin", async () => {
    sqlite.updateJoinRequestStatus.mockReturnValue(true);
    const res = createRes();
    await updateHandler(
      createReq({ method: 'POST', query: { circleId: CIRCLE_ID }, body, cookies: signInAs(ADMIN) }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(sqlite.updateJoinRequestStatus).toHaveBeenCalledWith(CIRCLE_ID, MEMBER, 'approved');
  });

  it("checks the admin on the deployment's network, not one the caller names", async () => {
    sqlite.updateJoinRequestStatus.mockReturnValue(true);
    const res = createRes();
    await updateHandler(
      createReq({
        method: 'POST',
        query: { circleId: CIRCLE_ID, network: 'mainnet' },
        body,
        cookies: signInAs(ADMIN),
      }),
      res,
    );

    expect(fetchCircleAdminAddress).toHaveBeenCalledWith(CIRCLE_ID, 'testnet');
  });
});

describe('GET /api/join-requests/pending/[circleId]', () => {
  const rows = [{ circle_id: CIRCLE_ID, user_address: MEMBER, user_name: 'Aminata' }];

  it('returns no rows to a caller with no session', async () => {
    const res = createRes();
    await pendingHandler(createReq({ method: 'GET', query: { circleId: CIRCLE_ID } }), res);

    expect(res.statusCode).toBe(401);
    expect(res.jsonBody.data).toBeUndefined();
    expect(sqlite.getPendingRequestsByCircleId).not.toHaveBeenCalled();
  });

  it('returns no rows to a signed-in caller who is not the circle admin', async () => {
    const res = createRes();
    await pendingHandler(
      createReq({ method: 'GET', query: { circleId: CIRCLE_ID }, cookies: signInAs(MEMBER) }),
      res,
    );

    expect(res.statusCode).toBe(403);
    expect(res.jsonBody.data).toBeUndefined();
    expect(sqlite.getPendingRequestsByCircleId).not.toHaveBeenCalled();
  });

  it('answers an unreadable admin check with an error, not an empty list', async () => {
    (fetchCircleAdminAddress as jest.Mock).mockRejectedValue(new Error('rpc down'));
    const res = createRes();
    await pendingHandler(
      createReq({ method: 'GET', query: { circleId: CIRCLE_ID }, cookies: signInAs(ADMIN) }),
      res,
    );

    expect(res.statusCode).toBe(500);
    expect(res.jsonBody.success).toBe(false);
    expect(res.jsonBody.data).toBeUndefined();
  });

  it("lists the queue for the circle's admin", async () => {
    sqlite.getPendingRequestsByCircleId.mockReturnValue(rows);
    const res = createRes();
    await pendingHandler(
      createReq({ method: 'GET', query: { circleId: CIRCLE_ID }, cookies: signInAs(ADMIN) }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.data).toEqual(rows);
  });

  it('gives ?clear=all no path of its own: without a session it is refused like any read', async () => {
    const res = createRes();
    await pendingHandler(
      createReq({ method: 'GET', query: { circleId: CIRCLE_ID, clear: 'all' } }),
      res,
    );

    expect(res.statusCode).toBe(401);
    expect(res.jsonBody.data).toBeUndefined();
    expect(sqlite.getPendingRequestsByCircleId).not.toHaveBeenCalled();
  });

  it('answers DELETE with 405 and touches no rows', async () => {
    const res = createRes();
    await pendingHandler(
      createReq({ method: 'DELETE', query: { circleId: CIRCLE_ID }, cookies: signInAs(ADMIN) }),
      res,
    );

    expect(res.statusCode).toBe(405);
    expect(sqlite.getPendingRequestsByCircleId).not.toHaveBeenCalled();
    expect(postgres.getPendingRequestsByCircleId).not.toHaveBeenCalled();
  });
});

describe('GET /api/join-requests/check', () => {
  it('refuses a caller with no session', async () => {
    const res = createRes();
    await checkHandler(
      createReq({ method: 'GET', query: { circleId: CIRCLE_ID, userAddress: MEMBER } }),
      res,
    );

    expect(res.statusCode).toBe(401);
    expect(sqlite.userHasPendingRequest).not.toHaveBeenCalled();
  });

  it('refuses a question about another account', async () => {
    const res = createRes();
    await checkHandler(
      createReq({
        method: 'GET',
        query: { circleId: CIRCLE_ID, userAddress: MEMBER },
        cookies: signInAs(STRANGER),
      }),
      res,
    );

    expect(res.statusCode).toBe(403);
    expect(sqlite.userHasPendingRequest).not.toHaveBeenCalled();
  });

  it("answers for the caller's own account, whatever the address casing", async () => {
    sqlite.userHasPendingRequest.mockReturnValue(true);
    const res = createRes();
    await checkHandler(
      createReq({
        method: 'GET',
        query: { circleId: CIRCLE_ID, userAddress: MEMBER.toUpperCase().replace('0X', '0x') },
        cookies: signInAs(MEMBER),
      }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.data).toEqual({ hasPendingRequest: true });
  });
});

describe('GET /api/join-requests/lookup-user', () => {
  const query = { circleId: CIRCLE_ID, userAddress: MEMBER };

  beforeEach(() => {
    postgres.getUserByAddress.mockResolvedValue({ user_name: 'Aminata', circle_name: 'Susu' });
  });

  it('refuses a caller with no session', async () => {
    const res = createRes();
    await lookupUserHandler(createReq({ method: 'GET', query }), res);

    expect(res.statusCode).toBe(401);
    expect(postgres.getUserByAddress).not.toHaveBeenCalled();
  });

  it('refuses a signed-in caller who is not in the circle', async () => {
    const res = createRes();
    await lookupUserHandler(createReq({ method: 'GET', query, cookies: signInAs(STRANGER) }), res);

    expect(res.statusCode).toBe(403);
    expect(isCircleMember).toHaveBeenCalledWith('0xmembers', STRANGER, 'testnet');
    expect(postgres.getUserByAddress).not.toHaveBeenCalled();
  });

  it('answers a member of the circle', async () => {
    (isCircleMember as jest.Mock).mockResolvedValue(true);
    const res = createRes();
    await lookupUserHandler(createReq({ method: 'GET', query, cookies: signInAs(MEMBER) }), res);

    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.data).toEqual({ userName: 'Aminata', circleName: 'Susu' });
  });

  it("answers the circle's admin without a membership read", async () => {
    const res = createRes();
    await lookupUserHandler(createReq({ method: 'GET', query, cookies: signInAs(ADMIN) }), res);

    expect(res.statusCode).toBe(200);
    expect(isCircleMember).not.toHaveBeenCalled();
  });

  it('answers 503, not "not a member", when the circle cannot be read', async () => {
    (fetchCircleAuthority as jest.Mock).mockRejectedValue(new Error('rpc down'));
    const res = createRes();
    await lookupUserHandler(createReq({ method: 'GET', query, cookies: signInAs(MEMBER) }), res);

    expect(res.statusCode).toBe(503);
    expect(postgres.getUserByAddress).not.toHaveBeenCalled();
  });

  it('answers 503 when membership cannot be read', async () => {
    (isCircleMember as jest.Mock).mockResolvedValue(null);
    const res = createRes();
    await lookupUserHandler(createReq({ method: 'GET', query, cookies: signInAs(MEMBER) }), res);

    expect(res.statusCode).toBe(503);
    expect(postgres.getUserByAddress).not.toHaveBeenCalled();
  });

  it('answers 404 for a circle that does not exist', async () => {
    (fetchCircleAuthority as jest.Mock).mockResolvedValue(null);
    const res = createRes();
    await lookupUserHandler(createReq({ method: 'GET', query, cookies: signInAs(MEMBER) }), res);

    expect(res.statusCode).toBe(404);
  });

  it('answers 404 for an object that is not a circle', async () => {
    (fetchCircleAuthority as jest.Mock).mockResolvedValue({ admin: null, membersTableId: null });
    const res = createRes();
    await lookupUserHandler(createReq({ method: 'GET', query, cookies: signInAs(MEMBER) }), res);

    expect(res.statusCode).toBe(404);
    expect(isCircleMember).not.toHaveBeenCalled();
  });
});

describe('when the session store cannot be read', () => {
  beforeEach(() => {
    jest
      .spyOn(sessionRegistry, 'getZkLoginSessionAccount')
      .mockRejectedValue(new Error('DATABASE_URL is required in production'));
  });

  it('answers the admin queue with 503 JSON, not a crash or an empty list', async () => {
    const res = createRes();
    await pendingHandler(
      createReq({ method: 'GET', query: { circleId: CIRCLE_ID }, cookies: { 'session-id': 'any' } }),
      res,
    );

    expect(res.statusCode).toBe(503);
    expect(res.jsonBody).toEqual({ success: false, message: expect.stringMatching(/sign-in/) });
    expect(sqlite.getPendingRequestsByCircleId).not.toHaveBeenCalled();
  });

  it("answers a member's own check with 503", async () => {
    const res = createRes();
    await checkHandler(
      createReq({
        method: 'GET',
        query: { circleId: CIRCLE_ID, userAddress: MEMBER },
        cookies: { 'session-id': 'any' },
      }),
      res,
    );

    expect(res.statusCode).toBe(503);
    expect(sqlite.userHasPendingRequest).not.toHaveBeenCalled();
  });

  it('answers a name lookup with 503', async () => {
    const res = createRes();
    await lookupUserHandler(
      createReq({
        method: 'GET',
        query: { circleId: CIRCLE_ID, userAddress: MEMBER },
        cookies: { 'session-id': 'any' },
      }),
      res,
    );

    expect(res.statusCode).toBe(503);
    expect(postgres.getUserByAddress).not.toHaveBeenCalled();
  });
});

describe('POST /api/join-requests/create', () => {
  const body = { circleId: CIRCLE_ID, circleName: 'Susu', userAddress: MEMBER, userName: 'Aminata' };

  beforeEach(() => {
    (screenAddress as jest.Mock).mockResolvedValue({ blocked: false });
    (hasAcceptedAllLegalDocs as jest.Mock).mockResolvedValue({ accepted: true, missing: [] });
    (getDriftStatusForIdentity as jest.Mock).mockResolvedValue({ drifted: false, previousAddresses: [] });
    (getPooledSuiClient as jest.Mock).mockReturnValue({
      getObject: jest.fn().mockResolvedValue({
        data: { content: { dataType: 'moveObject', fields: {} } },
      }),
    });
    sqlite.createJoinRequest.mockReturnValue({ id: 7 });
  });

  it('refuses a caller with no session and files nothing', async () => {
    const res = createRes();
    await createHandler(createReq({ method: 'POST', body }), res);

    expect(res.statusCode).toBe(401);
    expect(res.jsonBody).toMatchObject({ success: false, requiresReauth: true });
    expect(sqlite.createJoinRequest).not.toHaveBeenCalled();
    expect(hasAcceptedAllLegalDocs).not.toHaveBeenCalled();
  });

  it('refuses a request filed for another account', async () => {
    const res = createRes();
    await createHandler(createReq({ method: 'POST', body, cookies: signInAs(STRANGER) }), res);

    expect(res.statusCode).toBe(403);
    expect(sqlite.createJoinRequest).not.toHaveBeenCalled();
  });

  it('still refuses a listed address as listed, before the session check', async () => {
    (screenAddress as jest.Mock).mockResolvedValue({ blocked: true, reason: 'listed' });
    const res = createRes();
    await createHandler(createReq({ method: 'POST', body }), res);

    expect(res.statusCode).toBe(403);
    expect(res.jsonBody.code).toBe('SANCTIONS_BLOCKED');
    expect(sqlite.createJoinRequest).not.toHaveBeenCalled();
  });

  it("files the signed-in member's own request after the legal gate", async () => {
    const res = createRes();
    await createHandler(createReq({ method: 'POST', body, cookies: signInAs(MEMBER) }), res);

    expect(res.statusCode).toBe(200);
    expect(hasAcceptedAllLegalDocs).toHaveBeenCalledWith('sub-' + MEMBER.slice(2, 6), 'aud');
    expect(sqlite.createJoinRequest).toHaveBeenCalledWith(
      expect.objectContaining({ circleId: CIRCLE_ID, userAddress: MEMBER }),
    );
  });

  it('throttles on a hashed IP + address key, never the raw values', async () => {
    await createHandler(createReq({ method: 'POST', body, cookies: signInAs(MEMBER) }), createRes());

    const limiter = consumeRateLimit as jest.Mock;
    expect(limiter).toHaveBeenCalledTimes(1);
    const { key } = limiter.mock.calls[0][0] as { key: string };
    expect(key).toMatch(/^join-request:[0-9a-f]{64}$/);
    expect(key).not.toContain(MEMBER.toLowerCase());
    // No forwarded header in this harness: the IP resolves to "unknown",
    // and even that placeholder is hashed, not stored.
    expect(key).not.toContain('unknown');
  });
});

describe('when the join-request store cannot be read', () => {
  const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
  const outage = () => new Error('Connection terminated unexpectedly');
  const unreadable = { success: false, message: JOIN_REQUESTS_UNREADABLE };

  afterEach(() => {
    if (ORIGINAL_DATABASE_URL === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
    }
  });

  describe('locally (SQLite)', () => {
    beforeEach(() => {
      delete process.env.DATABASE_URL;
    });

    it("answers the admin's queue with 503, not an empty list", async () => {
      sqlite.getPendingRequestsByCircleId.mockImplementation(() => {
        throw outage();
      });
      const res = createRes();
      await pendingHandler(
        createReq({ method: 'GET', query: { circleId: CIRCLE_ID }, cookies: signInAs(ADMIN) }),
        res,
      );

      expect(sqlite.getPendingRequestsByCircleId).toHaveBeenCalledWith(CIRCLE_ID);
      expect(res.statusCode).toBe(503);
      expect(res.jsonBody).toEqual(unreadable);
    });

    it("answers a member's own check with 503, not hasPendingRequest: false", async () => {
      sqlite.userHasPendingRequest.mockImplementation(() => {
        throw outage();
      });
      const res = createRes();
      await checkHandler(
        createReq({
          method: 'GET',
          query: { circleId: CIRCLE_ID, userAddress: MEMBER },
          cookies: signInAs(MEMBER),
        }),
        res,
      );

      expect(sqlite.userHasPendingRequest).toHaveBeenCalledWith(CIRCLE_ID, MEMBER);
      expect(res.statusCode).toBe(503);
      expect(res.jsonBody).toEqual(unreadable);
    });
  });

  describe('in production (Postgres)', () => {
    beforeEach(() => {
      process.env.DATABASE_URL = 'postgres://join-requests.test/njangi';
      // With DATABASE_URL set the session registry would read Postgres too.
      // Serve the sessions signInAs() writes, so the join-request read is the
      // one that fails.
      jest
        .spyOn(sessionRegistry, 'getZkLoginSessionAccount')
        .mockImplementation(
          async (sessionId) => (sessionId ? getZkLoginSessionStore().get(sessionId)?.account : null) ?? null,
        );
    });

    it("answers the admin's queue with 503, not an empty list", async () => {
      postgres.getPendingRequestsByCircleId.mockRejectedValue(outage());
      const res = createRes();
      await pendingHandler(
        createReq({ method: 'GET', query: { circleId: CIRCLE_ID }, cookies: signInAs(ADMIN) }),
        res,
      );

      expect(postgres.getPendingRequestsByCircleId).toHaveBeenCalledWith(CIRCLE_ID);
      expect(sqlite.getPendingRequestsByCircleId).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(503);
      expect(res.jsonBody).toEqual(unreadable);
    });

    it("answers a member's own check with 503, not hasPendingRequest: false", async () => {
      postgres.checkPendingRequest.mockRejectedValue(outage());
      const res = createRes();
      await checkHandler(
        createReq({
          method: 'GET',
          query: { circleId: CIRCLE_ID, userAddress: MEMBER },
          cookies: signInAs(MEMBER),
        }),
        res,
      );

      expect(postgres.checkPendingRequest).toHaveBeenCalledWith(CIRCLE_ID, MEMBER);
      expect(res.statusCode).toBe(503);
      expect(res.jsonBody).toEqual(unreadable);
    });

    it('still answers hasPendingRequest: false when there really is no request', async () => {
      postgres.checkPendingRequest.mockResolvedValue(false);
      const res = createRes();
      await checkHandler(
        createReq({
          method: 'GET',
          query: { circleId: CIRCLE_ID, userAddress: MEMBER },
          cookies: signInAs(MEMBER),
        }),
        res,
      );

      expect(res.statusCode).toBe(200);
      expect(res.jsonBody.data).toEqual({ hasPendingRequest: false });
    });

    it('answers a name lookup with 503, not userName: null', async () => {
      (isCircleMember as jest.Mock).mockResolvedValue(true);
      postgres.getUserByAddress.mockRejectedValue(outage());
      const res = createRes();
      await lookupUserHandler(
        createReq({
          method: 'GET',
          query: { circleId: CIRCLE_ID, userAddress: ADMIN },
          cookies: signInAs(MEMBER),
        }),
        res,
      );

      expect(postgres.getUserByAddress).toHaveBeenCalledWith(CIRCLE_ID, ADMIN);
      expect(res.statusCode).toBe(503);
      expect(res.jsonBody).toEqual(unreadable);
    });

    it('still answers userName: null for an address that never applied', async () => {
      (isCircleMember as jest.Mock).mockResolvedValue(true);
      postgres.getUserByAddress.mockResolvedValue(null);
      const res = createRes();
      await lookupUserHandler(
        createReq({
          method: 'GET',
          query: { circleId: CIRCLE_ID, userAddress: ADMIN },
          cookies: signInAs(MEMBER),
        }),
        res,
      );

      expect(res.statusCode).toBe(200);
      expect(res.jsonBody.data).toEqual({ userName: null, circleName: null });
    });

    it('answers a failed save with an error, never success with { id: 0 }', async () => {
      (screenAddress as jest.Mock).mockResolvedValue({ blocked: false });
      (hasAcceptedAllLegalDocs as jest.Mock).mockResolvedValue({ accepted: true, missing: [] });
      (getDriftStatusForIdentity as jest.Mock).mockResolvedValue({ drifted: false, previousAddresses: [] });
      (getPooledSuiClient as jest.Mock).mockReturnValue({
        getObject: jest.fn().mockResolvedValue({
          data: { content: { dataType: 'moveObject', fields: {} } },
        }),
      });
      postgres.createJoinRequest.mockRejectedValue(outage());
      const res = createRes();
      await createHandler(
        createReq({
          method: 'POST',
          body: { circleId: CIRCLE_ID, circleName: 'Susu', userAddress: MEMBER, userName: 'Aminata' },
          cookies: signInAs(MEMBER),
        }),
        res,
      );

      expect(postgres.createJoinRequest).toHaveBeenCalled();
      expect(res.statusCode).toBe(500);
      expect(res.jsonBody.success).toBe(false);
      expect(res.jsonBody.data).toBeUndefined();
    });
  });
});
