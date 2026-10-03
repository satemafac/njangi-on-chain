/**
 * GET /api/cron/whatsapp-circle-events and the per-link data keys
 * (src/lib/whatsapp-pii-keys.ts): once a CircleUnlinked event is settled,
 * the "Circle disconnected" message sent or given up on, the cron deletes
 * the data key of the link it disabled, found by the event's link nonce.
 * From then on no copy of that link's blob opens. A halted event keeps its
 * key for the retry (the message still needs the number), and a failed
 * delete halts the stream so the next run deletes it.
 *
 * Drives the real drain loop; Postgres persistence, phone resolution and
 * the send are mocked, as in whatsapp-circle-events-handler.test.ts.
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
jest.mock('../whatsapp-pii-keys', () => ({
  deleteUnlinkedLinkKey: jest.fn(),
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
  default: { getUserByAddress: jest.fn(async () => null) },
}));

import type { NextApiRequest, NextApiResponse } from 'next';
import handler from '../../pages/api/cron/whatsapp-circle-events';
import { saveCycleFinalizedCursor } from '../cycle-finalized-cron';
import { sendMemberNotification } from '../whatsapp-notifier';
import { resolveCirclePhone } from '../whatsapp-bot/circle-phone';
import { deleteUnlinkedLinkKey } from '../whatsapp-pii-keys';
import { getPooledSuiClient } from '../../services/sui-rpc-failover';
import { parseUnlinkedLinkRef } from '../whatsapp-bot/circle-events';

const sendMock = sendMemberNotification as jest.Mock;
const phoneMock = resolveCirclePhone as jest.Mock;
const deleteKeyMock = deleteUnlinkedLinkKey as jest.Mock;
const saveCursorMock = saveCycleFinalizedCursor as jest.Mock;
const clientMock = getPooledSuiClient as jest.Mock;

const SECRET = 'test-cron-secret';
const CIRCLE = '0x' + 'c1'.repeat(32);
const ADMIN = '0x' + 'ad'.repeat(32);
const NONCE = Array.from({ length: 32 }, (_, i) => (i * 7 + 3) % 256);
const NONCE_HEX = Buffer.from(NONCE).toString('hex');
const UNLINKED_TYPE = '0xwa::whatsapp_integration::CircleUnlinked';
const LINKED_TYPE = '0xwa::whatsapp_integration::CircleLinked';
const HOUR_MS = 60 * 60 * 1000;
const ORIGINAL_CRON_SECRET = process.env.CRON_SECRET;

function event(txDigest: string, ageMs = 0, nonce: unknown = NONCE) {
  return {
    id: { txDigest, eventSeq: '0' },
    parsedJson: { circle_id: CIRCLE, admin_address: ADMIN, link_nonce: nonce, unlinked_at: '7' },
    timestampMs: String(Date.now() - ageMs),
  };
}

/** A chain whose only event is `events` on `type` (CircleUnlinked by default). */
function chainWith(events: ReturnType<typeof event>[], type = UNLINKED_TYPE) {
  return {
    getObject: jest.fn(async ({ id }: { id: string }) =>
      id === '0xregistry'
        ? { data: { type: '0xwa::whatsapp_integration::WhatsAppRegistry' } }
        : { error: { code: 'notExists', object_id: id } },
    ),
    queryEvents: jest.fn(async ({ query }: { query: { MoveEventType: string } }) => {
      if (query.MoveEventType !== type || events.length === 0) {
        return { data: [], nextCursor: null, hasNextPage: false };
      }
      return { data: events, nextCursor: events[events.length - 1].id, hasNextPage: false };
    }),
    getTransactionBlock: jest.fn(),
  };
}

async function run() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    setHeader: jest.fn(),
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  await handler(
    { method: 'GET', headers: { authorization: `Bearer ${SECRET}` } } as unknown as NextApiRequest,
    res as unknown as NextApiResponse,
  );
  return res;
}

function unlinkStream(body: unknown) {
  return (body as { streams: Array<{ stream: string; halted: boolean }> }).streams.find(
    (s) => s.stream === 'circle_unlinked',
  );
}

beforeEach(() => {
  process.env.CRON_SECRET = SECRET;
  sendMock.mockReset().mockResolvedValue({ sent: true, phoneE164: '+447700900123' });
  phoneMock.mockReset().mockResolvedValue('+447700900123');
  deleteKeyMock.mockReset().mockResolvedValue(1);
  saveCursorMock.mockReset().mockResolvedValue(undefined);
  clientMock.mockReset().mockReturnValue(chainWith([event('tx-unlink')]));
});

