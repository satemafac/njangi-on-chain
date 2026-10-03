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
// The Sui-first probe is mocked to "always run" for the drain-behavior
// tests below — they exercise lease/cursor/dispatch semantics, which the
// probe would otherwise short-circuit for streams with no recent events.
// The probe-skip contract has its own test at the bottom of this file.
jest.mock('../cron-event-probe', () => ({
  isForcedFullPassTick: jest.fn(() => false),
  probeForRecentEvents: jest.fn(async () => ({
    runFullPass: true,
    reason: 'recent_event',
    newestEventMs: null,
  })),
}));
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
  loadCycleFinalizedCursor,
  releaseCycleFinalizedLease,
  saveCycleFinalizedCursor,
} from '../cycle-finalized-cron';
import { sendMemberNotification } from '../whatsapp-notifier';
import { resolveCirclePhone } from '../whatsapp-bot/circle-phone';
import { getPooledSuiClient } from '../../services/sui-rpc-failover';
import { CIRCLE_EVENT_STREAMS } from '../whatsapp-bot/circle-events';

const acquireMock = acquireCycleFinalizedLease as jest.Mock;
const releaseMock = releaseCycleFinalizedLease as jest.Mock;
const loadCursorMock = loadCycleFinalizedCursor as jest.Mock;
const saveCursorMock = saveCycleFinalizedCursor as jest.Mock;
const sendMock = sendMemberNotification as jest.Mock;
const phoneMock = resolveCirclePhone as jest.Mock;
const clientMock = getPooledSuiClient as jest.Mock;

const SECRET = 'test-cron-secret';
const CIRCLE = '0x' + 'c1'.repeat(32);
const MEMBER = '0x' + 'ab'.repeat(32);
const RECIPIENT = '0x' + '1f'.repeat(32);
const ESCROW = '0x' + 'e3'.repeat(32);
const USDC = '0x' + '26'.repeat(32) + '::usdc::USDC';
const CONTRIBUTION_TYPE = '0xcore::njangi_cycle_escrow::ContributionRecorded';
const CLAIM_TYPE = '0xcore::njangi_cycle_escrow::ClaimRedeemed';
const HOUR_MS = 60 * 60 * 1000;

const ORIGINAL_CRON_SECRET = process.env.CRON_SECRET;
const ORIGINAL_MAX_AGE = process.env.WHATSAPP_EVENTS_MAX_EVENT_AGE_MS;

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

/**
 * getObject response for the round's CycleEscrow<USDC>, in the shape
 * testnet returns: the escrow names its circle; the round target sits in
 * the frozen snapshot.
 */
const ESCROW_OBJECT = {
  data: {
    objectId: ESCROW,
    type: `0xcore::njangi_cycle_escrow::CycleEscrow<${USDC}>`,
    content: {
      dataType: 'moveObject',
      type: `0xcore::njangi_cycle_escrow::CycleEscrow<${USDC}>`,
      fields: {
        circle_id: CIRCLE,
        snapshot: {
          type: '0xcore::njangi_cycle_escrow::CycleSnapshot',
          fields: { cycle_no: '5', recipient: RECIPIENT, required_contributors: '2' },
        },
      },
    },
  },
};

function contributionEvent(txDigest: string, ageMs = 0, contributor = MEMBER) {
  return {
    id: { txDigest, eventSeq: '0' },
    parsedJson: {
      escrow_id: ESCROW,
      cycle_no: '5',
      contributor,
      amount: '100000',
      contributors_so_far: '1',
      total_contributed: '100000',
    },
    timestampMs: String(Date.now() - ageMs),
  };
}

function page(...data: FakeEventPage['data']): FakeEventPage {
  const last = data[data.length - 1];
  return { data, nextCursor: last ? last.id : null, hasNextPage: false };
}

const EMPTY_PAGE: FakeEventPage = { data: [], nextCursor: null, hasNextPage: false };

/** Sui client stub: one fresh ContributionRecorded event, all other streams empty. */
function makeClient() {
  return {
    getObject: jest.fn(async ({ id }: { id: string }) => {
      if (id === '0xregistry') {
        return { data: { type: '0xwa::whatsapp_integration::WhatsAppRegistry' } };
      }
      if (id === ESCROW) return ESCROW_OBJECT;
      return { error: { code: 'notExists', object_id: id } };
    }),
    queryEvents: jest.fn(
      async ({ query }: { query: { MoveEventType: string } }): Promise<FakeEventPage> =>
        query.MoveEventType === CONTRIBUTION_TYPE ? page(contributionEvent('tx1')) : EMPTY_PAGE,
    ),
    getTransactionBlock: jest.fn(),
  };
}

