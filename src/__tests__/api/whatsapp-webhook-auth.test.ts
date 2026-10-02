/**
 * Regression tests for the WhatsApp webhook (src/pages/api/whatsapp/webhook.ts).
 *
 * Signature enforcement (gtm-readiness review, June 2026): the 'allow invalid
 * signatures for debugging' bypass must stay gone — forged or missing
 * signatures are 403, a missing app secret in production fails closed with
 * 500, and the Meta GET hub.challenge verification keeps working.
 *
 * Raw bytes (October 2026): X-Hub-Signature-256 covers the exact bytes Meta
 * POSTs, and those bytes escape non-ASCII characters as \uXXXX and can escape
 * '/' as '\/'. The handler runs with bodyParser disabled, so these requests
 * stream raw bytes, and the fixtures are written byte for byte as Meta sends
 * them. Never sign JSON.stringify of a parsed object here: that is what the
 * handler used to verify, and it hides exactly the deliveries that failed.
 *
 * Log hygiene: no phone number or message text may reach the logs.
 */

import crypto from 'crypto';
import { Readable } from 'stream';
import { inspect } from 'util';
import type { NextApiRequest, NextApiResponse } from 'next';
import handler, { config } from '@/pages/api/whatsapp/webhook';
import { WHATSAPP_GRAPH_API_VERSION } from '@/lib/whatsapp-graph-api';
import {
  formatCircleStatusForWhatsAppWithNames,
  getCircleStatus,
} from '@/services/circle-status.service';
import { lookupCirclesForPhone } from '@/lib/whatsapp-link-index';
import { getActiveWhatsAppRegistries } from '@/services/whatsapp-registry-service';
import { getPooledSuiClient } from '@/services/sui-rpc-failover';
import { fetchAndDecryptPII } from '@/lib/walrus-pii';

jest.mock('@/services/circle-status.service', () => ({
  getCircleStatus: jest.fn(),
  formatCircleStatusForWhatsAppWithNames: jest.fn(),
}));
jest.mock('@/lib/whatsapp-link-index', () => ({
  lookupCirclesForPhone: jest.fn(),
}));
jest.mock('@/services/whatsapp-registry-service', () => ({
  getActiveWhatsAppRegistries: jest.fn(),
}));
jest.mock('@/services/sui-rpc-failover', () => ({
  getPooledSuiClient: jest.fn(),
}));
jest.mock('@/lib/walrus-pii', () => ({
  fetchAndDecryptPII: jest.fn(),
}));

const mockedGetCircleStatus = getCircleStatus as jest.MockedFunction<typeof getCircleStatus>;
const mockedFormatStatus = formatCircleStatusForWhatsAppWithNames as jest.MockedFunction<
  typeof formatCircleStatusForWhatsAppWithNames
>;
const mockedLookupCircles = lookupCirclesForPhone as jest.MockedFunction<
  typeof lookupCirclesForPhone
>;
const mockedGetRegistries = getActiveWhatsAppRegistries as jest.MockedFunction<
  typeof getActiveWhatsAppRegistries
>;
const mockedGetSuiClient = getPooledSuiClient as jest.MockedFunction<typeof getPooledSuiClient>;
const mockedDecryptPII = fetchAndDecryptPII as jest.MockedFunction<typeof fetchAndDecryptPII>;

const APP_SECRET = 'test-app-secret';
const VERIFY_TOKEN = 'test-verify-token';
// Fictional numbers: NANP reserves 555-0100 to 555-0199 for fiction.
const SENDER = '12025550143';
const CIRCLE_ID = `0x${'ab'.repeat(32)}`;
const STATUS_REPLY = 'Circle status for the test circle';

interface MockRes {
  statusCode: number;
  jsonBody: unknown;
  sentBody: unknown;
  headers: Record<string, unknown>;
}

function createMockRes(): NextApiResponse & MockRes {
  const res = {
    statusCode: 0,
    jsonBody: undefined as unknown,
    sentBody: undefined as unknown,
    headers: {} as Record<string, unknown>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.jsonBody = body;
      return this;
    },
    send(body: unknown) {
      this.sentBody = body;
      return this;
    },
    setHeader(key: string, value: unknown) {
      this.headers[key] = value;
      return this;
    },
  };
  return res as unknown as NextApiResponse & MockRes;
}

