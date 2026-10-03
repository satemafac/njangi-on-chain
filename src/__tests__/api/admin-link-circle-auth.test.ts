/**
 * Regression tests for the WhatsApp admin-link-circle endpoint
 * (gtm-readiness review, June 2026):
 *
 * - GET ?includeRecipient=true used to decrypt and return the linked
 *   WhatsApp phone number with NO auth. It now requires the caller's
 *   zkLogin session to resolve to the on-chain circle admin; without that
 *   the response carries zero PII. Since October 2026 even the admin gets
 *   only a mask ("+237 ••• ••• 1234") and the link date, read from the
 *   renewed blob in the link index, and from the anchored blob only when
 *   the index has no row for the circle.
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
 *
 * Group links (October 2026): POST refuses linkType 2. A WhatsApp Cloud API
 * number can message only groups it created through Meta's Groups API, so a
 * group id copied from the WhatsApp app (…@g.us) never received anything.
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
  lookupBlobsForCircle: jest.fn(),
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
  lookupBlobsForCircle,
} from '@/lib/whatsapp-link-index';

const ADMIN_ADDRESS = '0x' + 'a1'.repeat(32);
const OTHER_ADDRESS = '0x' + 'b2'.repeat(32);
const CIRCLE_ID = '0x' + 'c3'.repeat(32);
const SESSION_ID = 'link-circle-session';
const PHONE = '+237650000000';
const PHONE_NATIONAL = '650000000';
const MASKED_PHONE = '+237 ••• ••• 0000';
const LINKED_AT = '2026-09-30T10:15:00.000Z';

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
      created_at: LINKED_AT,
    });
    // No index row by default: the anchored blob is the only candidate.
    (lookupBlobsForCircle as jest.Mock).mockResolvedValue([]);
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

  // This used to return the decrypted number in full. Nothing ever read it
  // (the card called the public probe), and the card now needs only a mask,
  // so the full E.164 no longer leaves the server, even for the admin.
  it('returns only a masked number and the link date to the verified circle admin', async () => {
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
    const body = res.jsonBody as {
      data: { isLinked: boolean; recipient?: string; maskedRecipient?: string; linkedAt?: string };
    };
    expect(body.data.isLinked).toBe(true);
    expect(body.data.maskedRecipient).toBe(MASKED_PHONE);
    expect(body.data.linkedAt).toBe(LINKED_AT);
    expect(body.data.recipient).toBeUndefined();
    expect(JSON.stringify(res.jsonBody)).not.toContain(PHONE);
    expect(JSON.stringify(res.jsonBody)).not.toContain(PHONE_NATIONAL);
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

  it('keeps the public probe away from the link index and the masked fields', async () => {
    const res = createMockRes();

    await handler(createGetReq({ circleId: CIRCLE_ID }), res);

    const body = res.jsonBody as { data: Record<string, unknown> };
    expect(body.data.maskedRecipient).toBeUndefined();
    expect(body.data.linkedAt).toBeUndefined();
    expect(lookupBlobsForCircle).not.toHaveBeenCalled();
  });

  /** GET ?includeRecipient=true as the verified circle admin. */
  async function adminGet() {
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
    return {
      statusCode: res.statusCode,
      data: (res.jsonBody as { data: Record<string, unknown> }).data,
      raw: JSON.stringify(res.jsonBody),
    };
  }

  /** Opens only the listed blob ids; every other one fails like an expired blob. */
  function openOnly(...blobIds: string[]) {
    (fetchAndDecryptPII as jest.Mock).mockImplementation(async (blobId: string) => {
      if (!blobIds.includes(blobId)) {
        throw new Error(`Walrus aggregator returned 404: blob ${blobId} not found`);
      }
      return {
        schema_version: 1,
        link_type: 'individual',
        phone_e164: PHONE,
        created_at: LINKED_AT,
      };
    });
  }

  const openedBlobIds = () =>
    (fetchAndDecryptPII as jest.Mock).mock.calls.map(([blobId]) => blobId);

  // Renewal re-stores the blob under a new id and records it only in the
  // index; the anchored id ('blob-1') expires with its first lease.
  it('reads the renewed blob from the link index before the anchored one', async () => {
    (lookupBlobsForCircle as jest.Mock).mockResolvedValue(['blob-renewed']);
    openOnly('blob-renewed');

    const { statusCode, data } = await adminGet();

    expect(statusCode).toBe(200);
    expect(data.maskedRecipient).toBe(MASKED_PHONE);
    expect(data.linkedAt).toBe(LINKED_AT);
    expect(lookupBlobsForCircle).toHaveBeenCalledWith(CIRCLE_ID);
    expect(openedBlobIds()).toEqual(['blob-renewed']);
  });

  it('tries every indexed blob, newest first', async () => {
    (lookupBlobsForCircle as jest.Mock).mockResolvedValue(['blob-renewed', 'blob-older']);
    openOnly('blob-older');

    const { data } = await adminGet();

    expect(data.maskedRecipient).toBe(MASKED_PHONE);
    expect(openedBlobIds()).toEqual(['blob-renewed', 'blob-older']);
  });

  // Same rule as resolveMemberPhone: the anchored id is used only when the
  // index has no row for the circle. With a row, it is the stale pre-renewal id.
  it('does not fall back to the anchored blob when the index has a row', async () => {
    (lookupBlobsForCircle as jest.Mock).mockResolvedValue(['blob-renewed']);
    openOnly('blob-1');

    const { statusCode, data } = await adminGet();

    expect(statusCode).toBe(200);
    expect(data.isLinked).toBe(true);
    expect(data.maskedRecipient).toBeUndefined();
    expect(openedBlobIds()).toEqual(['blob-renewed']);
  });

  it('uses the anchored blob when the index has no row for the circle', async () => {
    openOnly('blob-1');

    const { data } = await adminGet();

    expect(data.maskedRecipient).toBe(MASKED_PHONE);
    expect(openedBlobIds()).toEqual(['blob-1']);
  });

  it('falls back to the anchored blob when the index lookup fails', async () => {
    (lookupBlobsForCircle as jest.Mock).mockRejectedValue(new Error('connection refused'));
    openOnly('blob-1');

    const { statusCode, data } = await adminGet();

    expect(statusCode).toBe(200);
    expect(data.maskedRecipient).toBe(MASKED_PHONE);
    expect(openedBlobIds()).toEqual(['blob-1']);
  });

  it('still reports the link, without a number, when no envelope opens', async () => {
    (lookupBlobsForCircle as jest.Mock).mockResolvedValue(['blob-renewed']);
    openOnly();

    const { statusCode, data } = await adminGet();

    expect(statusCode).toBe(200);
    expect(data.isLinked).toBe(true);
    expect(data.maskedRecipient).toBeUndefined();
    expect(data.linkedAt).toBeUndefined();
  });

  it('masks nothing for a group link and never returns the group id', async () => {
    const GROUP_ID = '120363043968066561@g.us';
    (fetchAndDecryptPII as jest.Mock).mockResolvedValue({
      schema_version: 1,
      link_type: 'group',
      group_id: GROUP_ID,
      created_at: LINKED_AT,
    });

    const { data, raw } = await adminGet();

    expect(data.isLinked).toBe(true);
    expect(data.maskedRecipient).toBeUndefined();
    expect(data.linkedAt).toBe(LINKED_AT);
    expect(raw).not.toContain(GROUP_ID);
  });

  it.each([
    [
      'a failed index lookup',
      () => (lookupBlobsForCircle as jest.Mock).mockRejectedValue(new Error('connection refused')),
      'connection refused',
    ],
    [
      'an indexed blob that does not open',
      () =>
        (lookupBlobsForCircle as jest.Mock).mockResolvedValue(['blob-renewed', 'blob-1']),
      'blob-renewed',
    ],
  ])('never logs the number while it works past %s', async (_label, arrange, expectedInLog) => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      jest.spyOn(console, method).mockImplementation(() => undefined),
    );
    arrange();
    openOnly('blob-1');

    const { data } = await adminGet();

    const logged = spies
      .flatMap((spy) => spy.mock.calls.flat())
      .map((arg) => (arg instanceof Error ? `${arg.message} ${arg.stack}` : JSON.stringify(arg)))
      .join('\n');
    // The failure was logged, the number was resolved, and never logged.
    expect(logged).toContain(expectedInLog);
    expect(data.maskedRecipient).toBe(MASKED_PHONE);
    expect(logged).not.toContain(PHONE);
    expect(logged).not.toContain(PHONE_NATIONAL);
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

