/**
 * What the server and edge Sentry clients report and send.
 *
 * JAVASCRIPT-NEXTJS-A ("Error: Invalid JSON", POST /api/whatsapp/webhook)
 * was a curl POST of `not json`: Next's pages-API body parser answered 400
 * and still passed the error to onRequestError, which reported it as an
 * unhandled server error. The same event carried the request body, the
 * client IP (x-vercel-proxied-for) and its city, latitude and postal code,
 * although the config sets sendDefaultPii: false.
 */

import { Readable } from 'stream';
import type { Event } from '@sentry/nextjs';

jest.mock('@sentry/nextjs', () => ({
  init: jest.fn(),
  captureRequestError: jest.fn(),
}));

import * as Sentry from '@sentry/nextjs';
import { isNextBodyParseError, scrubSentryEvent } from '../sentry-filters';
import { onRequestError } from '../../instrumentation';

// Next's own parser, so a Next upgrade that changes these errors fails here.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { parseBody } = require('next/dist/server/api-utils/node/parse-body') as {
  parseBody: (req: unknown, limit: string) => Promise<unknown>;
};

async function parseError(body: string, contentType: string, limit = '1mb'): Promise<unknown> {
  const req = Object.assign(Readable.from([Buffer.from(body)]), {
    headers: { 'content-type': contentType },
  });
  try {
    await parseBody(req, limit);
  } catch (err) {
    return err;
  }
  throw new Error('parseBody accepted the body');
}

const requestInfo = { path: '/api/whatsapp/webhook', method: 'POST', headers: {} };
const errorContext = {
  routerKind: 'Pages Router' as const,
  routePath: '/api/whatsapp/webhook',
  routeType: 'route' as const,
  revalidateReason: undefined,
};

describe('isNextBodyParseError', () => {
  it("matches Next's 400s for malformed JSON and unreadable bodies", async () => {
    expect(isNextBodyParseError(await parseError('not json', 'application/json'))).toBe(true);
    expect(
      isNextBodyParseError(await parseError('{}', 'application/json; charset=bogus')),
    ).toBe(true);
  });

  it('still reports oversized bodies (413)', async () => {
    const tooLarge = await parseError('{"a":1}', 'application/json', '1b');
    expect((tooLarge as { statusCode?: number }).statusCode).toBe(413);
    expect(isNextBodyParseError(tooLarge)).toBe(false);
  });

  it('does not match our own errors', () => {
    expect(isNextBodyParseError(new Error('Invalid JSON'))).toBe(false);
    expect(isNextBodyParseError(Object.assign(new Error('boom'), { statusCode: 400 }))).toBe(
      false,
    );
    expect(isNextBodyParseError({ statusCode: 400, message: 'Invalid JSON' })).toBe(false);
    expect(isNextBodyParseError(undefined)).toBe(false);
  });
});

describe('onRequestError', () => {
  it("drops Next's body-parse 400s", async () => {
    await onRequestError(await parseError('not json', 'application/json'), requestInfo, errorContext);
    expect(Sentry.captureRequestError).not.toHaveBeenCalled();
  });

  it('reports every other request error', async () => {
    const error = new Error('Connection terminated unexpectedly');
    await onRequestError(error, requestInfo, errorContext);
    expect(Sentry.captureRequestError).toHaveBeenCalledWith(error, requestInfo, errorContext);
  });
});

