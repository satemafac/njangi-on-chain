/**
 * Handler-level smoke tests for GET /api/cron/whatsapp-circle-events —
 * the fold-in of the retired whatsapp-bot-backend listener. Exercises the
 * REAL drain loop (only the Postgres cursor/lease persistence and the
 * outbound send are mocked) to prove the ported dispatch end-to-end:
 * on-chain event page → stream parser → phone resolution → notifier call
 * with the circle-event kind + per-event dedupe key → outcome mapping.
 *
 * Lives in lib/__tests__ (not next to the route): files under src/pages
 * are compiled as routes by Next, so test files must stay out.
 */

jest.mock('../pg-pool', () => ({
  isPostgresConfigured: () => true,
}));
jest.mock('../cycle-finalized-cron', () => {
  const actual = jest.requireActual('../cycle-finalized-cron');
  return {
    ...actual,
    acquireCycleFinalizedLease: jest.fn(async () => 'lease-token'),
    releaseCycleFinalizedLease: jest.fn(async () => undefined),
    loadCycleFinalizedCursor: jest.fn(async () => null),
    saveCycleFinalizedCursor: jest.fn(async () => undefined),
  };
});
jest.mock('../whatsapp-notifier', () => ({
  sendMemberNotification: jest.fn(),
}));
jest.mock('../whatsapp-bot/circle-phone', () => ({
  resolveCirclePhone: jest.fn(),
  resolveCircleName: jest.fn(async () => 'Bamenda Savers'),
}));
jest.mock('../circle-chain', () => ({
  getPublishedPackageMetadata: jest.fn(() => ({ originalId: '0xcore' })),
}));
jest.mock('../../services/network-config', () => ({
  getCurrentNetwork: jest.fn(() => 'testnet'),
  getNetworkConfig: jest.fn(() => ({ rpcUrl: 'http://localhost:9000' })),
  getWhatsAppConfigForNetwork: jest.fn(() => ({ packageId: '0xwa' })),
}));
jest.mock('../../services/whatsapp-registry-service', () => ({
  getActiveWhatsAppRegistries: jest.fn(() => [{ registryObjectId: '0xregistry' }]),
}));
jest.mock('../../services/sui-rpc-failover', () => ({
  getPooledSuiClient: jest.fn(),
}));
jest.mock('../../services/join-request-database', () => ({
  __esModule: true,
  default: { getUserByAddress: jest.fn(async () => ({ user_name: 'Aminata' })) },
}));

import type { NextApiRequest, NextApiResponse } from 'next';
import handler from '../../pages/api/cron/whatsapp-circle-events';
import {
  acquireCycleFinalizedLease,
  releaseCycleFinalizedLease,
} from '../cycle-finalized-cron';
import { sendMemberNotification } from '../whatsapp-notifier';
import { resolveCirclePhone } from '../whatsapp-bot/circle-phone';
import { getPooledSuiClient } from '../../services/sui-rpc-failover';
import { CIRCLE_EVENT_STREAMS } from '../whatsapp-bot/circle-events';

const acquireMock = acquireCycleFinalizedLease as jest.Mock;
const releaseMock = releaseCycleFinalizedLease as jest.Mock;
const sendMock = sendMemberNotification as jest.Mock;
const phoneMock = resolveCirclePhone as jest.Mock;
const clientMock = getPooledSuiClient as jest.Mock;

const SECRET = 'test-cron-secret';
const CIRCLE = '0x' + 'c1'.repeat(32);
const MEMBER = '0x' + 'ab'.repeat(32);
const CONTRIBUTION_TYPE = '0xcore::njangi_payments::ContributionMade';

const ORIGINAL_CRON_SECRET = process.env.CRON_SECRET;

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

interface FakeEventPage {
  data: Array<{
    id: { txDigest: string; eventSeq: string };
    parsedJson: unknown;
    timestampMs: string | null;
  }>;
  nextCursor: { txDigest: string; eventSeq: string } | null;
  hasNextPage: boolean;
}

/** Sui client stub: one fresh ContributionMade event, all other streams empty. */
function makeClient() {
  return {
    getObject: jest.fn(async ({ id }: { id: string }) =>
      id === '0xregistry'
        ? { data: { type: '0xwa::whatsapp_integration::WhatsAppRegistry' } }
        : { data: undefined },
    ),
    queryEvents: jest.fn(
      async ({ query }: { query: { MoveEventType: string } }): Promise<FakeEventPage> => {
        if (query.MoveEventType === CONTRIBUTION_TYPE) {
          return {
            data: [
              {
                id: { txDigest: 'tx1', eventSeq: '0' },
                parsedJson: {
                  circle_id: CIRCLE,
                  member: MEMBER,
                  amount: '1500000000',
                  cycle: '2',
                },
                timestampMs: String(Date.now()),
              },
            ],
            nextCursor: { txDigest: 'tx1', eventSeq: '0' },
            hasNextPage: false,
          };
        }
        return { data: [], nextCursor: null, hasNextPage: false };
      },
    ),
    getTransactionBlock: jest.fn(),
  };
}

beforeEach(() => {
  process.env.CRON_SECRET = SECRET;
  acquireMock.mockReset().mockResolvedValue('lease-token');
  releaseMock.mockReset().mockResolvedValue(undefined);
  sendMock.mockReset().mockResolvedValue({ sent: true, phoneE164: '+237650000001' });
  phoneMock.mockReset().mockResolvedValue('+237650000001');
  clientMock.mockReset().mockReturnValue(makeClient());
});

