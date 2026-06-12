/**
 * Handler-level tests for GET /api/cron/cycle-finalized (June 2026
 * cron-overlap fix). Vercel does not prevent concurrent cron executions,
 * so the handler must win the Postgres run lease before draining and
 * short-circuit with 200 `{ skipped: 'already_running' }` when another
 * invocation holds it — and must release the lease even when the drain
 * blows up.
 *
 * Lives in lib/__tests__ (not next to the route): files under src/pages
 * are compiled as routes by Next, so test files must stay out.
 */

jest.mock('../pg-pool', () => ({
  isPostgresConfigured: () => true,
}));
jest.mock('../cycle-finalized-cron', () => ({
  acquireCycleFinalizedLease: jest.fn(),
  releaseCycleFinalizedLease: jest.fn(async () => undefined),
  cycleFinalizedCursorKey: jest.fn((pkg: string, network: string) => `${pkg}:${network}`),
  loadCycleFinalizedCursor: jest.fn(async () => null),
  saveCycleFinalizedCursor: jest.fn(async () => undefined),
  drainCycleFinalizedEvents: jest.fn(),
  parseCycleFinalizedEvent: jest.fn(),
  formatCoinAmount: jest.fn(() => '1 SUI'),
}));
jest.mock('../your-turn-notification', () => ({
  sendYourTurnNotification: jest.fn(),
}));
jest.mock('../circle-chain', () => ({
  getPublishedPackageMetadata: jest.fn(() => ({ originalId: '0xoriginal' })),
  normalizePackageId: jest.fn((value?: string) => value ?? null),
}));
jest.mock('../../services/network-config', () => ({
  getCurrentNetwork: jest.fn(() => 'testnet'),
  getNetworkConfig: jest.fn(() => ({ rpcUrl: 'http://localhost:9000' })),
}));
jest.mock('../../services/sui-rpc-failover', () => ({
  getPooledSuiClient: jest.fn(() => ({
    queryEvents: jest.fn(),
    getObject: jest.fn(),
  })),
}));

import type { NextApiRequest, NextApiResponse } from 'next';
import handler from '../../pages/api/cron/cycle-finalized';
import {
  acquireCycleFinalizedLease,
  releaseCycleFinalizedLease,
  drainCycleFinalizedEvents,
} from '../cycle-finalized-cron';

const acquireMock = acquireCycleFinalizedLease as jest.Mock;
const releaseMock = releaseCycleFinalizedLease as jest.Mock;
const drainMock = drainCycleFinalizedEvents as jest.Mock;

const SECRET = 'test-cron-secret';
const ORIGINAL_ENV = {
  CRON_SECRET: process.env.CRON_SECRET,
  PACKAGE_ID: process.env.PACKAGE_ID,
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

function emptyDrainResult() {
  return {
    pages: 1,
    processed: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
    halted: false,
    finalCursor: null,
  };
}

beforeEach(() => {
  process.env.CRON_SECRET = SECRET;
  delete process.env.PACKAGE_ID;
  acquireMock.mockReset();
  releaseMock.mockReset().mockResolvedValue(undefined);
  drainMock.mockReset();
});

afterAll(() => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('overlap protection', () => {
  it('returns 200 skipped (and never drains) when another run holds the lease', async () => {
    acquireMock.mockResolvedValue(null);
    const res = makeRes();

    await handler(makeReq(), res as unknown as NextApiResponse);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ skipped: 'already_running' });
    expect(drainMock).not.toHaveBeenCalled();
    // Nothing to release — we never owned the lease.
    expect(releaseMock).not.toHaveBeenCalled();
  });

  it('drains while holding the lease and releases it afterwards', async () => {
    acquireMock.mockResolvedValue('token-1');
    drainMock.mockResolvedValue(emptyDrainResult());
    const res = makeRes();

    await handler(makeReq(), res as unknown as NextApiResponse);

    expect(res.statusCode).toBe(200);
    expect(acquireMock).toHaveBeenCalledWith('0xoriginal:testnet');
    expect(drainMock).toHaveBeenCalledTimes(1);
    expect(releaseMock).toHaveBeenCalledWith('0xoriginal:testnet', 'token-1');
    // The lease must be held for the WHOLE drain.
    expect(acquireMock.mock.invocationCallOrder[0]).toBeLessThan(
      drainMock.mock.invocationCallOrder[0],
    );
    expect(drainMock.mock.invocationCallOrder[0]).toBeLessThan(
      releaseMock.mock.invocationCallOrder[0],
    );
  });

  it('releases the lease even when the drain throws (500)', async () => {
    acquireMock.mockResolvedValue('token-2');
    drainMock.mockRejectedValue(new Error('rpc exploded'));
    const res = makeRes();

    await handler(makeReq(), res as unknown as NextApiResponse);

    expect(res.statusCode).toBe(500);
    expect(releaseMock).toHaveBeenCalledWith('0xoriginal:testnet', 'token-2');
  });

  it('releases the lease on a halted drain (500, cursor not advanced)', async () => {
    acquireMock.mockResolvedValue('token-3');
    drainMock.mockResolvedValue({ ...emptyDrainResult(), halted: true });
    const res = makeRes();

    await handler(makeReq(), res as unknown as NextApiResponse);

    expect(res.statusCode).toBe(500);
    expect(res.body).toMatchObject({ error: 'drain halted' });
    expect(releaseMock).toHaveBeenCalledWith('0xoriginal:testnet', 'token-3');
  });

  it('rejects bad bearer tokens before touching the lease', async () => {
    const res = makeRes();

    await handler(makeReq('Bearer wrong-secret'), res as unknown as NextApiResponse);

    expect(res.statusCode).toBe(401);
    expect(acquireMock).not.toHaveBeenCalled();
  });
});