// The handler runs with `bodyParser: false` and reads the request stream, so
// the mock streams the body bytes exactly as Meta sends them.
function createPostReq(rawBody: string, signature?: string): NextApiRequest {
  const req = Readable.from([Buffer.from(rawBody, 'utf8')]) as unknown as NextApiRequest;
  (req as { method?: string }).method = 'POST';
  (req as { headers: Record<string, string> }).headers = {
    'content-type': 'application/json',
    ...(signature ? { 'x-hub-signature-256': signature } : {}),
  };
  return req;
}

/** The X-Hub-Signature-256 header Meta sends for these exact bytes. */
function signRaw(rawBody: string, secret = APP_SECRET): string {
  const digest = crypto
    .createHmac('sha256', secret)
    .update(Buffer.from(rawBody, 'utf8'))
    .digest('hex');
  return `sha256=${digest}`;
}

async function deliver(rawBody: string, signature = signRaw(rawBody)) {
  const res = createMockRes();
  await handler(createPostReq(rawBody, signature), res);
  return res;
}

let messageCount = 0;

function nextMessageId(): string {
  messageCount += 1;
  return `wamid.TEST-${messageCount}`;
}

/**
 * An inbound text message exactly as Meta POSTs it: compact JSON, with `text`
 * and `profileName` inserted verbatim, so an escape such as é or \/
 * reaches the handler as those bytes.
 */
function inboundMessage(
  text: string,
  { profileName = 'Test Member', messageId = nextMessageId() } = {},
): string {
  return (
    '{"object":"whatsapp_business_account","entry":[{"id":"100000000000001","changes":[{"value":{' +
    '"messaging_product":"whatsapp",' +
    '"metadata":{"display_phone_number":"12025550100","phone_number_id":"100000000000002"},' +
    `"contacts":[{"profile":{"name":"${profileName}"},"wa_id":"${SENDER}"}],` +
    `"messages":[{"from":"${SENDER}","id":"${messageId}","timestamp":"1790000000",` +
    `"text":{"body":"${text}"},"type":"text"}]` +
    '},"field":"messages"}]}]}'
  );
}

