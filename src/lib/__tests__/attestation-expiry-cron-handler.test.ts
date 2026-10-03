/**
 * Handler-level tests for GET /api/cron/attestation-expiry.
 *
 * 200 must mean "every gated circle was found and checked". A failed
 * discovery scan used to come back as `gatedCircles: 0, staleCount: 0`, and
 * one failed per-circle read aborted the whole sweep; now the members that
 * could be checked are nudged and an incomplete run answers 500 with counts.
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
jest.mock('../attestation-stale', () => ({
  discoverGatedCircleIds: jest.fn(),
  buildStaleReport: jest.fn(),
  nudgeStaleMembers: jest.fn(),
}));
jest.mock('../../services/network-config', () => ({
  getCurrentNetwork: jest.fn(() => 'testnet'),
}));

import type { NextApiRequest, NextApiResponse } from 'next';
import handler from '../../pages/api/cron/attestation-expiry';
import {
  acquireCycleFinalizedLease,
  releaseCycleFinalizedLease,
} from '../cycle-finalized-cron';
import {
  discoverGatedCircleIds,
  buildStaleReport,
  nudgeStaleMembers,
} from '../attestation-stale';

const acquireMock = acquireCycleFinalizedLease as jest.Mock;
const releaseMock = releaseCycleFinalizedLease as jest.Mock;
const discoverMock = discoverGatedCircleIds as jest.Mock;
const reportMock = buildStaleReport as jest.Mock;
const nudgeMock = nudgeStaleMembers as jest.Mock;

const SECRET = 'test-cron-secret';
const ORIGINAL_SECRET = process.env.CRON_SECRET;
const CIRCLE_A = '0x' + 'a1'.repeat(32);
const CIRCLE_B = '0x' + 'b2'.repeat(32);
const STALE_ENTRY = {
  circleId: CIRCLE_A,
  cycleNo: 2,
  memberAddress: '0x' + 'dd'.repeat(32),
  reason: 'no_attestation',
};

interface FakeRes {
  statusCode: number;
  body: unknown;
  setHeader: jest.Mock;
  status: (code: number) => FakeRes;
  json: (payload: unknown) => FakeRes;
}

function makeReq(): NextApiRequest {
  return {
    method: 'GET',
    headers: { authorization: `Bearer ${SECRET}` },
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

async function run(): Promise<FakeRes> {
  const res = makeRes();
  await handler(makeReq(), res as unknown as NextApiResponse);
  return res;
}

beforeEach(() => {
  process.env.CRON_SECRET = SECRET;
  jest.spyOn(console, 'error').mockImplementation(() => {});
  acquireMock.mockReset().mockResolvedValue('lease-token');
  releaseMock.mockReset().mockResolvedValue(undefined);
  discoverMock.mockReset();
  reportMock.mockReset();
  nudgeMock.mockReset().mockResolvedValue(0);
});

afterAll(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = ORIGINAL_SECRET;
});

describe('attestation-expiry cron', () => {
  it('answers 500, not "0 gated circles", when the discovery scan fails before finding anything', async () => {
    discoverMock.mockResolvedValue({ circleIds: [], complete: false });

    const res = await run();

    expect(res.statusCode).toBe(500);
    expect(res.body).toMatchObject({ gatedCircles: 0, discoveryComplete: false });
    expect(reportMock).not.toHaveBeenCalled();
    expect(releaseMock).toHaveBeenCalledWith('attestation-expiry', 'lease-token');
  });

  it('answers 200 when the scan completed and no circle is gated', async () => {
    discoverMock.mockResolvedValue({ circleIds: [], complete: true });

    const res = await run();

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, gatedCircles: 0, staleCount: 0, nudged: 0 });
  });

  it('answers 200 with counts when every gated circle was checked', async () => {
    discoverMock.mockResolvedValue({ circleIds: [CIRCLE_A, CIRCLE_B], complete: true });
    reportMock.mockResolvedValue({ stale: [STALE_ENTRY], unchecked: [] });
    nudgeMock.mockResolvedValue(1);

    const res = await run();

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      gatedCircles: 2,
      discoveryComplete: true,
      staleCount: 1,
      uncheckedCount: 0,
      nudged: 1,
    });
  });

  it('still nudges the stale members it found, then answers 500 naming the unchecked circles', async () => {
    discoverMock.mockResolvedValue({ circleIds: [CIRCLE_A, CIRCLE_B], complete: true });
    reportMock.mockResolvedValue({ stale: [STALE_ENTRY], unchecked: [CIRCLE_B] });
    nudgeMock.mockResolvedValue(1);

    const res = await run();

    expect(nudgeMock).toHaveBeenCalledWith('testnet', [STALE_ENTRY]);
    expect(res.statusCode).toBe(500);
    expect(res.body).toMatchObject({
      gatedCircles: 2,
      staleCount: 1,
      uncheckedCount: 1,
      unchecked: [CIRCLE_B],
      nudged: 1,
    });
    expect((res.body as { error: string }).error).toContain("couldn't check 1 of 2 gated circle(s)");
    expect(res.body).not.toHaveProperty('ok');
  });

  it('answers 500 when the scan stopped early, even if every circle it found was checked', async () => {
    discoverMock.mockResolvedValue({ circleIds: [CIRCLE_A], complete: false });
    reportMock.mockResolvedValue({ stale: [], unchecked: [] });

    const res = await run();

    expect(reportMock).toHaveBeenCalledWith('testnet', [CIRCLE_A]);
    expect(res.statusCode).toBe(500);
    expect(res.body).toMatchObject({ discoveryComplete: false, uncheckedCount: 0 });
    expect((res.body as { error: string }).error).toContain('scan stopped early');
  });
});