describe('scrubSentryEvent', () => {
  it('drops the body, cookies, credentials and the client IP and location from an error event', () => {
    const event: Event = {
      exception: { values: [{ type: 'Error', value: 'boom' }] },
      request: {
        url: 'https://njangionchain.com/api/zkLogin',
        method: 'POST',
        query_string: 'network=testnet',
        data: '{"jwt":"eyJ.fake.jwt"}',
        cookies: { 'session-id': 'opaque-session' },
        headers: {
          Accept: '*/*',
          'Content-Type': 'application/json',
          Host: 'njangionchain.com',
          'User-Agent': 'curl/8.7.1',
          'X-Matched-Path': '/api/zkLogin',
          'X-Vercel-Deployment-Url': 'njangi-on-chain-abc.vercel.app',
          'X-Vercel-Id': 'iad1::abc-123',
          Cookie: 'session-id=opaque-session',
          Authorization: 'Bearer cron-secret',
          'X-Internal-Auth': 'issuance-secret',
          'X-Hub-Signature-256': 'sha256=abc',
          'X-Vercel-Oidc-Token': 'eyJ.oidc.token',
          'X-Vercel-Proxied-For': '203.0.113.7',
          'X-Vercel-Ip-City': 'Testville',
          'X-Vercel-Ip-Latitude': '0.0000',
          'X-Vercel-Ip-Longitude': '0.0000',
          'X-Vercel-Ip-Postal-Code': '00000',
        },
      },
    };

    const scrubbed = scrubSentryEvent(event);

    expect(scrubbed.request).toEqual({
      url: 'https://njangionchain.com/api/zkLogin',
      method: 'POST',
      query_string: 'network=testnet',
      headers: {
        Accept: '*/*',
        'Content-Type': 'application/json',
        Host: 'njangionchain.com',
        'User-Agent': 'curl/8.7.1',
        'X-Matched-Path': '/api/zkLogin',
        'X-Vercel-Deployment-Url': 'njangi-on-chain-abc.vercel.app',
        'X-Vercel-Id': 'iad1::abc-123',
      },
    });
    expect(scrubbed.exception).toEqual(event.exception);
  });

  it('matches header names case-insensitively', () => {
    const scrubbed = scrubSentryEvent({
      request: { headers: { 'user-agent': 'Mozilla/5.0', 'x-real-ip': '203.0.113.7' } },
    });
    expect(scrubbed.request?.headers).toEqual({ 'user-agent': 'Mozilla/5.0' });
  });

  it('drops the same data from transaction span attributes', () => {
    const event: Event = {
      type: 'transaction',
      transaction: 'POST /api/zkLogin',
      contexts: {
        trace: {
          trace_id: 'trace',
          span_id: 'root',
          data: {
            'http.request.header.user_agent': 'Mozilla/5.0',
            'http.request.header.x_vercel_id': 'iad1::abc-123',
            'http.request.header.x_vercel_proxied_for': '203.0.113.7',
            'http.request.header.x_vercel_ip_city': 'Testville',
            'http.request.header.cookie.session_id': 'opaque-session',
            'http.request.body.data': '{"jwt":"eyJ.fake.jwt"}',
            'http.response.header.set_cookie.session_id': 'opaque-session',
            'http.response.status_code': 200,
            'url.full': 'https://njangionchain.com/api/zkLogin',
          },
        },
      },
      spans: [
        {
          trace_id: 'trace',
          span_id: 'child',
          start_timestamp: 0,
          data: {
            'http.request.header.accept': '*/*',
            'http.request.header.authorization': 'Bearer cron-secret',
            'db.system': 'postgresql',
          },
        },
      ],
    };

    const scrubbed = scrubSentryEvent(event);

    expect(scrubbed.contexts?.trace?.data).toEqual({
      'http.request.header.user_agent': 'Mozilla/5.0',
      'http.request.header.x_vercel_id': 'iad1::abc-123',
      'http.response.status_code': 200,
      'url.full': 'https://njangionchain.com/api/zkLogin',
    });
    expect(scrubbed.spans?.[0].data).toEqual({
      'http.request.header.accept': '*/*',
      'db.system': 'postgresql',
    });
  });

  it('leaves events without request data alone', () => {
    const event: Event = { message: 'no request here' };
    expect(scrubSentryEvent(event)).toEqual({ message: 'no request here' });
  });
});

describe('runtime configs', () => {
  const ORIGINAL_DSN = process.env.SENTRY_DSN;

  afterEach(() => {
    if (ORIGINAL_DSN === undefined) delete process.env.SENTRY_DSN;
    else process.env.SENTRY_DSN = ORIGINAL_DSN;
  });

  it.each(['../../sentry.server.config', '../../sentry.edge.config'])(
    '%s scrubs errors and transactions before sending',
    (configPath) => {
      process.env.SENTRY_DSN = 'https://public@o0.ingest.sentry.io/0';
      jest.isolateModules(() => {
        /* eslint-disable @typescript-eslint/no-require-imports */
        const isolatedSentry = require('@sentry/nextjs') as { init: jest.Mock };
        const filters = require('../sentry-filters') as typeof import('../sentry-filters');
        require(configPath);
        /* eslint-enable @typescript-eslint/no-require-imports */
        expect(isolatedSentry.init).toHaveBeenCalledWith(
          expect.objectContaining({
            sendDefaultPii: false,
            beforeSend: filters.scrubSentryEvent,
            beforeSendTransaction: filters.scrubSentryEvent,
          }),
        );
      });
    },
  );
});
