/**
 * Regression tests for the WhatsApp admin-link-circle endpoint
 * (gtm-readiness review, June 2026):
 *
 * - GET ?includeRecipient=true used to decrypt and return the linked
 *   WhatsApp phone number with NO auth. It now requires the caller's
 *   zkLogin session to resolve to the on-chain circle admin; without that
 *   the response carries zero PII.
 * - The plain GET link-existence probe (used by WhatsAppCircleIntegration
 *   and CycleEscrowPanel) stays public and never decrypts.
 * - POST runs authorization BEFORE any side effect (Walrus upload,
 *   Postgres index write).
 * - POST operates on the circle/network the middleware verified: a query
 *   string diverging from the body (cross-circle WhatsApp link hijack —
 *   authorize as admin of circle A via ?circleId=A, operate on circle B
 *   from the body) is rejected before any side effect, and the on-chain
 *   anchor / Postgres index always target the verified circle. Same for
 *   admin-unlink-circle.
 */

import type { NextApiRequest, NextApiResponse } from 'next';

jest.mock('@/services/whatsapp-registry-service', () => ({
  getActiveWhatsAppRegistries: jest.fn(),
}));
jest.mock('@/services/network-config', () => ({
  getNetworkConfig: jest.fn(() => ({ rpcUrl: 'http://localhost:9000' })),
}));
jest.mock('@/services/sui-rpc-failover', () => ({
  getPooledSuiClient: jest.fn(),
}));
jest.mock('@/services/enokiZkLoginService', () => ({
  enokiZkLoginService: { sendTransaction: jest.fn() },
}));
jest.mock('@/lib/walrus-pii', () => ({
  encryptAndStorePII: jest.fn(),
  fetchAndDecryptPII: jest.fn(),
  nonceToHex: jest.fn(() => 'deadbeef'),
}));
jest.mock('@/lib/whatsapp-link-index', () => ({
  indexWhatsAppLink: jest.fn(),
  deindexWhatsAppLinksForCircle: jest.fn(),
}));
jest.mock('@/lib/circle-admin-verification', () => {
  const actual = jest.requireActual('@/lib/circle-admin-verification');
  return {
    ...actual,
    fetchCircleAdminAddress: jest.fn(),
  };
});

import handler from '@/pages/api/whatsapp/admin-link-circle';
import unlinkHandler from '@/pages/api/whatsapp/admin-unlink-circle';
import { getZkLoginSessionStore } from '@/lib/zklogin-session-registry';
import type { ZkLoginSessionRecord } from '@/lib/zklogin-session-registry';
import { fetchCircleAdminAddress } from '@/lib/circle-admin-verification';
import { getActiveWhatsAppRegistries } from '@/services/whatsapp-registry-service';
import { getPooledSuiClient } from '@/services/sui-rpc-failover';
import { enokiZkLoginService } from '@/services/enokiZkLoginService';
import { encryptAndStorePII, fetchAndDecryptPII } from '@/lib/walrus-pii';
import {
  indexWhatsAppLink,
  deindexWhatsAppLinksForCircle,
} from '@/lib/whatsapp-link-index';

const ADMIN_ADDRESS = '0x' + 'a1'.repeat(32);
const OTHER_ADDRESS = '0x' + 'b2'.repeat(32);
const CIRCLE_ID = '0x' + 'c3'.repeat(32);
const SESSION_ID = 'link-circle-session';
const PHONE = '+237650000000';

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