describe('admin-link-circle POST group links', () => {
  beforeEach(() => {
    getZkLoginSessionStore().clear();
    jest.clearAllMocks();
    (getActiveWhatsAppRegistries as jest.Mock).mockReturnValue([
      { packageId: '0xpkg', registryObjectId: '0xreg' },
    ]);
  });

  it.each([
    ['prepare', {}],
    ['confirm', { anchoredDigest: '0xdigest', walrusBlobId: 'blob-1' }],
  ])('refuses a group link at the %s step before any side effect', async (_step, extra) => {
    getZkLoginSessionStore().set(SESSION_ID, buildSessionRecord(ADMIN_ADDRESS));
    (fetchCircleAdminAddress as jest.Mock).mockResolvedValue(ADMIN_ADDRESS);
    const res = createMockRes();

    await handler(
      createPostReq(
        '/api/whatsapp/admin-link-circle',
        {
          circleId: CIRCLE_ID,
          linkType: 2,
          phoneOrGroup: '120363043968066561@g.us',
          network: 'testnet',
          ...extra,
        },
        {},
        { 'session-id': SESSION_ID },
      ),
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(res.jsonBody).toMatchObject({
      success: false,
      code: 'WHATSAPP_GROUP_LINKS_UNSUPPORTED',
      error: expect.stringContaining('Link a phone number instead'),
    });
    expect(encryptAndStorePII).not.toHaveBeenCalled();
    expect(indexWhatsAppLink).not.toHaveBeenCalled();
  });

  it('still rejects a linkType that is neither a phone nor a group', async () => {
    getZkLoginSessionStore().set(SESSION_ID, buildSessionRecord(ADMIN_ADDRESS));
    (fetchCircleAdminAddress as jest.Mock).mockResolvedValue(ADMIN_ADDRESS);
    const res = createMockRes();

    await handler(
      createPostReq(
        '/api/whatsapp/admin-link-circle',
        { circleId: CIRCLE_ID, linkType: 3, phoneOrGroup: PHONE, network: 'testnet' },
        {},
        { 'session-id': SESSION_ID },
      ),
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(res.jsonBody).toEqual({ success: false, error: 'Invalid linkType (must be 1)' });
    expect(encryptAndStorePII).not.toHaveBeenCalled();
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