describe('WhatsApp webhook', () => {
  const originalEnv = { ...process.env };
  let fetchMock: jest.SpiedFunction<typeof fetch>;
  let consoleCalls: unknown[][];

  /** The WhatsApp replies the handler sent through the Graph API. */
  function sentReplies(): Array<{ to: string; text: { body: string } }> {
    return fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
  }

  /** Everything the handler logged, rendered the way console.log renders it. */
  function loggedText(): string {
    return consoleCalls
      .map((args) =>
        args.map((arg) => (typeof arg === 'string' ? arg : inspect(arg, { depth: 10 }))).join(' '),
      )
      .join('\n');
  }

  beforeEach(() => {
    process.env.WHATSAPP_APP_SECRET = APP_SECRET;
    process.env.WHATSAPP_VERIFY_TOKEN = VERIFY_TOKEN;
    process.env.NEXT_PUBLIC_SUI_NETWORK = 'testnet';

    fetchMock = jest
      .spyOn(global, 'fetch')
      .mockImplementation(async () => new Response('{}', { status: 200 }));
    consoleCalls = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      jest.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        consoleCalls.push(args);
      });
    }

    for (const mock of [
      mockedGetCircleStatus,
      mockedFormatStatus,
      mockedLookupCircles,
      mockedGetRegistries,
      mockedGetSuiClient,
      mockedDecryptPII,
    ]) {
      mock.mockReset();
    }
    mockedGetCircleStatus.mockResolvedValue({} as never);
    mockedFormatStatus.mockResolvedValue(STATUS_REPLY);
    mockedLookupCircles.mockResolvedValue([]);
    mockedGetRegistries.mockReturnValue([]);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('signature enforcement', () => {
    const emptyDelivery = '{"object":"whatsapp_business_account","entry":[]}';

    it('accepts a POST with a valid signature', async () => {
      const res = await deliver(emptyDelivery);

      expect(res.statusCode).toBe(200);
      expect(res.jsonBody).toMatchObject({ success: true });
    });

    it('rejects a POST with a forged signature with 403', async () => {
      const res = await deliver(emptyDelivery, signRaw(emptyDelivery, 'wrong-secret'));

      expect(res.statusCode).toBe(403);
      expect(res.jsonBody).toMatchObject({ success: false });
    });

    it('rejects a POST with a missing signature with 403', async () => {
      const res = createMockRes();

      await handler(createPostReq(emptyDelivery), res);

      expect(res.statusCode).toBe(403);
      expect(res.jsonBody).toMatchObject({ success: false });
    });

    it('rejects a POST with a malformed signature header with 403', async () => {
      const res = await deliver(emptyDelivery, 'not-a-sha256-header');

      expect(res.statusCode).toBe(403);
    });

    it('fails closed with 500 when WHATSAPP_APP_SECRET is missing in production', async () => {
      delete process.env.WHATSAPP_APP_SECRET;
      (process.env as Record<string, string>).NODE_ENV = 'production';

      const res = await deliver(emptyDelivery);

      expect(res.statusCode).toBe(500);
      expect(res.jsonBody).toMatchObject({ success: false });
    });

    it('still answers the Meta GET hub.challenge verification', async () => {
      const res = createMockRes();
      const req = {
        method: 'GET',
        headers: {},
        query: {
          'hub.mode': 'subscribe',
          'hub.challenge': 'challenge-12345',
          'hub.verify_token': VERIFY_TOKEN,
        },
        cookies: {},
      } as unknown as NextApiRequest;

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.sentBody).toBe('challenge-12345');
    });

    it('rejects GET verification with a wrong verify token', async () => {
      const res = createMockRes();
      const req = {
        method: 'GET',
        headers: {},
        query: {
          'hub.mode': 'subscribe',
          'hub.challenge': 'challenge-12345',
          'hub.verify_token': 'wrong-token',
        },
        cookies: {},
      } as unknown as NextApiRequest;

      await handler(req, res);

      expect(res.statusCode).toBe(403);
    });
  });

  describe('raw-body verification', () => {
    it('disables the Next.js body parser so the handler reads the raw bytes', () => {
      expect(config).toEqual({ api: { bodyParser: false } });
    });

    it('verifies non-ASCII text as Meta escapes it (\\uXXXX) and replies', async () => {
      const raw = inboundMessage('help Ol\\u00e1 \\ud83d\\udc4b', {
        profileName: 'Jos\\u00e9 \\ud83d\\ude80',
      });
      // What the handler used to verify does not reproduce these bytes.
      expect(JSON.stringify(JSON.parse(raw))).not.toBe(raw);

      const res = await deliver(raw);

      expect(res.statusCode).toBe(200);
      expect(sentReplies()).toEqual([
        expect.objectContaining({
          to: SENDER,
          text: expect.objectContaining({
            body: expect.stringContaining('Njangi WhatsApp Channel'),
          }),
        }),
      ]);
    });

    it('verifies a "/status <circle-id>" command sent as \\/status and answers it', async () => {
      const raw = inboundMessage(`\\/status ${CIRCLE_ID}`);
      expect(JSON.stringify(JSON.parse(raw))).not.toBe(raw);

      const res = await deliver(raw);

      expect(res.statusCode).toBe(200);
      expect(mockedGetCircleStatus).toHaveBeenCalledWith(CIRCLE_ID, 'testnet');
      expect(sentReplies()).toEqual([
        expect.objectContaining({
          to: SENDER,
          text: expect.objectContaining({ body: STATUS_REPLY }),
        }),
      ]);
    });

    it('verifies the same non-ASCII text sent unescaped as UTF-8', async () => {
      const raw = inboundMessage('help Olá 👋', { profileName: 'José 🚀' });

      const res = await deliver(raw);

      expect(res.statusCode).toBe(200);
      expect(sentReplies()).toHaveLength(1);
    });

    it('rejects a signature computed over a re-serialized copy of the body', async () => {
      const raw = inboundMessage('help Ol\\u00e1 \\ud83d\\udc4b');

      // The digest the old handler computed; Meta never signs these bytes.
      const res = await deliver(raw, signRaw(JSON.stringify(JSON.parse(raw))));

      expect(res.statusCode).toBe(403);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('checks the signature before parsing the body', async () => {
      const notJson = 'not json {';

      const forged = await deliver(notJson, signRaw(notJson, 'wrong-secret'));
      const signed = await deliver(notJson);

      expect(forged.statusCode).toBe(403);
      expect(signed.statusCode).toBe(400);
      expect(signed.jsonBody).toMatchObject({ success: false });
    });
  });

  describe('log hygiene', () => {
    it('logs the id and type of an inbound message, not its number or text', async () => {
      await deliver(
        inboundMessage('help me find my circle please', { messageId: 'wamid.TEST-hygiene' }),
      );

      const incoming = consoleCalls.find(([line]) =>
        String(line).includes('Incoming WhatsApp message'),
      );
      expect(incoming?.[1]).toEqual({
        from: '***0143',
        type: 'text',
        messageId: 'wamid.TEST-hygiene',
      });
      expect(loggedText()).not.toContain('find my circle');
    });

    it('keeps phone numbers and message text out of every log line', async () => {
      // Print the debug lines too, as a development deployment would.
      (process.env as Record<string, string>).NODE_ENV = 'development';
      // The multi-circle reply waits 1s between sends; skip only that wait.
      const realSetTimeout = global.setTimeout;
      jest.spyOn(global, 'setTimeout').mockImplementation(((callback: () => void, ms?: number) => {
        if (ms === 1000) {
          callback();
          return 0;
        }
        return realSetTimeout(callback, ms);
      }) as unknown as typeof setTimeout);

      // help, then Meta redelivering it (the duplicate is skipped)
      const help = inboundMessage('help me find my circle please');
      await deliver(help);
      await deliver(help);
      // /status <circle-id>, answered, then failing
      await deliver(inboundMessage(`\\/status ${CIRCLE_ID}`));
      mockedGetCircleStatus.mockRejectedValueOnce(new Error('rpc unavailable'));
      await deliver(inboundMessage(`\\/status ${CIRCLE_ID}`));
      // /status resolved through the HMAC index
      mockedLookupCircles.mockResolvedValueOnce([
        { circleId: CIRCLE_ID, walrusBlobId: 'blob-1', linkType: 1 },
      ]);
      await deliver(inboundMessage('\\/status'));
      // /status resolved by the on-chain registry scan, which matches the sender
      mockedGetRegistries.mockReturnValueOnce([{ packageId: '0x1', registryObjectId: '0x2' }]);
      mockedGetSuiClient.mockReturnValueOnce({
        getObject: async () => ({
          data: {
            content: {
              dataType: 'moveObject',
              fields: {
                links: [
                  {
                    fields: {
                      circle_id: CIRCLE_ID,
                      enabled: true,
                      walrus_blob_id: Array.from(Buffer.from('blob-1')),
                    },
                  },
                ],
              },
            },
          },
        }),
      } as never);
      mockedDecryptPII.mockResolvedValueOnce({ phone_e164: `+${SENDER}` } as never);
      await deliver(inboundMessage('\\/status'));
      // /status when the registry scan fails
      mockedGetRegistries.mockImplementationOnce(() => {
        throw new Error('registry unavailable');
      });
      await deliver(inboundMessage('\\/status'));
      // anything else gets an acknowledgment
      await deliver(inboundMessage('what time is the next meeting'));

      const logs = loggedText();
      // Every line that used to print the number ran...
      for (const line of [
        'Incoming WhatsApp message',
        'Skipping duplicate message',
        'Help message sent',
        'Status message sent',
        'Error sending status message',
        'Resolved linked circles via HMAC index',
        'Found linked circles',
        'Error querying WhatsApp registry for all circles',
        'Status messages sent for all circles',
        'Acknowledgment sent',
      ]) {
        expect(logs).toContain(line);
      }
      // ...and printed at most the last four digits, and no message text.
      expect(logs).toContain('***0143');
      expect(logs).not.toContain(SENDER.slice(-5));
      expect(logs).not.toContain('find my circle');
      expect(logs).not.toContain('next meeting');
      expect(logs).not.toContain('/status');
    });
  });

  describe('Graph API version', () => {
    it('sends every reply to the pinned version, whatever WHATSAPP_API_VERSION says', async () => {
      // The retired variable, at the value the old docs gave. Nothing may read it.
      process.env.WHATSAPP_API_VERSION = 'v21.0';
      process.env.WHATSAPP_PHONE_NUMBER_ID = '100000000000002';
      // The multi-circle reply waits 1s between sends; skip only that wait.
      const realSetTimeout = global.setTimeout;
      jest.spyOn(global, 'setTimeout').mockImplementation(((callback: () => void, ms?: number) => {
        if (ms === 1000) {
          callback();
          return 0;
        }
        return realSetTimeout(callback, ms);
      }) as unknown as typeof setTimeout);

      // One message per reply: help, /status <circle-id>, /status with no
      // linked circle, /status with one, and the acknowledgment.
      await deliver(inboundMessage('help'));
      await deliver(inboundMessage(`\\/status ${CIRCLE_ID}`));
      await deliver(inboundMessage('\\/status'));
      mockedLookupCircles.mockResolvedValueOnce([
        { circleId: CIRCLE_ID, walrusBlobId: 'blob-1', linkType: 1 },
      ]);
      await deliver(inboundMessage('\\/status'));
      await deliver(inboundMessage('what time is the next meeting'));

      expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual(
        Array(5).fill(`https://graph.facebook.com/${WHATSAPP_GRAPH_API_VERSION}/100000000000002/messages`),
      );
    });
  });
});