function registryObjectWithLink() {
  return {
    data: {
      content: {
        dataType: 'moveObject',
        fields: {
          links: [
            {
              fields: {
                circle_id: CIRCLE_ID,
                enabled: true,
                link_type: 1,
                walrus_blob_id: Array.from(Buffer.from('blob-1', 'utf8')),
                link_nonce: [1, 2, 3, 4],
              },
            },
          ],
        },
      },
    },
  };
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

function createGetReq(
  query: Record<string, string>,
  cookies: Record<string, string> = {},
): NextApiRequest {
  return {
    method: 'GET',
    url: '/api/whatsapp/admin-link-circle',
    headers: {},
    socket: {},
    cookies,
    query,
    body: undefined,
  } as unknown as NextApiRequest;
}

describe('admin-link-circle GET includeRecipient PII gate', () => {
  beforeEach(() => {
    getZkLoginSessionStore().clear();
    (getActiveWhatsAppRegistries as jest.Mock).mockReturnValue([
      { packageId: '0xpkg', registryObjectId: '0xreg' },
    ]);
    (getPooledSuiClient as jest.Mock).mockReturnValue({
      getObject: jest.fn().mockResolvedValue(registryObjectWithLink()),
    });
    (fetchAndDecryptPII as jest.Mock).mockResolvedValue({
      schema_version: 1,
      link_type: 'individual',
      phone_e164: PHONE,
    });
  });

  it('rejects includeRecipient=true without a session and leaks zero PII', async () => {
    const res = createMockRes();

    await handler(
      createGetReq({ circleId: CIRCLE_ID, includeRecipient: 'true' }),
      res,
    );

    expect(res.statusCode).toBe(401);
    expect(fetchAndDecryptPII).not.toHaveBeenCalled();
    expect(JSON.stringify(res.jsonBody)).not.toContain(PHONE);
    expect(JSON.stringify(res.jsonBody)).not.toContain('recipient');
  });

  it('rejects includeRecipient=true for a session that is not the circle admin', async () => {
    getZkLoginSessionStore().set(SESSION_ID, buildSessionRecord(OTHER_ADDRESS));
    (fetchCircleAdminAddress as jest.Mock).mockResolvedValue(ADMIN_ADDRESS);
    const res = createMockRes();

    await handler(
      createGetReq(
        { circleId: CIRCLE_ID, includeRecipient: 'true' },
        { 'session-id': SESSION_ID },
      ),
      res,
    );

    expect(res.statusCode).toBe(403);
    expect(fetchAndDecryptPII).not.toHaveBeenCalled();
  });

  it('returns the decrypted recipient for the verified circle admin', async () => {
    getZkLoginSessionStore().set(SESSION_ID, buildSessionRecord(ADMIN_ADDRESS));
    (fetchCircleAdminAddress as jest.Mock).mockResolvedValue(ADMIN_ADDRESS);
    const res = createMockRes();

    await handler(
      createGetReq(
        { circleId: CIRCLE_ID, includeRecipient: 'true' },
        { 'session-id': SESSION_ID },
      ),
      res,
    );

    expect(res.statusCode).toBe(200);
    const body = res.jsonBody as { data: { isLinked: boolean; recipient?: string } };
    expect(body.data.isLinked).toBe(true);
    expect(body.data.recipient).toBe(PHONE);
  });

  it('keeps the unauthenticated link-existence probe working without PII', async () => {
    const res = createMockRes();

    await handler(createGetReq({ circleId: CIRCLE_ID }), res);

    expect(res.statusCode).toBe(200);
    const body = res.jsonBody as { data: { isLinked: boolean; recipient?: string } };
    expect(body.data.isLinked).toBe(true);
    expect(body.data.recipient).toBeUndefined();
    expect(fetchAndDecryptPII).not.toHaveBeenCalled();
  });
});

// Captures every txb.moveCall the route builds so tests can assert the
// on-chain target circle. Pass-through pure/object helpers keep the raw
// argument values visible.
function mockSendTransactionCapturingMoveCalls() {
  const moveCalls: Array<{ target: string; arguments: unknown[] }> = [];
  (enokiZkLoginService.sendTransaction as jest.Mock).mockImplementation(
    async (_account: unknown, build: (txb: unknown) => void) => {
      build({
        moveCall: (call: { target: string; arguments: unknown[] }) => moveCalls.push(call),
        object: (id: string) => id,
        pure: {
          address: (a: string) => a,
          u8: (n: number) => n,
          vector: (_type: string, v: unknown) => v,
        },
      });
      return { digest: '0xdigest' };
    },
  );
  return moveCalls;
}

function createPostReq(
  path: string,
  body: Record<string, unknown>,
  query: Record<string, string> = {},
  cookies: Record<string, string> = {},
): NextApiRequest {
  return {
    method: 'POST',
    url: path,
    headers: {},
    socket: {},
    cookies,
    query,
    body,
  } as unknown as NextApiRequest;
}

describe('admin-link-circle POST authorization ordering', () => {
  beforeEach(() => {
    getZkLoginSessionStore().clear();
    jest.clearAllMocks();
    (getActiveWhatsAppRegistries as jest.Mock).mockReturnValue([
      { packageId: '0xpkg', registryObjectId: '0xreg' },
    ]);
  });

  it('rejects unauthenticated POSTs before any Walrus upload or index write', async () => {
    const res = createMockRes();
    const req = createPostReq('/api/whatsapp/admin-link-circle', {
      circleId: CIRCLE_ID,
      linkType: 1,
      phoneOrGroup: PHONE,
      adminAddress: ADMIN_ADDRESS,
      network: 'testnet',
    });

    await handler(req, res);

    expect(res.statusCode).toBe(401);
    expect(encryptAndStorePII).not.toHaveBeenCalled();
  });

  // Cross-circle WhatsApp link hijack regression: the attacker admins
  // ATTACKER_CIRCLE and tries to authorize against it via the query string
  // while the body targets VICTIM_CIRCLE. The request must die before any
  // Walrus upload, chain anchor, or Postgres index write.
  it('rejects a query/body circleId divergence before any side effect', async () => {
    const ATTACKER_CIRCLE = '0x' + 'e5'.repeat(32);
    getZkLoginSessionStore().set(SESSION_ID, buildSessionRecord(OTHER_ADDRESS));
    // Attacker IS the on-chain admin of their own circle — auth would pass
    // if the middleware authorized against the query value.
    (fetchCircleAdminAddress as jest.Mock).mockResolvedValue(OTHER_ADDRESS);
    const res = createMockRes();

    await handler(
      createPostReq(
        '/api/whatsapp/admin-link-circle',
        {
          circleId: CIRCLE_ID, // victim circle in the body
          linkType: 1,
          phoneOrGroup: PHONE,
          account: buildSessionRecord(OTHER_ADDRESS).account,
          network: 'testnet',
        },
        { circleId: ATTACKER_CIRCLE }, // attacker circle in the query
        { 'session-id': SESSION_ID },
      ),
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(encryptAndStorePII).not.toHaveBeenCalled();
    expect(enokiZkLoginService.sendTransaction).not.toHaveBeenCalled();
    expect(indexWhatsAppLink).not.toHaveBeenCalled();
  });

  // These two used to assert that the ROUTE built and signed the anchor.
  // It no longer may: the request carried the caller's ephemeralPrivateKey
  // to make that possible, which handed the server the ability to sign any
  // transaction for that address. The anchor is signed in the browser now,
  // so the route's contract is "prepare, then record" and the tests assert
  // that shape instead.
  it('prepares the anchor without signing, and does not index yet', async () => {
    getZkLoginSessionStore().set(SESSION_ID, buildSessionRecord(ADMIN_ADDRESS));
    (fetchCircleAdminAddress as jest.Mock).mockResolvedValue(ADMIN_ADDRESS);
    (encryptAndStorePII as jest.Mock).mockResolvedValue({
      walrusBlobId: 'blob-1',
      linkNonce: new Uint8Array([1, 2, 3, 4]),
    });
    const moveCalls = mockSendTransactionCapturingMoveCalls();
    const res = createMockRes();

    await handler(
      createPostReq(
        '/api/whatsapp/admin-link-circle',
        {
          circleId: CIRCLE_ID,
          linkType: 1,
          phoneOrGroup: PHONE,
          network: 'testnet',
        },
        {},
        { 'session-id': SESSION_ID },
      ),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect((res.jsonBody as { data: Record<string, unknown> }).data.status).toBe('pending');
    // The PII is stored — that is the part only the server can do.
    expect(encryptAndStorePII).toHaveBeenCalled();
    // The anchor inputs come back so the browser can build the call itself.
    expect((res.jsonBody as { data: Record<string, unknown> }).data).toEqual(
      expect.objectContaining({
        walrusBlobId: 'blob-1',
        packageId: '0xpkg',
        registryObjectId: '0xreg',
      }),
    );
    // Nothing was signed here, and no route was written for a link that
    // does not exist on chain yet.
    expect(moveCalls).toHaveLength(0);
    expect(enokiZkLoginService.sendTransaction).not.toHaveBeenCalled();
    expect(indexWhatsAppLink).not.toHaveBeenCalled();
  });

  it('indexes only once the client reports the anchor landed', async () => {
    getZkLoginSessionStore().set(SESSION_ID, buildSessionRecord(ADMIN_ADDRESS));
    (fetchCircleAdminAddress as jest.Mock).mockResolvedValue(ADMIN_ADDRESS);
    const res = createMockRes();

    await handler(
      createPostReq(
        '/api/whatsapp/admin-link-circle',
        {
          circleId: CIRCLE_ID,
          linkType: 1,
          phoneOrGroup: PHONE,
          network: 'testnet',
          anchoredDigest: '0xdigest',
          walrusBlobId: 'blob-1',
        },
        {},
        { 'session-id': SESSION_ID },
      ),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect((res.jsonBody as { data: Record<string, unknown> }).data.status).toBe('confirmed');
    expect(indexWhatsAppLink).toHaveBeenCalledWith(
      expect.objectContaining({ circleId: CIRCLE_ID, walrusBlobId: 'blob-1' }),
    );
    // The confirm call must not re-upload the blob it was handed.
    expect(encryptAndStorePII).not.toHaveBeenCalled();
    expect(enokiZkLoginService.sendTransaction).not.toHaveBeenCalled();
  });
});

describe('admin-unlink-circle POST authorization binding', () => {
  beforeEach(() => {
    getZkLoginSessionStore().clear();
    jest.clearAllMocks();
    (getActiveWhatsAppRegistries as jest.Mock).mockReturnValue([
      { packageId: '0xpkg', registryObjectId: '0xreg' },
    ]);
  });

  it('rejects a query/body circleId divergence before the chain call or deindex', async () => {
    const ATTACKER_CIRCLE = '0x' + 'e5'.repeat(32);
    getZkLoginSessionStore().set(SESSION_ID, buildSessionRecord(OTHER_ADDRESS));
    (fetchCircleAdminAddress as jest.Mock).mockResolvedValue(OTHER_ADDRESS);
    const res = createMockRes();

    await unlinkHandler(
      createPostReq(
        '/api/whatsapp/admin-unlink-circle',
        {
          circleId: CIRCLE_ID,
          account: buildSessionRecord(OTHER_ADDRESS).account,
          network: 'testnet',
        },
        { circleId: ATTACKER_CIRCLE },
        { 'session-id': SESSION_ID },
      ),
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(enokiZkLoginService.sendTransaction).not.toHaveBeenCalled();
    expect(deindexWhatsAppLinksForCircle).not.toHaveBeenCalled();
  });

  it('returns anchor inputs without signing, and does not deindex yet', async () => {
    getZkLoginSessionStore().set(SESSION_ID, buildSessionRecord(ADMIN_ADDRESS));
    (fetchCircleAdminAddress as jest.Mock).mockResolvedValue(ADMIN_ADDRESS);
    const moveCalls = mockSendTransactionCapturingMoveCalls();
    const res = createMockRes();

    await unlinkHandler(
      createPostReq(
        '/api/whatsapp/admin-unlink-circle',
        { circleId: CIRCLE_ID, network: 'testnet' },
        {},
        { 'session-id': SESSION_ID },
      ),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect((res.jsonBody as { data: Record<string, unknown> }).data.status).toBe('pending');
    expect((res.jsonBody as { data: Record<string, unknown> }).data).toEqual(
      expect.objectContaining({ packageId: '0xpkg', registryObjectId: '0xreg' }),
    );
    // The unlink is signed in the browser; the route must not sign, and must
    // not tear down routing for a link that is still live on chain.
    expect(moveCalls).toHaveLength(0);
    expect(enokiZkLoginService.sendTransaction).not.toHaveBeenCalled();
    expect(deindexWhatsAppLinksForCircle).not.toHaveBeenCalled();
  });

  it('deindexes only once the client reports the unlink landed', async () => {
    getZkLoginSessionStore().set(SESSION_ID, buildSessionRecord(ADMIN_ADDRESS));
    (fetchCircleAdminAddress as jest.Mock).mockResolvedValue(ADMIN_ADDRESS);
    const res = createMockRes();

    await unlinkHandler(
      createPostReq(
        '/api/whatsapp/admin-unlink-circle',
        { circleId: CIRCLE_ID, network: 'testnet', anchoredDigest: '0xdigest' },
        {},
        { 'session-id': SESSION_ID },
      ),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect((res.jsonBody as { data: Record<string, unknown> }).data.status).toBe('confirmed');
    expect(deindexWhatsAppLinksForCircle).toHaveBeenCalledWith(CIRCLE_ID);
    expect(enokiZkLoginService.sendTransaction).not.toHaveBeenCalled();
  });
});