afterAll(() => {
  if (ORIGINAL_CRON_SECRET === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = ORIGINAL_CRON_SECRET;
});

async function run(req: NextApiRequest = makeReq()) {
  const res = makeRes();
  await handler(req, res as unknown as NextApiResponse);
  return res;
}

describe('auth and preconditions', () => {
  it('rejects a missing or wrong bearer token', async () => {
    expect((await run(makeReq('Bearer nope'))).statusCode).toBe(401);
    expect(
      (await run({ method: 'GET', headers: {} } as unknown as NextApiRequest)).statusCode,
    ).toBe(401);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('fails closed without CRON_SECRET', async () => {
    delete process.env.CRON_SECRET;
    expect((await run()).statusCode).toBe(500);
  });

  it('rejects non-GET methods', async () => {
    const res = await run({ method: 'POST', headers: {} } as unknown as NextApiRequest);
    expect(res.statusCode).toBe(405);
  });
});

describe('ported event dispatch (smoke)', () => {
  it('drains the contribution event into a circle-event WhatsApp send', async () => {
    const res = await run();
    expect(res.statusCode).toBe(200);

    expect(sendMock).toHaveBeenCalledTimes(1);
    const call = sendMock.mock.calls[0][0];
    expect(call.kind).toBe('circle_event');
    expect(call.memberAddress).toBe(CIRCLE);
    expect(call.phoneOverride).toBe('+237650000001');
    expect(call.network).toBe('testnet');
    expect(call.dedupeKey).toBe('contribution:tx1:0');
    // Enriched body: circle name + member display name + amount + cycle.
    expect(call.body).toContain('Bamenda Savers');
    expect(call.body).toContain('Aminata');
    expect(call.body).toContain('Cycle 2:');
    expect(call.body).toContain('paid 1.5000 SUI');

    const body = res.body as { sent: number; halted: boolean; streams: unknown[] };
    expect(body.sent).toBe(1);
    expect(body.halted).toBe(false);
    expect(body.streams).toHaveLength(CIRCLE_EVENT_STREAMS.length);

    // One lease per stream, all released.
    expect(acquireMock).toHaveBeenCalledTimes(CIRCLE_EVENT_STREAMS.length);
    expect(releaseMock).toHaveBeenCalledTimes(CIRCLE_EVENT_STREAMS.length);
  });

  it('skips unlinked circles without sending', async () => {
    phoneMock.mockResolvedValue(null);
    const res = await run();
    expect(res.statusCode).toBe(200);
    expect(sendMock).not.toHaveBeenCalled();
    expect((res.body as { skipped: number }).skipped).toBe(1);
  });

  it('skips stale events (cursor still advances) without sending', async () => {
    const client = makeClient();
    client.queryEvents.mockImplementation(async ({ query }) => {
      if (query.MoveEventType === CONTRIBUTION_TYPE) {
        return {
          data: [
            {
              id: { txDigest: 'tx-old', eventSeq: '0' },
              parsedJson: { circle_id: CIRCLE, member: MEMBER, amount: '1', cycle: 1 },
              timestampMs: String(Date.now() - 48 * 60 * 60 * 1000),
            },
          ],
          nextCursor: null,
          hasNextPage: false,
        };
      }
      return { data: [], nextCursor: null, hasNextPage: false };
    });
    clientMock.mockReturnValue(client);

    const res = await run();
    expect(res.statusCode).toBe(200);
    expect(sendMock).not.toHaveBeenCalled();
    expect((res.body as { skipped: number }).skipped).toBe(1);
  });

  it('halts the stream (500, no cursor advance past the event) on missing credentials', async () => {
    sendMock.mockResolvedValue({ sent: false, reason: 'missing_credentials' });
    const res = await run();
    expect(res.statusCode).toBe(500);
    expect((res.body as { halted: boolean }).halted).toBe(true);
  });

  it('records duplicates as skipped (crash-retry window)', async () => {
    sendMock.mockResolvedValue({ sent: false, reason: 'duplicate' });
    const res = await run();
    expect(res.statusCode).toBe(200);
    expect((res.body as { skipped: number; sent: number }).skipped).toBe(1);
    expect((res.body as { sent: number }).sent).toBe(0);
  });

  it('advances past per-recipient send failures', async () => {
    sendMock.mockResolvedValue({ sent: false, reason: 'send_failed' });
    const res = await run();
    expect(res.statusCode).toBe(200);
    expect((res.body as { failed: number }).failed).toBe(1);
  });

  it('skips every stream when another invocation holds the leases', async () => {
    acquireMock.mockResolvedValue(null);
    const res = await run();
    expect(res.statusCode).toBe(200);
    expect(sendMock).not.toHaveBeenCalled();
    const streams = (res.body as { streams: Array<{ skippedReason?: string }> }).streams;
    expect(streams.every((s) => s.skippedReason === 'already_running')).toBe(true);
    expect(releaseMock).not.toHaveBeenCalled();
  });

  it('halts (not advances) when phone resolution throws', async () => {
    phoneMock.mockRejectedValue(new Error('registry read failed'));
    const res = await run();
    expect(res.statusCode).toBe(500);
    expect((res.body as { halted: boolean }).halted).toBe(true);
    expect(sendMock).not.toHaveBeenCalled();
  });
});
