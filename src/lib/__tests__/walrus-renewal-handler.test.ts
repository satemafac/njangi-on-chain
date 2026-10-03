/**
 * Handler-level tests for GET /api/cron/walrus-renewal. Mirrors the
 * cycle-finalized cron handler tests: auth (timing-safe bearer), the
 * Postgres fail-closed gate, the run-lease single-flight, lease release on
 * both the happy path and a thrown drain, and the index update path. Also
 * the epoch source: end epochs are compared with the WALRUS epoch from the
 * Walrus System object, never the Sui epoch, and an unreadable one fails
 * the run before anything is renewed.
 *
 * Lives in lib/__tests__ (not next to the route): files under src/pages are
 * compiled as routes by Next, so test files must stay out.
 */

jest.mock('../pg-pool', () => ({
  isPostgresConfigured: () => true,
}));
jest.mock('../cycle-finalized-cron', () => ({
  acquireCycleFinalizedLease: jest.fn(),
  releaseCycleFinalizedLease: jest.fn(async () => undefined),
}));
jest.mock('../whatsapp-link-index', () => ({
  listActiveLinksForRenewal: jest.fn(async () => []),
  applyWalrusRenewal: jest.fn(async () => true),
}));
jest.mock('../walrus-pii', () => ({
  restorePiiBlob: jest.fn(),
}));
jest.mock('../../services/network-config', () => ({
  getCurrentNetwork: jest.fn(() => 'testnet'),
  getNetworkConfig: jest.fn(() => ({ rpcUrl: 'http://localhost:9000' })),
}));
jest.mock('../../services/sui-rpc-failover', () => ({
  getPooledSuiClient: jest.fn(),
}));

import type { NextApiRequest, NextApiResponse } from 'next';
import handler from '../../pages/api/cron/walrus-renewal';
import {
  acquireCycleFinalizedLease,
  releaseCycleFinalizedLease,
} from '../cycle-finalized-cron';
import {
  listActiveLinksForRenewal,
  applyWalrusRenewal,
} from '../whatsapp-link-index';
import { restorePiiBlob } from '../walrus-pii';
import { getPooledSuiClient } from '../../services/sui-rpc-failover';

const acquireMock = acquireCycleFinalizedLease as jest.Mock;
const releaseMock = releaseCycleFinalizedLease as jest.Mock;
const listMock = listActiveLinksForRenewal as jest.Mock;
const applyMock = applyWalrusRenewal as jest.Mock;
const restoreMock = restorePiiBlob as jest.Mock;
const clientMock = getPooledSuiClient as jest.Mock;

const TESTNET_WALRUS_SYSTEM = '0x6c2547cbbc38025cf3adac45f63cb0a8d12ecf777cdc75a4971612bf97fdf6af';
const WALRUS_PKG = '0xd84704c17fc870b8764832c535aa6b11f21a95cd6f5bb38a9b07d2cf42220c66';

/**
 * A Sui client whose Walrus System object reports `walrusEpoch` (or fails
 * with it) and whose Sui system state reports epoch 1240, as testnet did on
 * 2026-10-02 alongside Walrus epoch 538. The cron must never read the latter.
 */
function chainClient(walrusEpoch: number | Error) {
  return {
    getObject: jest.fn(async ({ id }: { id: string }) => {
      if (walrusEpoch instanceof Error) throw walrusEpoch;
      return {
        data: {
          objectId: id,
          content: {
            dataType: 'moveObject',
            type: `${WALRUS_PKG}::system::System`,
            fields: { id: { id }, version: '3' },
          },
        },
      };
    }),
    getDynamicFieldObject: jest.fn(async () => ({
      data: {
        content: {
          dataType: 'moveObject',
          type: `0x2::dynamic_field::Field<u64, ${WALRUS_PKG}::system_state_inner::SystemStateInnerV1>`,
          fields: {
            name: '3',
            value: {
              type: `${WALRUS_PKG}::system_state_inner::SystemStateInnerV1`,
              fields: {
                committee: {
                  type: `${WALRUS_PKG}::bls_aggregate::BlsCommittee`,
                  fields: { epoch: walrusEpoch },
                },
              },
            },
          },
        },
      },
    })),
    getLatestSuiSystemState: jest.fn(async () => ({ epoch: '1240' })),
  };
}

