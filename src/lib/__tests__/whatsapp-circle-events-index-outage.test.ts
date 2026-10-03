/**
 * GET /api/cron/whatsapp-circle-events with the REAL resolveCirclePhone,
 * through a link-index outage after a Walrus renewal: the circle's
 * anchored blob has expired and its renewed blob id lives only in the
 * index. The lookup used to return null there, so the cron recorded the
 * event as skipped ("circle not linked"), advanced its cursor past it and
 * cached the null for the rest of the run. Now the lookup throws: the
 * stream halts on the event, a later event for the same circle looks the
 * phone up again, and the next run delivers the event once the index
 * answers.
 *
 * Only Postgres persistence, the Sui-first probe, the outbound send, the
 * index and Walrus are mocked; the drain loop and the phone lookup are
 * real. Lives in lib/__tests__ (not next to the route): files under
 * src/pages are compiled as routes by Next, so test files must stay out.
 */

jest.mock('../pg-pool', () => ({
  isPostgresConfigured: () => true,
}));
jest.mock('../cycle-finalized-cron', () => {
  const actual = jest.requireActual('../cycle-finalized-cron');
  return {
    ...actual,
    acquireCycleFinalizedLease: jest.fn(),
    releaseCycleFinalizedLease: jest.fn(),
    loadCycleFinalizedCursor: jest.fn(),
    saveCycleFinalizedCursor: jest.fn(),
  };
});
jest.mock('../cron-event-probe', () => ({
  isForcedFullPassTick: () => false,
  probeForRecentEvents: async () => ({
    runFullPass: true,
    reason: 'recent_event',
    newestEventMs: null,
  }),
}));
jest.mock('../whatsapp-notifier', () => ({
  sendMemberNotification: jest.fn(),
}));
jest.mock('../walrus-pii', () => ({
  fetchAndDecryptPII: jest.fn(),
}));
jest.mock('../whatsapp-link-index', () => ({
  lookupBlobsForCircle: jest.fn(),
}));
jest.mock('../circle-chain', () => ({
  getPublishedPackageMetadata: () => ({ originalId: '0xcore' }),
}));
jest.mock('../../services/network-config', () => ({
  getCurrentNetwork: () => 'testnet',
  getNetworkConfig: () => ({ rpcUrl: 'http://localhost:9000' }),
  getWhatsAppConfigForNetwork: () => ({ packageId: '0xwa' }),
}));
jest.mock('../../services/whatsapp-registry-service', () => ({
  getActiveWhatsAppRegistries: () => [{ packageId: '0xwa', registryObjectId: '0xregistry' }],
}));
jest.mock('../../services/sui-rpc-failover', () => ({
  getPooledSuiClient: jest.fn(),
}));
jest.mock('../../services/join-request-database', () => ({
  __esModule: true,
  default: { getUserByAddress: async () => ({ user_name: 'Aminata' }) },
}));
jest.mock('../../utils/logger', () => ({
  appLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import type { NextApiRequest, NextApiResponse } from 'next';
import handler from '../../pages/api/cron/whatsapp-circle-events';
import {
  acquireCycleFinalizedLease,
  loadCycleFinalizedCursor,
  releaseCycleFinalizedLease,
  saveCycleFinalizedCursor,
} from '../cycle-finalized-cron';
import { CIRCLE_EVENT_STREAMS, circleEventCursorKey } from '../whatsapp-bot/circle-events';
import { sendMemberNotification } from '../whatsapp-notifier';
import { fetchAndDecryptPII } from '../walrus-pii';
import { lookupBlobsForCircle } from '../whatsapp-link-index';
import { getPooledSuiClient } from '../../services/sui-rpc-failover';
import { appLogger } from '../../utils/logger';

const acquireMock = acquireCycleFinalizedLease as jest.Mock;
const releaseMock = releaseCycleFinalizedLease as jest.Mock;
const loadCursorMock = loadCycleFinalizedCursor as jest.Mock;
const saveCursorMock = saveCycleFinalizedCursor as jest.Mock;
const sendMock = sendMemberNotification as jest.Mock;
const decryptMock = fetchAndDecryptPII as jest.Mock;
const indexMock = lookupBlobsForCircle as jest.Mock;
const clientMock = getPooledSuiClient as jest.Mock;

const SECRET = 'test-cron-secret';
const CIRCLE = '0x' + 'c1'.repeat(32);
const MEMBER = '0x' + 'ab'.repeat(32);
const ADMIN = '0x' + 'a1'.repeat(32);
const ANCHORED_BLOB = 'anchored-blob-original-lease';
const RENEWED_BLOB = 'renewed-blob-from-renewal-cron';
const PHONE = '+237650000001';
const INDEX_DOWN = 'Connection terminated unexpectedly';

const ORIGINAL_CRON_SECRET = process.env.CRON_SECRET;

/** One fresh event per stream, each about CIRCLE. */
const EVENTS: Record<string, { txDigest: string; parsedJson: unknown }> = {
  member_joined: { txDigest: 'tx-join', parsedJson: { circle_id: CIRCLE, member: MEMBER } },
  circle_activated: { txDigest: 'tx-live', parsedJson: { circle_id: CIRCLE } },
};

interface StreamSummary {
  stream: string;
  processed: number;
  sent: number;
  skipped: number;
  halted: boolean;
}

interface FakeRes {
  statusCode: number;
  body: { halted?: boolean; streams?: StreamSummary[] };
  setHeader: jest.Mock;
  status: (code: number) => FakeRes;
  json: (payload: FakeRes['body']) => FakeRes;
}

function makeRes(): FakeRes {
  const res = { statusCode: 0, body: {}, setHeader: jest.fn() } as FakeRes;
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload) => {
    res.body = payload;
    return res;
  };
  return res;
}

async function run(): Promise<FakeRes> {
  const req = {
    method: 'GET',
    headers: { authorization: `Bearer ${SECRET}` },
  } as unknown as NextApiRequest;
  const res = makeRes();
  await handler(req, res as unknown as NextApiResponse);
  return res;
}

function summaryOf(res: FakeRes, stream: string): StreamSummary | undefined {
  return res.body.streams?.find((s) => s.stream === stream);
}

function eventTypeOf(streamName: string): string {
  const stream = CIRCLE_EVENT_STREAMS.find((s) => s.name === streamName);
  if (!stream) throw new Error(`stream ${streamName} not registered`);
  return stream.eventType('0xcore');
}

/**
 * Sui client stub. The registry anchors the circle's ORIGINAL blob id, as
 * it does once the renewal cron has moved the live copy; `streams` names
 * the streams whose EVENTS entry is on chain (every other page is empty).
 */
function makeClient(streams: string[]) {
  const pages = new Map(
    streams.map((name) => {
      const { txDigest, parsedJson } = EVENTS[name];
      const event = {
        id: { txDigest, eventSeq: '0' },
        parsedJson,
        timestampMs: String(Date.now()),
      };
      return [eventTypeOf(name), event] as const;
    }),
  );
  return {
    getObject: jest.fn(async ({ id }: { id: string }) => {
      if (id === '0xregistry') {
        return {
          data: {
            type: '0xwa::whatsapp_integration::WhatsAppRegistry',
            content: {
              dataType: 'moveObject',
              fields: {
                links: [
                  {
                    type: '0xwa::whatsapp_integration::WhatsAppLink',
                    fields: {
                      circle_id: CIRCLE,
                      link_type: 1,
                      walrus_blob_id: Array.from(Buffer.from(ANCHORED_BLOB, 'utf8')),
                      linked_by: ADMIN,
                      enabled: true,
                    },
                  },
                ],
              },
            },
          },
        };
      }
      if (id === CIRCLE) {
        return {
          data: { content: { dataType: 'moveObject', fields: { name: 'Bamenda Savers' } } },
        };
      }
      return { data: undefined };
    }),
    queryEvents: jest.fn(async ({ query }: { query: { MoveEventType: string } }) => {
      const event = pages.get(query.MoveEventType);
      return event
        ? { data: [event], nextCursor: event.id, hasNextPage: false }
        : { data: [], nextCursor: null, hasNextPage: false };
    }),
    getTransactionBlock: jest.fn(),
  };
}

beforeEach(() => {
  process.env.CRON_SECRET = SECRET;
  acquireMock.mockReset().mockResolvedValue('lease-token');
  releaseMock.mockReset().mockResolvedValue(undefined);
  loadCursorMock.mockReset().mockResolvedValue(null);
  saveCursorMock.mockReset().mockResolvedValue(undefined);
  sendMock.mockReset().mockResolvedValue({ sent: true, phoneE164: PHONE });
  indexMock.mockReset();
  // Walrus holds only the renewed copy; the anchored blob's lease lapsed.
  decryptMock.mockReset().mockImplementation(async (blobId: string) => {
    if (blobId !== RENEWED_BLOB) {
      throw new Error(`Walrus aggregator returned 404: ${blobId} not found`);
    }
    return {
      schema_version: 1,
      link_type: 'individual',
      phone_e164: PHONE,
      created_at: '2026-06-01T00:00:00.000Z',
    };
  });
});

afterAll(() => {
  if (ORIGINAL_CRON_SECRET === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = ORIGINAL_CRON_SECRET;
});

describe('circle events during a link-index outage', () => {
  it('halts on the event instead of skipping it, then delivers it once the index answers', async () => {
    clientMock.mockReturnValue(makeClient(['member_joined']));
    indexMock.mockRejectedValue(new Error(INDEX_DOWN));

    const outage = await run();

    expect(outage.statusCode).toBe(500);
    expect(outage.body.halted).toBe(true);
    expect(summaryOf(outage, 'member_joined')).toMatchObject({
      halted: true,
      processed: 0,
      skipped: 0,
    });
    expect(appLogger.error).toHaveBeenCalledWith(
      '[cycle-finalized-cron] notify threw; halting drain',
      expect.objectContaining({ txDigest: 'tx-join', error: INDEX_DOWN }),
    );
    expect(sendMock).not.toHaveBeenCalled();
    // No cursor moved, so the next run starts at the same event.
    expect(saveCursorMock).not.toHaveBeenCalled();

    indexMock.mockReset().mockResolvedValue([RENEWED_BLOB]);
    const recovered = await run();

    expect(recovered.statusCode).toBe(200);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][0]).toMatchObject({
      memberAddress: CIRCLE,
      phoneOverride: PHONE,
      kind: 'circle_event',
      dedupeKey: 'member_joined:tx-join:0',
    });
    expect(saveCursorMock).toHaveBeenCalledWith(
      circleEventCursorKey('member_joined', '0xcore', 'testnet'),
      { txDigest: 'tx-join', eventSeq: '0' },
      'lease-token',
    );
  });

  it("does not cache a failed lookup: the circle's next event looks the phone up again", async () => {
    clientMock.mockReturnValue(makeClient(['member_joined', 'circle_activated']));
    // The index fails the first read only.
    indexMock.mockRejectedValueOnce(new Error(INDEX_DOWN)).mockResolvedValue([RENEWED_BLOB]);

    const res = await run();

    // Streams drain in CIRCLE_EVENT_STREAMS order, so the first of the two
    // to reach the circle meets the outage.
    const [first, second] = CIRCLE_EVENT_STREAMS.map((s) => s.name).filter(
      (name) => name in EVENTS,
    );
    expect(res.statusCode).toBe(500);
    expect(summaryOf(res, first)).toMatchObject({ halted: true, sent: 0 });
    expect(summaryOf(res, second)).toMatchObject({ halted: false, sent: 1 });
    expect(indexMock.mock.calls).toEqual([[CIRCLE], [CIRCLE]]);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][0]).toMatchObject({
      phoneOverride: PHONE,
      dedupeKey: `${second}:${EVENTS[second].txDigest}:0`,
    });
  });
});