/** Escrow reads the client served (the registry type probe excluded). */
function escrowReads(client: ReturnType<typeof makeClient>): number {
  return client.getObject.mock.calls.filter(([arg]) => arg.id === ESCROW).length;
}

beforeEach(() => {
  process.env.CRON_SECRET = SECRET;
  delete process.env.WHATSAPP_EVENTS_MAX_EVENT_AGE_MS;
  acquireMock.mockReset().mockResolvedValue('lease-token');
  releaseMock.mockReset().mockResolvedValue(undefined);
  loadCursorMock.mockReset().mockResolvedValue(null);
  saveCursorMock.mockReset().mockResolvedValue(undefined);
  sendMock.mockReset().mockResolvedValue({ sent: true, phoneE164: '+237650000001' });
  phoneMock.mockReset().mockResolvedValue('+237650000001');
  clientMock.mockReset().mockReturnValue(makeClient());
});

afterAll(() => {
  if (ORIGINAL_CRON_SECRET === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = ORIGINAL_CRON_SECRET;
  if (ORIGINAL_MAX_AGE === undefined) delete process.env.WHATSAPP_EVENTS_MAX_EVENT_AGE_MS;
  else process.env.WHATSAPP_EVENTS_MAX_EVENT_AGE_MS = ORIGINAL_MAX_AGE;
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
  it('drains an escrow contribution into a send for the escrow circle', async () => {
    const res = await run();
    expect(res.statusCode).toBe(200);

    expect(sendMock).toHaveBeenCalledTimes(1);
    const call = sendMock.mock.calls[0][0];
    expect(call.kind).toBe('circle_event');
    // The event names only its escrow; the circle comes from the escrow read.
    expect(call.memberAddress).toBe(CIRCLE);
    expect(phoneMock).toHaveBeenCalledWith(expect.anything(), CIRCLE, 'testnet');
    expect(call.phoneOverride).toBe('+237650000001');
    expect(call.network).toBe('testnet');
    expect(call.dedupeKey).toBe('contribution_recorded:tx1:0');
    // Enriched body: circle name + member display name + USDC amount
    // (6 decimals, from the escrow's type) + round progress.
    expect(call.body).toBe(
      'Contribution received in Bamenda Savers.\n' +
        `Round 5: Aminata (0xabab...abab) paid 0.10 USDC. ` +
        '1 of 2 members have paid in for this round.\n' +
        `View progress: https://njangionchain.com/circle/${CIRCLE}`,
    );
    // recieve_contribution is not on the approved reuse list, so the
    // contribution stays on the freeform fallback.
    expect(call.template).toBeUndefined();

    const body = res.body as { sent: number; halted: boolean; streams: unknown[] };
    expect(body.sent).toBe(1);
    expect(body.halted).toBe(false);
    expect(body.streams).toHaveLength(CIRCLE_EVENT_STREAMS.length);

    // One lease per stream, all released.
    expect(acquireMock).toHaveBeenCalledTimes(CIRCLE_EVENT_STREAMS.length);
    expect(releaseMock).toHaveBeenCalledTimes(CIRCLE_EVENT_STREAMS.length);
  });

  it('never queries the retired legacy rail, and pages the escrow events on their own cursor rows', async () => {
    const client = makeClient();
    clientMock.mockReturnValue(client);
    await run();

    const queried = client.queryEvents.mock.calls.map(([arg]) => arg.query.MoveEventType);
    expect(queried).toEqual(expect.arrayContaining([CONTRIBUTION_TYPE, CLAIM_TYPE]));
    expect(
      queried.filter((type) =>
        /::(ContributionMade|StablecoinContributionMade|PayoutProcessed)$/.test(type),
      ),
    ).toEqual([]);

    const cursorKeys = loadCursorMock.mock.calls.map(([key]) => key);
    expect(cursorKeys).toEqual(
      expect.arrayContaining([
        'whatsapp-events:contribution_recorded:0xcore:testnet',
        'whatsapp-events:claim_redeemed:0xcore:testnet',
      ]),
    );
    for (const retired of ['contribution', 'contribution_stablecoin', 'payout_processed']) {
      expect(cursorKeys).not.toContain(`whatsapp-events:${retired}:0xcore:testnet`);
    }
    // The page's cursor is saved on the new stream's own row.
    expect(saveCursorMock).toHaveBeenCalledWith(
      'whatsapp-events:contribution_recorded:0xcore:testnet',
      { txDigest: 'tx1', eventSeq: '0' },
      'lease-token',
    );
  });

  it('relays a payout collection with the payout_processed template', async () => {
    const client = makeClient();
    client.queryEvents.mockImplementation(async ({ query }) =>
      query.MoveEventType === CLAIM_TYPE
        ? page({
            id: { txDigest: 'tx-claim', eventSeq: '1' },
            parsedJson: {
              escrow_id: ESCROW,
              cycle_no: '5',
              recipient: RECIPIENT,
              amount: '200000',
            },
            timestampMs: String(Date.now()),
          })
        : EMPTY_PAGE,
    );
    clientMock.mockReturnValue(client);

    const res = await run();
    expect(res.statusCode).toBe(200);
    expect(sendMock).toHaveBeenCalledTimes(1);
    const call = sendMock.mock.calls[0][0];
    expect(call.memberAddress).toBe(CIRCLE);
    expect(call.dedupeKey).toBe('claim_redeemed:tx-claim:1');
    expect(call.body).toContain('Payout collected in Bamenda Savers.');
    expect(call.body).toContain('Round 5: Aminata (0x1f1f...1f1f) received 0.20 USDC.');
    expect(call.template.name).toBe('payout_processed');
    expect(call.template.components[0].parameters.map((p: { text: string }) => p.text)).toEqual([
      'Bamenda Savers',
      '5',
      'Aminata',
      '0.20 USDC',
      expect.any(String),
    ]);
  });

  it('reads each escrow once per run', async () => {
    const client = makeClient();
    client.queryEvents.mockImplementation(async ({ query }) => {
      if (query.MoveEventType === CONTRIBUTION_TYPE) {
        return page(contributionEvent('tx-a'), contributionEvent('tx-b', 0, '0x' + 'df'.repeat(32)));
      }
      if (query.MoveEventType === CLAIM_TYPE) {
        return page({
          id: { txDigest: 'tx-claim', eventSeq: '1' },
          parsedJson: { escrow_id: ESCROW, cycle_no: '5', recipient: RECIPIENT, amount: '200000' },
          timestampMs: String(Date.now()),
        });
      }
      return EMPTY_PAGE;
    });
    clientMock.mockReturnValue(client);

    const res = await run();
    expect((res.body as { sent: number }).sent).toBe(3);
    // Two contributions and the payout of one round: a single object read.
    expect(escrowReads(client)).toBe(1);
  });

  it('halts without advancing when the escrow read fails', async () => {
    const client = makeClient();
    const registryAndMissing = client.getObject.getMockImplementation()!;
    client.getObject.mockImplementation(async (arg: { id: string }) => {
      if (arg.id === ESCROW) throw new Error('fetch failed');
      return registryAndMissing(arg);
    });
    clientMock.mockReturnValue(client);

    const res = await run();
    expect(res.statusCode).toBe(500);
    expect((res.body as { halted: boolean }).halted).toBe(true);
    expect(sendMock).not.toHaveBeenCalled();
    // An unreadable escrow is not a missing one: the cursor stays put so
    // the next run retries this event.
    expect(saveCursorMock).not.toHaveBeenCalled();
    const summary = (res.body as { streams: Array<{ stream: string; halted: boolean }> }).streams;
    expect(summary.find((s) => s.stream === 'contribution_recorded')?.halted).toBe(true);
  });

  it('skips (and advances past) an event whose escrow does not exist', async () => {
    const client = makeClient();
    client.getObject.mockImplementation(async ({ id }: { id: string }) =>
      id === '0xregistry'
        ? { data: { type: '0xwa::whatsapp_integration::WhatsAppRegistry' } }
        : { error: { code: 'notExists', object_id: id } },
    );
    clientMock.mockReturnValue(client);

    const res = await run();
    expect(res.statusCode).toBe(200);
    expect(sendMock).not.toHaveBeenCalled();
    expect((res.body as { skipped: number }).skipped).toBe(1);
    expect(saveCursorMock).toHaveBeenCalledTimes(1);
  });

  it('age-skips a first pass over old escrow history without reading any escrow', async () => {
    // A fresh cursor drains the stream from genesis: weeks of past rounds
    // must advance silently, and cost no object reads doing it.
    const client = makeClient();
    client.queryEvents.mockImplementation(async ({ query }) =>
      query.MoveEventType === CONTRIBUTION_TYPE
        ? page(
            contributionEvent('tx-june', 90 * 24 * HOUR_MS),
            contributionEvent('tx-sept', 20 * 24 * HOUR_MS),
          )
        : EMPTY_PAGE,
    );
    clientMock.mockReturnValue(client);

    const res = await run();
    expect(res.statusCode).toBe(200);
    expect(sendMock).not.toHaveBeenCalled();
    expect((res.body as { skipped: number }).skipped).toBe(2);
    expect(escrowReads(client)).toBe(0);
    expect(saveCursorMock).toHaveBeenCalledWith(
      'whatsapp-events:contribution_recorded:0xcore:testnet',
      { txDigest: 'tx-sept', eventSeq: '0' },
      'lease-token',
    );
  });

  it('honors WHATSAPP_EVENTS_MAX_EVENT_AGE_MS', async () => {
    process.env.WHATSAPP_EVENTS_MAX_EVENT_AGE_MS = String(HOUR_MS);
    const client = makeClient();
    client.queryEvents.mockImplementation(async ({ query }) =>
      query.MoveEventType === CONTRIBUTION_TYPE
        ? page(contributionEvent('tx-old', 2 * HOUR_MS), contributionEvent('tx-new', 60_000))
        : EMPTY_PAGE,
    );
    clientMock.mockReturnValue(client);

    const res = await run();
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][0].dedupeKey).toBe('contribution_recorded:tx-new:0');
    expect((res.body as { skipped: number }).skipped).toBe(1);
  });

  it('keeps the replay guard when WHATSAPP_EVENTS_MAX_EVENT_AGE_MS is malformed', async () => {
    // Number('24h') is NaN and `age > NaN` is false: without the fallback a
    // typo would mark every event fresh and replay a stream's history.
    process.env.WHATSAPP_EVENTS_MAX_EVENT_AGE_MS = '24h';
    const client = makeClient();
    client.queryEvents.mockImplementation(async ({ query }) =>
      query.MoveEventType === CONTRIBUTION_TYPE
        ? page(contributionEvent('tx-old', 48 * HOUR_MS))
        : EMPTY_PAGE,
    );
    clientMock.mockReturnValue(client);

    const res = await run();
    expect(res.statusCode).toBe(200);
    expect(sendMock).not.toHaveBeenCalled();
    expect((res.body as { skipped: number }).skipped).toBe(1);
  });

  it('forwards the approved template alongside the body for template-backed streams', async () => {
    const MEMBER_JOINED_TYPE = '0xcore::njangi_circles::MemberJoined';
    const client = makeClient();
    client.queryEvents.mockImplementation(async ({ query }) => {
      if (query.MoveEventType === MEMBER_JOINED_TYPE) {
        return {
          data: [
            {
              id: { txDigest: 'tx-join', eventSeq: '0' },
              parsedJson: { circle_id: CIRCLE, member: MEMBER },
              timestampMs: String(Date.now()),
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
    expect(sendMock).toHaveBeenCalledTimes(1);
    const call = sendMock.mock.calls[0][0];
    // The dispatcher gets BOTH: the template (used when templates are on) and
    // the freeform body (the fallback). This is the wiring the cron was missing.
    expect(call.template).toBeDefined();
    expect(call.template.name).toBe('member_joins');
    expect(call.template.language).toBe('en_US');
    expect(call.body).toContain('just joined');
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
    client.queryEvents.mockImplementation(async ({ query }) =>
      query.MoveEventType === CONTRIBUTION_TYPE
        ? page(contributionEvent('tx-old', 48 * HOUR_MS))
        : EMPTY_PAGE,
    );
    clientMock.mockReturnValue(client);

    const res = await run();
    expect(res.statusCode).toBe(200);
    expect(sendMock).not.toHaveBeenCalled();
    expect((res.body as { skipped: number }).skipped).toBe(1);
    expect(saveCursorMock).toHaveBeenCalledTimes(1);
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

  it('never touches the lease/cursor when the Sui-first probe reports a quiet stream', async () => {
    // The Neon-burn guard: quiet ticks must be DB-free so the database can
    // autosuspend (see src/lib/cron-event-probe.ts).
    const { probeForRecentEvents } = jest.requireMock('../cron-event-probe');
    // ...Once so the suite's default always-run probe is restored for any
    // test that might execute after this one.
    for (let i = 0; i < CIRCLE_EVENT_STREAMS.length; i += 1) {
      (probeForRecentEvents as jest.Mock).mockResolvedValueOnce({
        runFullPass: false,
        reason: 'no_recent_events',
        newestEventMs: null,
      });
    }
    const res = await run();
    expect(res.statusCode).toBe(200);
    expect(acquireMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
    const streams = (res.body as { streams: Array<{ skippedReason?: string }> }).streams;
    expect(streams.length).toBeGreaterThan(0);
    expect(streams.every((s) => s.skippedReason === 'no_recent_events')).toBe(true);
  });
});