const SECRET = 'test-cron-secret';
const ORIGINAL_ENV = {
  CRON_SECRET: process.env.CRON_SECRET,
  RENEWAL_THRESHOLD_EPOCHS: process.env.RENEWAL_THRESHOLD_EPOCHS,
  WALRUS_SYSTEM_OBJECT_ID_TESTNET: process.env.WALRUS_SYSTEM_OBJECT_ID_TESTNET,
};

interface FakeRes {
  statusCode: number;
  body: unknown;
  setHeader: jest.Mock;
  status: (code: number) => FakeRes;
  json: (payload: unknown) => FakeRes;
}

function makeReq(authorization?: string): NextApiRequest {
  return {
    method: 'GET',
    headers: { authorization: authorization ?? `Bearer ${SECRET}` },
  } as unknown as NextApiRequest;
}

function makeRes(): FakeRes {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    setHeader: jest.fn(),
  } as FakeRes;
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload: unknown) => {
    res.body = payload;
    return res;
  };
  return res;
}

beforeEach(() => {
  process.env.CRON_SECRET = SECRET;
  delete process.env.RENEWAL_THRESHOLD_EPOCHS;
  delete process.env.WALRUS_SYSTEM_OBJECT_ID_TESTNET;
  acquireMock.mockReset().mockResolvedValue('lease-token');
  releaseMock.mockReset().mockResolvedValue(undefined);
  listMock.mockReset().mockResolvedValue([]);
  applyMock.mockReset().mockResolvedValue(true);
  restoreMock.mockReset();
  clientMock.mockReset().mockReturnValue(chainClient(100));
});

