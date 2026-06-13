/**
 * Handler-level tests for GET /api/cron/walrus-renewal. Mirrors the
 * cycle-finalized cron handler tests: auth (timing-safe bearer), the
 * Postgres fail-closed gate, the run-lease single-flight, lease release on
 * both the happy path and a thrown drain, and the index update path.
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
  getPooledSuiClient: jest.fn(() => ({
    getLatestSuiSystemState: jest.fn(async () => ({ epoch: '100' })),
  })),
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

const acquireMock = acquireCycleFinalizedLease as jest.Mock;
const releaseMock = releaseCycleFinalizedLease as jest.Mock;
const listMock = listActiveLinksForRenewal as jest.Mock;
const applyMock = applyWalrusRenewal as jest.Mock;
const restoreMock = restorePiiBlob as jest.Mock;

const SECRET = 'test-cron-secret';
const ORIGINAL_ENV = {
  CRON_SECRET: process.env.CRON_SECRET,
  RENEWAL_THRESHOLD_EPOCHS: process.env.RENEWAL_THRESHOLD_EPOCHS,
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
  acquireMock.mockReset().mockResolvedValue('lease-token');
  releaseMock.mockReset().mockResolvedValue(undefined);
  listMock.mockReset().mockResolvedValue([]);
  applyMock.mockReset().mockResolvedValue(true);
  restoreMock.mockReset();
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
