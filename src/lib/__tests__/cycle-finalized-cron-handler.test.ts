/**
 * Handler-level tests for GET /api/cron/cycle-finalized.
 *
 * Overlap protection (June 2026 cron-overlap fix): Vercel does not prevent
 * concurrent cron executions, so the handler must win the Postgres run
 * lease before draining and short-circuit with 200
 * `{ skipped: 'already_running' }` when another invocation holds it — and
 * must release the lease even when the drain blows up.
 *
 * Trigger (2026-09-27): the nudge goes out for the ContributionRecorded
 * that fills a round's pot, in the escrow's own coin, and never once the
 * pot has been collected or refunded. These tests run the real drain over
 * stubbed RPC pages and escrow reads.
 *
 * Lives in lib/__tests__ (not next to the route): files under src/pages
 * are compiled as routes by Next, so test files must stay out.
 */

jest.mock('../pg-pool', () => ({
  isPostgresConfigured: () => true,
}));
jest.mock('../cycle-finalized-cron', () => ({
  // The pure helpers run for real; only the Postgres-backed ones are stubbed.
  ...jest.requireActual('../cycle-finalized-cron'),
  acquireCycleFinalizedLease: jest.fn(),
  releaseCycleFinalizedLease: jest.fn(async () => undefined),
  loadCycleFinalizedCursor: jest.fn(async () => null),
  saveCycleFinalizedCursor: jest.fn(async () => undefined),
  drainCycleFinalizedEvents: jest.fn(),
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
const mockQueryEvents = jest.fn();
const mockGetObject = jest.fn();
jest.mock('../../services/sui-rpc-failover', () => ({
  getPooledSuiClient: jest.fn(() => ({
    queryEvents: mockQueryEvents,
    getObject: mockGetObject,
  })),
}));

import type { NextApiRequest, NextApiResponse } from 'next';
import handler from '../../pages/api/cron/cycle-finalized';
import {
  acquireCycleFinalizedLease,
  releaseCycleFinalizedLease,
  drainCycleFinalizedEvents,
  loadCycleFinalizedCursor,
  saveCycleFinalizedCursor,
} from '../cycle-finalized-cron';
import { sendYourTurnNotification } from '../your-turn-notification';

const actualDrain = (
  jest.requireActual('../cycle-finalized-cron') as typeof import('../cycle-finalized-cron')
).drainCycleFinalizedEvents;

const acquireMock = acquireCycleFinalizedLease as jest.Mock;
const releaseMock = releaseCycleFinalizedLease as jest.Mock;
const drainMock = drainCycleFinalizedEvents as jest.Mock;
const loadCursorMock = loadCycleFinalizedCursor as jest.Mock;
const saveCursorMock = saveCycleFinalizedCursor as jest.Mock;
const sendMock = sendYourTurnNotification as jest.Mock;

const SECRET = 'test-cron-secret';
const CURSOR_KEY = 'your-turn:contribution_recorded:0xoriginal:testnet';
const ORIGINAL_ENV = {
  CRON_SECRET: process.env.CRON_SECRET,
  PACKAGE_ID: process.env.PACKAGE_ID,
  CYCLE_FINALIZED_MAX_EVENT_AGE_MS: process.env.CYCLE_FINALIZED_MAX_EVENT_AGE_MS,
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
  delete process.env.CYCLE_FINALIZED_MAX_EVENT_AGE_MS;
  acquireMock.mockReset();
  releaseMock.mockReset().mockResolvedValue(undefined);
  drainMock.mockReset();
  loadCursorMock.mockReset().mockResolvedValue(null);
  saveCursorMock.mockReset().mockResolvedValue(undefined);
  sendMock.mockReset();
  // No stubbed pages: the probe's read fails, which runs the full pass.
  mockQueryEvents.mockReset();
  mockGetObject.mockReset();
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
    expect(acquireMock).toHaveBeenCalledWith(CURSOR_KEY);
    expect(drainMock).toHaveBeenCalledTimes(1);
    expect(releaseMock).toHaveBeenCalledWith(CURSOR_KEY, 'token-1');
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
    expect(releaseMock).toHaveBeenCalledWith(CURSOR_KEY, 'token-2');
  });

  it('releases the lease on a halted drain (500, cursor not advanced)', async () => {
    acquireMock.mockResolvedValue('token-3');
    drainMock.mockResolvedValue({ ...emptyDrainResult(), halted: true });
    const res = makeRes();

    await handler(makeReq(), res as unknown as NextApiResponse);

    expect(res.statusCode).toBe(500);
    expect(res.body).toMatchObject({ error: 'drain halted' });
    expect(releaseMock).toHaveBeenCalledWith(CURSOR_KEY, 'token-3');
  });

  it('rejects bad bearer tokens before touching the lease', async () => {
    const res = makeRes();

    await handler(makeReq('Bearer wrong-secret'), res as unknown as NextApiResponse);

    expect(res.statusCode).toBe(401);
    expect(acquireMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The trigger, end to end through the real drain
// ---------------------------------------------------------------------------

const PACKAGE = '0x89cddf4dfe654e7c7b16333096d9e750cf04bb96f7de934403a512d460594f02';
const USDC = '0x26b3bc67befc214058ca78ea9a2690298d731a2d4309485ec3d40198063c4abc::usdc::USDC';
const ESCROW = '0xe30c91fee48d74587d6dc549b301f8c7424031116e7c8d8cefaf410c3894fbe0';
const CIRCLE = '0xa3fada18d0d030f0f26e9a7ea77cd4f260a13649426a97bc9063c6f47de675ed';
const RECIPIENT = '0x1f8d4bdfa384503b0901c73c9925c5b29dad510766542a30dc3b6904ddba897b';
const PAYER_1 = '0xe833deaa9c038ac2edd397323ed5dbde1e622aadfd0d526332a214a31f9de17d';
const PAYER_2 = '0xdf98684462fb5b3e85dffcc34fda108b7c34e7da37ab88f0ae3a530ef804a97d';
const CONTRIBUTION_RECORDED = '0xoriginal::njangi_cycle_escrow::ContributionRecorded';

interface EscrowState {
  coinType?: string;
  claimed?: boolean;
  finalized?: boolean;
  refunded?: boolean;
}

function escrowObject(state: EscrowState = {}) {
  const type = `${PACKAGE}::njangi_cycle_escrow::CycleEscrow<${state.coinType ?? USDC}>`;
  return {
    data: {
      objectId: ESCROW,
      type,
      content: {
        dataType: 'moveObject',
        type,
        fields: {
          circle_id: CIRCLE,
          claimed: state.claimed ?? false,
          finalized: state.finalized ?? false,
          refunded: state.refunded ?? false,
          snapshot: {
            type: `${PACKAGE}::njangi_cycle_escrow::CycleSnapshot`,
            fields: {
              cycle_no: '5',
              members: [PAYER_1, PAYER_2, RECIPIENT],
              recipient: RECIPIENT,
              required_contributors: '2',
            },
          },
        },
      },
    },
  };
}

/** One ContributionRecorded as queryEvents returns it, `ageMs` old. */
function contribution(seq: number, contributorsSoFar: number, ageMs = 5 * 60_000) {
  return {
    id: { txDigest: `digest-${seq}`, eventSeq: '0' },
    parsedJson: {
      amount: '100000',
      contributor: contributorsSoFar === 1 ? PAYER_1 : PAYER_2,
      contributors_so_far: String(contributorsSoFar),
      cycle_no: '5',
      escrow_id: ESCROW,
      total_contributed: String(contributorsSoFar * 100000),
    },
    timestampMs: String(Date.now() - ageMs),
  };
}

/**
 * Serves the probe (descending, limit 1: a recent event, so the full pass
 * runs) and the drain (ascending: these events, one page).
 */
function serveEvents(events: Array<ReturnType<typeof contribution>>) {
  mockQueryEvents.mockImplementation(async (params: { order?: string }) => {
    if (params.order === 'descending') {
      return { data: [{ timestampMs: String(Date.now()) }], nextCursor: null, hasNextPage: false };
    }
    const last = events[events.length - 1];
    return { data: events, nextCursor: last ? last.id : null, hasNextPage: false };
  });
}

async function runCron(): Promise<FakeRes> {
  const res = makeRes();
  await handler(makeReq(), res as unknown as NextApiResponse);
  return res;
}

describe('your-turn trigger (ContributionRecorded)', () => {
  beforeEach(() => {
    acquireMock.mockResolvedValue('token');
    drainMock.mockImplementation(actualDrain);
    sendMock.mockResolvedValue({ sent: true });
  });

  it("nudges the recipient once, for the contribution that fills the pot, in the escrow's coin", async () => {
    serveEvents([contribution(1, 1), contribution(2, 2)]);
    mockGetObject.mockResolvedValue(escrowObject());

    const res = await runCron();

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ eventType: CONTRIBUTION_RECORDED, sent: 1, skipped: 1 });
    expect(mockQueryEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        query: { MoveEventType: CONTRIBUTION_RECORDED },
        order: 'ascending',
      }),
    );
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith({
      circleId: CIRCLE,
      cycleNo: 5,
      // Lap 5, recipient in the third seat of three: round 15, not "5".
      roundNo: 15,
      amount: '0.2 USDC',
      recipient: RECIPIENT,
      network: 'testnet',
      // The key the CycleFinalized trigger used: no second nudge on deploy.
      dedupeKey: `${ESCROW}:5`,
    });
    // One read per escrow per run, with the type that names the coin.
    expect(mockGetObject).toHaveBeenCalledTimes(1);
    expect(mockGetObject).toHaveBeenCalledWith({
      id: ESCROW,
      options: { showType: true, showContent: true },
    });
    expect(saveCursorMock).toHaveBeenCalledWith(CURSOR_KEY, contribution(2, 2).id, 'token');
  });

  it('sends nothing once the recipient has collected the pot', async () => {
    // The live 2026-09-07 round: collected 65s after the pot filled, so
    // the next tick reads a claimed escrow.
    serveEvents([contribution(2, 2)]);
    mockGetObject.mockResolvedValue(escrowObject({ finalized: true, claimed: true }));

    const res = await runCron();

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ sent: 0, skipped: 1, halted: false });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('sends nothing for a refunded round', async () => {
    serveEvents([contribution(2, 2)]);
    mockGetObject.mockResolvedValue(escrowObject({ refunded: true }));

    await runCron();

    expect(sendMock).not.toHaveBeenCalled();
  });

  it('still nudges a round finalized to the recipient but not collected', async () => {
    serveEvents([contribution(2, 2)]);
    mockGetObject.mockResolvedValue(escrowObject({ finalized: true }));

    await runCron();

    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('states a SUI pot in SUI', async () => {
    serveEvents([
      {
        ...contribution(2, 2),
        parsedJson: { ...contribution(2, 2).parsedJson, total_contributed: '3000000000' },
      },
    ]);
    mockGetObject.mockResolvedValue(escrowObject({ coinType: '0x2::sui::SUI' }));

    await runCron();

    expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({ amount: '3 SUI' }));
  });

  it('leaves the figure out for a coin whose decimals are unknown', async () => {
    serveEvents([contribution(2, 2)]);
    mockGetObject.mockResolvedValue(escrowObject({ coinType: '0xabc::fake::FAKE' }));

    await runCron();

    expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({ amount: null }));
  });

  it('halts without advancing when the escrow cannot be read', async () => {
    serveEvents([contribution(2, 2)]);
    mockGetObject.mockRejectedValue(new Error('429 Too Many Requests'));

    const res = await runCron();

    expect(res.statusCode).toBe(500);
    expect(res.body).toMatchObject({ error: 'drain halted', halted: true });
    expect(saveCursorMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
    expect(releaseMock).toHaveBeenCalledWith(CURSOR_KEY, 'token');
  });

  it('skips and advances past an event whose escrow does not exist', async () => {
    serveEvents([contribution(2, 2)]);
    mockGetObject.mockResolvedValue({ error: { code: 'notExists', object_id: ESCROW } });

    const res = await runCron();

    expect(res.statusCode).toBe(200);
    expect(sendMock).not.toHaveBeenCalled();
    expect(saveCursorMock).toHaveBeenCalledWith(CURSOR_KEY, contribution(2, 2).id, 'token');
  });

  it('skips events older than the age cap without reading the escrow', async () => {
    serveEvents([contribution(2, 2, 2 * 24 * 60 * 60_000)]);

    const res = await runCron();

    expect(res.statusCode).toBe(200);
    expect(mockGetObject).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('keeps the 24h age cap when CYCLE_FINALIZED_MAX_EVENT_AGE_MS is malformed', async () => {
    // `age > NaN` is false for every event: an unguarded parse would treat
    // the new cursor's whole history as fresh.
    process.env.CYCLE_FINALIZED_MAX_EVENT_AGE_MS = 'one day';
    serveEvents([contribution(2, 2, 2 * 24 * 60 * 60_000)]);

    await runCron();

    expect(mockGetObject).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });
});