afterAll(() => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

it('rejects a non-GET method with 405', async () => {
  const req = { method: 'POST', headers: {} } as unknown as NextApiRequest;
  const res = makeRes();
  await handler(req, res as unknown as NextApiResponse);
  expect(res.statusCode).toBe(405);
});

it('rejects a missing/incorrect bearer with 401', async () => {
  const res = makeRes();
  await handler(makeReq('Bearer wrong'), res as unknown as NextApiResponse);
  expect(res.statusCode).toBe(401);
  expect(acquireMock).not.toHaveBeenCalled();
});

it('fails closed with 500 when CRON_SECRET is unset', async () => {
  delete process.env.CRON_SECRET;
  const res = makeRes();
  await handler(makeReq('Bearer anything'), res as unknown as NextApiResponse);
  expect(res.statusCode).toBe(500);
});

it('skips with 200 when another invocation holds the lease', async () => {
  acquireMock.mockResolvedValue(null);
  const res = makeRes();
  await handler(makeReq(), res as unknown as NextApiResponse);
  expect(res.statusCode).toBe(200);
  expect(res.body).toMatchObject({ skipped: 'already_running' });
  expect(listMock).not.toHaveBeenCalled();
  // No lease was acquired, so none is released.
  expect(releaseMock).not.toHaveBeenCalled();
});

it('renews an expiring blob end-to-end and releases the lease', async () => {
  listMock.mockResolvedValue([
    { id: 1, circleId: '0xc', walrusBlobId: 'blob-old', walrusEndEpoch: 100 },
  ]);
  restoreMock.mockResolvedValue({ newBlobId: 'blob-new', newEndEpoch: 142 });
  const res = makeRes();

  await handler(makeReq(), res as unknown as NextApiResponse);

  expect(res.statusCode).toBe(200);
  expect(res.body).toMatchObject({ renewed: 1, skipped: 0, failed: 0 });
  expect(applyMock).toHaveBeenCalledWith({
    id: 1,
    expectedBlobId: 'blob-old',
    newBlobId: 'blob-new',
    newEndEpoch: 142,
  });
  expect(releaseMock).toHaveBeenCalledWith('walrus-renewal:testnet', 'lease-token');
});

it('counts a restore that returns no end epoch as a failure (not a silent NULL churn)', async () => {
  listMock.mockResolvedValue([
    { id: 1, circleId: '0xc', walrusBlobId: 'blob-old', walrusEndEpoch: 100 },
  ]);
  restoreMock.mockResolvedValue({ newBlobId: 'blob-new', newEndEpoch: null });
  const res = makeRes();

  await handler(makeReq(), res as unknown as NextApiResponse);

  expect(res.statusCode).toBe(200);
  expect(res.body).toMatchObject({ renewed: 0, failed: 1 });
  expect(applyMock).not.toHaveBeenCalled();
});

it('releases the lease even when enumeration throws', async () => {
  listMock.mockRejectedValue(new Error('db down'));
  const res = makeRes();

  await handler(makeReq(), res as unknown as NextApiResponse);

  expect(res.statusCode).toBe(500);
  expect(releaseMock).toHaveBeenCalledWith('walrus-renewal:testnet', 'lease-token');
});

it('compares end epochs with the Walrus epoch, never the Sui epoch', async () => {
  // Testnet 2026-10-02: Walrus epoch 538, Sui epoch 1240.
  const chain = chainClient(538);
  clientMock.mockReturnValue(chain);
  listMock.mockResolvedValue([
    // Stored today for 5 epochs: fresh. Against 1240 it looked long lapsed.
    { id: 1, circleId: '0xa', walrusBlobId: 'fresh', walrusEndEpoch: 543 },
    { id: 2, circleId: '0xb', walrusBlobId: 'due', walrusEndEpoch: 540 },
  ]);
  restoreMock.mockResolvedValue({ newBlobId: 'due-renewed', newEndEpoch: 543 });
  const res = makeRes();

  await handler(makeReq(), res as unknown as NextApiResponse);

  expect(res.statusCode).toBe(200);
  expect(res.body).toMatchObject({
    walrusEpoch: 538,
    considered: 2,
    skipped: 1,
    renewed: 1,
    leaseMismatches: 0,
  });
  expect(restoreMock).toHaveBeenCalledTimes(1);
  expect(restoreMock).toHaveBeenCalledWith('due');
  expect(chain.getObject).toHaveBeenCalledWith({
    id: TESTNET_WALRUS_SYSTEM,
    options: { showContent: true },
  });
  expect(chain.getLatestSuiSystemState).not.toHaveBeenCalled();
});

it('fails closed with 500, listing and renewing nothing, when the Walrus epoch is unreadable', async () => {
  clientMock.mockReturnValue(chainClient(new Error('fetch failed')));
  listMock.mockResolvedValue([
    { id: 1, circleId: '0xc', walrusBlobId: 'blob-old', walrusEndEpoch: 100 },
  ]);
  const res = makeRes();

  await handler(makeReq(), res as unknown as NextApiResponse);

  expect(res.statusCode).toBe(500);
  expect(res.body).toEqual({
    error: expect.stringMatching(
      /^Could not read the current Walrus epoch on testnet .*WALRUS_SYSTEM_OBJECT_ID_TESTNET.*fetch failed$/,
    ),
  });
  expect(listMock).not.toHaveBeenCalled();
  expect(restoreMock).not.toHaveBeenCalled();
  expect(applyMock).not.toHaveBeenCalled();
  expect(releaseMock).toHaveBeenCalledWith('walrus-renewal:testnet', 'lease-token');
});

it('reads the System object named by WALRUS_SYSTEM_OBJECT_ID_TESTNET', async () => {
  const override = `0x${'cd'.repeat(32)}`;
  process.env.WALRUS_SYSTEM_OBJECT_ID_TESTNET = override;
  const chain = chainClient(538);
  clientMock.mockReturnValue(chain);
  const res = makeRes();

  await handler(makeReq(), res as unknown as NextApiResponse);

  expect(res.statusCode).toBe(200);
  expect(chain.getObject).toHaveBeenCalledWith(expect.objectContaining({ id: override }));
});

it('answers 500 after applying a renewal whose new lease ends inside the threshold', async () => {
  clientMock.mockReturnValue(chainClient(538));
  listMock.mockResolvedValue([
    { id: 1, circleId: '0xc', walrusBlobId: 'blob-old', walrusEndEpoch: 539 },
  ]);
  // Stored for one epoch only: due again tomorrow.
  restoreMock.mockResolvedValue({ newBlobId: 'blob-new', newEndEpoch: 540 });
  const res = makeRes();

  await handler(makeReq(), res as unknown as NextApiResponse);

  expect(res.statusCode).toBe(500);
  expect(res.body).toMatchObject({
    renewed: 1,
    leaseMismatches: 1,
    error: expect.stringContaining('WALRUS_STORAGE_EPOCHS is not above RENEWAL_THRESHOLD_EPOCHS'),
  });
  // The renewal itself stands: the row points at the new copy.
  expect(applyMock).toHaveBeenCalledWith({
    id: 1,
    expectedBlobId: 'blob-old',
    newBlobId: 'blob-new',
    newEndEpoch: 540,
  });
  expect(releaseMock).toHaveBeenCalledWith('walrus-renewal:testnet', 'lease-token');
});

it.each(['0', '', '-1', 'two'])(
  'falls back to the default threshold for RENEWAL_THRESHOLD_EPOCHS=%p',
  async (value) => {
    process.env.RENEWAL_THRESHOLD_EPOCHS = value;
    clientMock.mockReturnValue(chainClient(538));
    // Two epochs left: renewed at the default threshold, never at 0.
    listMock.mockResolvedValue([
      { id: 1, circleId: '0xc', walrusBlobId: 'blob-old', walrusEndEpoch: 540 },
    ]);
    restoreMock.mockResolvedValue({ newBlobId: 'blob-new', newEndEpoch: 543 });
    const res = makeRes();

    await handler(makeReq(), res as unknown as NextApiResponse);

    expect(res.body).toMatchObject({ thresholdEpochs: 2, renewed: 1 });
  },
);

it('starts no renewal once 45s of the invocation have passed', async () => {
  let now = 1_790_910_000_000;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  clientMock.mockReturnValue(chainClient(538));
  listMock.mockResolvedValue([
    { id: 1, circleId: '0xa', walrusBlobId: 'a', walrusEndEpoch: 539 },
    { id: 2, circleId: '0xb', walrusBlobId: 'b', walrusEndEpoch: 539 },
  ]);
  restoreMock.mockImplementation(async (blobId: string) => {
    now += 46_000; // one slow upload spends the whole budget
    return { newBlobId: `${blobId}-renewed`, newEndEpoch: 543 };
  });
  const res = makeRes();

  await handler(makeReq(), res as unknown as NextApiResponse);

  expect(res.statusCode).toBe(200);
  expect(res.body).toMatchObject({ renewed: 1, capped: true, deferred: 1 });
  expect(restoreMock).toHaveBeenCalledTimes(1);
  expect(releaseMock).toHaveBeenCalledWith('walrus-renewal:testnet', 'lease-token');
});

it('fails closed with 500 when Postgres is not configured', async () => {
  jest.resetModules();
  jest.doMock('../pg-pool', () => ({ isPostgresConfigured: () => false }));
  const freshHandler = (await import('../../pages/api/cron/walrus-renewal')).default;
  const res = makeRes();
  await freshHandler(makeReq(), res as unknown as NextApiResponse);
  expect(res.statusCode).toBe(500);
  jest.dontMock('../pg-pool');
  jest.resetModules();
});