afterAll(() => {
  if (ORIGINAL_CRON_SECRET === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = ORIGINAL_CRON_SECRET;
});

it('deletes the unlinked link\'s key by its nonce after the confirmation is sent', async () => {
  const res = await run();

  expect(res.statusCode).toBe(200);
  expect(sendMock).toHaveBeenCalledTimes(1);
  expect(deleteKeyMock).toHaveBeenCalledWith(CIRCLE, NONCE_HEX);
  expect(sendMock.mock.invocationCallOrder[0]).toBeLessThan(deleteKeyMock.mock.invocationCallOrder[0]);
  // Resolved with the disabled link: the key was still there for it.
  expect(phoneMock).toHaveBeenCalledWith(expect.anything(), CIRCLE, 'testnet', { includeDisabled: true });
});

it('deletes it when there was no number to confirm to', async () => {
  phoneMock.mockResolvedValue(null);

  const res = await run();

  expect(res.statusCode).toBe(200);
  expect(sendMock).not.toHaveBeenCalled();
  expect(deleteKeyMock).toHaveBeenCalledWith(CIRCLE, NONCE_HEX);
});

it('deletes it after a send that failed for good', async () => {
  sendMock.mockResolvedValue({ sent: false, reason: 'send_failed' });

  await run();

  expect(deleteKeyMock).toHaveBeenCalledWith(CIRCLE, NONCE_HEX);
});

it('deletes it for an unlink too old to confirm, without sending', async () => {
  clientMock.mockReturnValue(chainWith([event('tx-old', 48 * HOUR_MS)]));

  const res = await run();

  expect(res.statusCode).toBe(200);
  expect(sendMock).not.toHaveBeenCalled();
  expect(deleteKeyMock).toHaveBeenCalledWith(CIRCLE, NONCE_HEX);
});

it('keeps the key while the confirmation is still owed (halted send or lookup)', async () => {
  sendMock.mockResolvedValue({ sent: false, reason: 'missing_credentials' });
  const halted = await run();
  expect(halted.statusCode).toBe(500);
  expect(deleteKeyMock).not.toHaveBeenCalled();

  sendMock.mockResolvedValue({ sent: true });
  phoneMock.mockRejectedValue(new Error('Walrus aggregator unreachable'));
  const lookupFailed = await run();
  expect(lookupFailed.statusCode).toBe(500);
  expect(deleteKeyMock).not.toHaveBeenCalled();
});

it('halts without advancing when the key cannot be deleted, so the next run deletes it', async () => {
  deleteKeyMock.mockRejectedValue(new Error('Connection terminated unexpectedly'));

  const res = await run();

  expect(res.statusCode).toBe(500);
  expect(unlinkStream(res.body)?.halted).toBe(true);
  expect(saveCursorMock).not.toHaveBeenCalled();
});

it('touches no key for other circle events', async () => {
  clientMock.mockReturnValue(chainWith([event('tx-link')], LINKED_TYPE));

  const res = await run();

  expect(res.statusCode).toBe(200);
  expect(sendMock).toHaveBeenCalledTimes(1);
  expect(deleteKeyMock).not.toHaveBeenCalled();
});

describe('parseUnlinkedLinkRef', () => {
  it('reads the circle and the nonce JSON-RPC renders as byte values', () => {
    expect(parseUnlinkedLinkRef(event('tx').parsedJson)).toEqual({
      circleId: CIRCLE,
      linkNonceHex: NONCE_HEX,
    });
  });

  it('accepts the nonce as hex or base64 too', () => {
    const bytes = Buffer.from(NONCE);
    for (const nonce of [bytes.toString('hex'), `0x${bytes.toString('hex')}`, bytes.toString('base64')]) {
      expect(parseUnlinkedLinkRef({ circle_id: CIRCLE, link_nonce: nonce })).toEqual({
        circleId: CIRCLE,
        linkNonceHex: NONCE_HEX,
      });
    }
  });

  it('returns null without a circle or a usable nonce', () => {
    expect(parseUnlinkedLinkRef(null)).toBeNull();
    expect(parseUnlinkedLinkRef({ link_nonce: NONCE })).toBeNull();
    expect(parseUnlinkedLinkRef({ circle_id: CIRCLE })).toBeNull();
    expect(parseUnlinkedLinkRef({ circle_id: CIRCLE, link_nonce: [] })).toBeNull();
    expect(parseUnlinkedLinkRef({ circle_id: CIRCLE, link_nonce: [1, 300] })).toBeNull();
  });
});
