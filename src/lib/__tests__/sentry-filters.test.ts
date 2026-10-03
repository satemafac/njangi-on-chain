/**
 * What the Sentry clients report and send.
 *
 * JAVASCRIPT-NEXTJS-A ("Error: Invalid JSON", POST /api/whatsapp/webhook)
 * was a curl POST of `not json`: Next's pages-API body parser answered 400
 * and still passed the error to onRequestError, which reported it as an
 * unhandled server error. The same event carried the request body, the
 * client IP (x-vercel-proxied-for) and its city, latitude and postal code,
 * although the config sets sendDefaultPii: false.
 *
 * sendDefaultPii does not keep secrets out of URLs and log lines either: the
 * OAuth id_token in /auth/callback's fragment (where the inline script that
 * parks it did not run), Meta's hub.verify_token in the webhook's query
 * string, and Circle Record share tokens in paths. Every sample below is
 * fake, in the shape the app really handles.
 */

import { createHash } from 'crypto';
import { Readable } from 'stream';
import type { Breadcrumb, Event } from '@sentry/nextjs';

jest.mock('@sentry/nextjs', () => ({
  init: jest.fn(),
  captureRequestError: jest.fn(),
}));

import * as Sentry from '@sentry/nextjs';
import {
  DROPPED_FIELDS_TAG,
  FILTERED,
  isNextBodyParseError,
  scrubSentryBreadcrumb,
  scrubSentryEvent,
  scrubString,
  scrubText,
  scrubUrl,
} from '../sentry-filters';
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

// --- Fake secrets, in the shapes the app handles -------------------------

const b64url = (text: string) => Buffer.from(text).toString('base64url');
const SITE = 'https://njangionchain.com';
// A Google id_token: header.payload.signature, each base64url.
const FAKE_JWT = [
  b64url('{"alg":"RS256","kid":"fake-key-id","typ":"JWT"}'),
  b64url('{"iss":"https://accounts.google.com","aud":"fake-client","sub":"000000000000000000000"}'),
  b64url('not a real signature, test bytes'),
].join('.');
const JWT_PAYLOAD = FAKE_JWT.split('.')[1];
// generateShareToken(): 24 random bytes, base64url.
const FAKE_SHARE_TOKEN = b64url('fake-share-token-24bytes');
const FAKE_VERIFY_TOKEN = 'fake-verify-token';
const WEBHOOK_QUERY = `hub.mode=subscribe&hub.verify_token=${FAKE_VERIFY_TOKEN}&hub.challenge=1158201444`;
const WEBHOOK_QUERY_SCRUBBED = `hub.mode=${FILTERED}&hub.verify_token=${FILTERED}&hub.challenge=${FILTERED}`;
// `openssl rand -hex 32`, the format of CRON_SECRET and the other generated secrets.
const FAKE_HEX_SECRET = createHash('sha256').update('fake cron secret').digest('hex');
// A 32-byte key in standard base64, like WALRUS_PII_MASTER_KEY.
const FAKE_BASE64_KEY = createHash('sha256').update('fake pii master key').digest('base64');
// A zkLogin salt: a 128-bit integer in decimal.
const FAKE_SALT = '3141592653589793238462643383279502884';
// Public identifiers that must survive, so errors stay debuggable.
const CIRCLE_ID = `0x${'a3fada18'.padEnd(64, '0')}`;
const PACKAGE_ADDRESS_NO_PREFIX = '89cddf4d'.padEnd(64, '0');
const TX_DIGEST = '7Fxb3rSqWz9kTnY2vHcMpUeG4dJaLuN8iKoQtRwZyEhB';

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

describe('scrubUrl', () => {
  it('drops the fragment, where Google and Facebook return the id_token', () => {
    expect(scrubUrl(`${SITE}/auth/callback#id_token=${FAKE_JWT}&authuser=0&prompt=none`)).toBe(
      `${SITE}/auth/callback`,
    );
    expect(scrubUrl(`/auth/callback#id_token=${FAKE_JWT}`)).toBe('/auth/callback');
  });

  it('keeps the names of query parameters and drops their values', () => {
    expect(scrubUrl(`${SITE}/api/whatsapp/webhook?${WEBHOOK_QUERY}`)).toBe(
      `${SITE}/api/whatsapp/webhook?${WEBHOOK_QUERY_SCRUBBED}`,
    );
    expect(scrubUrl('/auth/callback?code=4%2F0AfakeCode&state=fake-state&flag')).toBe(
      `/auth/callback?code=${FILTERED}&state=${FILTERED}&${FILTERED}`,
    );
    expect(scrubUrl('/pricing?billing=')).toBe('/pricing?billing=');
  });

  it('blanks the token of a Circle Record share link, but not the route pattern', () => {
    expect(scrubUrl(`${SITE}/record/s/${FAKE_SHARE_TOKEN}`)).toBe(`${SITE}/record/s/${FILTERED}`);
    expect(scrubUrl(`/api/record/shared/${FAKE_SHARE_TOKEN}`)).toBe(
      `/api/record/shared/${FILTERED}`,
    );
    expect(scrubUrl('/record/s/[token]')).toBe('/record/s/[token]');
    expect(scrubUrl('/_next/static/chunks/pages/record/s/%5Btoken%5D-0a1b2c3d4e5f6a7b.js')).toBe(
      '/_next/static/chunks/pages/record/s/%5Btoken%5D-0a1b2c3d4e5f6a7b.js',
    );
  });

  it('drops credentials written into a URL', () => {
    expect(scrubUrl('postgres://njangi:fake-password@ep-fake-1234.neon.tech/neondb')).toBe(
      `postgres://${FILTERED}@ep-fake-1234.neon.tech/neondb`,
    );
  });

  it('leaves ordinary URLs alone', () => {
    for (const url of [
      `${SITE}/circle/${CIRCLE_ID}/join`,
      `/circle/${CIRCLE_ID}/contribute`,
      'https://sui-testnet-rpc.publicnode.com/',
      `https://suiscan.xyz/testnet/tx/${TX_DIGEST}`,
      '/dashboard',
    ]) {
      expect(scrubUrl(url)).toBe(url);
    }
  });
});

describe('scrubText', () => {
  it('redacts JWTs in log lines', () => {
    expect(scrubText(`Found token in URL pattern match: ${FAKE_JWT}`)).toBe(
      `Found token in URL pattern match: ${FILTERED}`,
    );
    expect(scrubText(`payload ${JWT_PAYLOAD}`)).toBe(`payload ${FILTERED}`);
  });

  it('scrubs URLs, query strings and OAuth fragments inside the text', () => {
    expect(scrubText(`Callback URL: ${SITE}/auth/callback#id_token=${FAKE_JWT} (fragment)`)).toBe(
      `Callback URL: ${SITE}/auth/callback (fragment)`,
    );
    expect(scrubText(`hash #id_token=${FAKE_JWT}&authuser=0 and search ?code=abc&state=xyz`)).toBe(
      `hash #id_token=${FILTERED}&authuser=${FILTERED} and search ?code=${FILTERED}&state=${FILTERED}`,
    );
    expect(scrubText(`GET /api/record/shared/${FAKE_SHARE_TOKEN} 404`)).toBe(
      `GET /api/record/shared/${FILTERED} 404`,
    );
  });

  it('redacts bearer credentials and long hex, decimal and base64 secrets', () => {
    expect(scrubText(`Authorization: Bearer ${FAKE_HEX_SECRET}`)).toBe(
      `Authorization: Bearer ${FILTERED}`,
    );
    expect(scrubText(`phone lookup hash ${FAKE_HEX_SECRET} not found`)).toBe(
      `phone lookup hash ${FILTERED} not found`,
    );
    expect(scrubText(`salt=${FAKE_SALT}`)).toBe(`salt=${FILTERED}`);
    expect(scrubText(`key: ${FAKE_BASE64_KEY}`)).toBe(`key: ${FILTERED}`);
    expect(scrubText(`token ${FAKE_SHARE_TOKEN} expired`)).toBe(`token ${FILTERED} expired`);
    expect(scrubText(`using enoki_private_${'0'.repeat(32)}`)).toBe(`using ${FILTERED}`);
    expect(scrubText(`signer suiprivkey1${'q'.repeat(58)}`)).toBe(`signer ${FILTERED}`);
  });

  it('keeps the ids, digests and Move locations an error is about', () => {
    expect(TX_DIGEST).toMatch(/^[1-9A-HJ-NP-Za-km-z]{44}$/);
    for (const text of [
      `MoveAbort(MoveLocation { module: ModuleId { address: ${PACKAGE_ADDRESS_NO_PREFIX}, name: Identifier("njangi_payments") }, function: 12, instruction: 34, function_name: Some("claim_payout") }, 207) in command 0`,
      `Expected ${PACKAGE_ADDRESS_NO_PREFIX}::njangi_circles::Circle`,
      `Transaction ${TX_DIGEST} failed for circle ${CIRCLE_ID}`,
      'Missing NEXT_PUBLIC_TESTNET_NJANGI_ATTESTOR_CAP_ID for create_custody_wallet_returning_id',
      `[geo-block] country=CM region=LT path=/circle/${CIRCLE_ID}/join`,
      'body > div.flex.items-center > button.bg-blue-600',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)',
    ]) {
      expect(scrubText(text)).toBe(text);
    }
  });
});

describe('scrubString', () => {
  it('treats a lone URL or path as a URL, anything else as text', () => {
    expect(scrubString(`/auth/callback#id_token=${FAKE_JWT}`)).toBe('/auth/callback');
    expect(scrubString('?code=abc&state=xyz')).toBe(`?code=${FILTERED}&state=${FILTERED}`);
    expect(scrubString(`#id_token=${FAKE_JWT}`)).toBe(`#id_token=${FILTERED}`);
    expect(scrubString('short')).toBe('short');
  });

  it('drops strings too long to scan', () => {
    expect(scrubString('x'.repeat(100_001))).toBe(FILTERED);
  });

  it('stays linear on long adversarial input', () => {
    const inputs = [
      'a'.repeat(90_000),
      `?${'a'.repeat(90_000)}`,
      `https://${'a'.repeat(90_000)}`,
      `x://${'b'.repeat(90_000)}`,
      `eyJ${'a'.repeat(90_000)}`,
      'a1B-'.repeat(22_000),
      `${'x'.repeat(31)}.`.repeat(2_800),
      `${'aB3+'.repeat(7)}a/`.repeat(3_000),
      '&a'.repeat(45_000),
      `Bearer ${'a'.repeat(90_000)}`,
    ];
    const started = Date.now();
    for (const input of inputs) scrubString(input);
    expect(Date.now() - started).toBeLessThan(2_000);
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
      query_string: `network=${FILTERED}`,
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
    expect(scrubbed.exception).toEqual({ values: [{ type: 'Error', value: 'boom' }] });
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

  it('strips the id_token and share tokens from a browser error event', () => {
    // As the browser SDK sends it where the callback's inline script did not
    // park the fragment: request from location.href, breadcrumbs already
    // normalized into the event. The console breadcrumb is the URL log the
    // callback page wrote before the fragment was parked.
    const event: Event = {
      exception: { values: [{ type: 'Error', value: `Invalid JWT: ${FAKE_JWT}` }] },
      request: {
        url: `${SITE}/auth/callback#id_token=${FAKE_JWT}&authuser=0&prompt=none`,
        headers: {
          Referer: `${SITE}/record/s/${FAKE_SHARE_TOKEN}?utm_source=whatsapp`,
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
        },
      },
      breadcrumbs: [
        {
          category: 'console',
          level: 'log',
          message: 'URL information: [object Object]',
          data: {
            arguments: [
              'URL information:',
              {
                fullUrl: `${SITE}/auth/callback#id_token=${FAKE_JWT}&authuser=0`,
                hash: `#id_token=${FAKE_JWT}&authuser=0`,
                search: '',
                hashLength: 1180,
                idTokenFound: true,
              },
            ],
            logger: 'console',
          },
        },
        {
          category: 'navigation',
          data: { from: `/auth/callback#id_token=${FAKE_JWT}&authuser=0`, to: '/dashboard' },
        },
        {
          category: 'fetch',
          type: 'http',
          data: { method: 'GET', url: `/api/record/shared/${FAKE_SHARE_TOKEN}`, status_code: 200 },
        },
        { category: 'sentry.event', message: `Error: Invalid JWT: ${FAKE_JWT}` },
      ],
    };

    const scrubbed = scrubSentryEvent(event);

    expect(scrubbed.exception?.values?.[0].value).toBe(`Invalid JWT: ${FILTERED}`);
    expect(scrubbed.request).toEqual({
      url: `${SITE}/auth/callback`,
      headers: {
        Referer: `${SITE}/record/s/${FILTERED}?utm_source=${FILTERED}`,
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
      },
    });
    expect(scrubbed.breadcrumbs).toEqual([
      {
        category: 'console',
        level: 'log',
        message: 'URL information: [object Object]',
        data: {
          arguments: [
            'URL information:',
            {
              fullUrl: `${SITE}/auth/callback`,
              hash: `#id_token=${FILTERED}&authuser=${FILTERED}`,
              search: '',
              hashLength: 1180,
              idTokenFound: true,
            },
          ],
          logger: 'console',
        },
      },
      { category: 'navigation', data: { from: '/auth/callback', to: '/dashboard' } },
      {
        category: 'fetch',
        type: 'http',
        data: { method: 'GET', url: `/api/record/shared/${FILTERED}`, status_code: 200 },
      },
      { category: 'sentry.event', message: `Error: Invalid JWT: ${FILTERED}` },
    ]);
    const sent = JSON.stringify(scrubbed);
    expect(sent).not.toContain(JWT_PAYLOAD);
    expect(sent).not.toContain(FAKE_SHARE_TOKEN);
  });

  it("strips Meta's verify token from a server error on the webhook's GET", () => {
    // onRequestError: Next passes req.url, query string included, as the path.
    const event: Event = {
      exception: { values: [{ type: 'Error', value: 'boom' }] },
      transaction: 'GET /api/whatsapp/webhook',
      request: {
        url: `${SITE}/api/whatsapp/webhook?${WEBHOOK_QUERY}`,
        method: 'GET',
        query_string: WEBHOOK_QUERY,
        headers: { host: 'njangionchain.com' },
      },
      contexts: {
        nextjs: {
          request_path: `/api/whatsapp/webhook?${WEBHOOK_QUERY}`,
          router_kind: 'Pages Router',
          router_path: '/api/whatsapp/webhook',
          route_type: 'route',
        },
      },
    };

    const scrubbed = scrubSentryEvent(event);

    expect(scrubbed.request).toEqual({
      url: `${SITE}/api/whatsapp/webhook?${WEBHOOK_QUERY_SCRUBBED}`,
      method: 'GET',
      query_string: WEBHOOK_QUERY_SCRUBBED,
      headers: { host: 'njangionchain.com' },
    });
    expect(scrubbed.contexts?.nextjs).toEqual({
      request_path: `/api/whatsapp/webhook?${WEBHOOK_QUERY_SCRUBBED}`,
      router_kind: 'Pages Router',
      router_path: '/api/whatsapp/webhook',
      route_type: 'route',
    });
    expect(scrubbed.transaction).toBe('GET /api/whatsapp/webhook');
    expect(JSON.stringify(scrubbed)).not.toContain(FAKE_VERIFY_TOKEN);
  });

  it('keeps query parameter names in the object and pair forms of query_string', () => {
    expect(
      scrubSentryEvent({ request: { query_string: { code: 'abc', state: 'xyz' } } }).request,
    ).toEqual({ query_string: { code: FILTERED, state: FILTERED } });
    expect(
      scrubSentryEvent({
        request: {
          query_string: [
            ['code', 'abc'],
            ['state', 'xyz'],
          ],
        },
      }).request,
    ).toEqual({
      query_string: [
        ['code', FILTERED],
        ['state', FILTERED],
      ],
    });
  });

  it('strips query strings, fragments and share tokens from transactions and spans', () => {
    const event: Event = {
      type: 'transaction',
      transaction: `/record/s/${FAKE_SHARE_TOKEN}`,
      request: { url: `${SITE}/record/s/${FAKE_SHARE_TOKEN}#section` },
      contexts: {
        trace: {
          trace_id: 'trace',
          span_id: 'root',
          data: {
            'url.full': `${SITE}/api/whatsapp/webhook?${WEBHOOK_QUERY}`,
            'http.target': `/api/whatsapp/webhook?${WEBHOOK_QUERY}`,
            'url.query': `?${WEBHOOK_QUERY}`,
            'http.query': WEBHOOK_QUERY,
            'http.request.header.referer': `${SITE}/record/s/${FAKE_SHARE_TOKEN}`,
            'sentry.op': 'http.server',
          },
        },
      },
      spans: [
        {
          trace_id: 'trace',
          span_id: 'child',
          start_timestamp: 0,
          description: `GET ${SITE}/api/record/shared/${FAKE_SHARE_TOKEN}`,
          data: {
            'http.url': `${SITE}/api/record/shared/${FAKE_SHARE_TOKEN}`,
            'http.query': '?a=1',
            'http.fragment': `#id_token=${FAKE_JWT}`,
            'http.response.status_code': 200,
          },
        },
        {
          trace_id: 'trace',
          span_id: 'route',
          start_timestamp: 0,
          description: 'GET /api/record/shared/[token]',
          data: {},
        },
      ],
    };

    const scrubbed = scrubSentryEvent(event);

    expect(scrubbed.transaction).toBe(`/record/s/${FILTERED}`);
    expect(scrubbed.request?.url).toBe(`${SITE}/record/s/${FILTERED}`);
    expect(scrubbed.contexts?.trace?.data).toEqual({
      'url.full': `${SITE}/api/whatsapp/webhook?${WEBHOOK_QUERY_SCRUBBED}`,
      'http.target': `/api/whatsapp/webhook?${WEBHOOK_QUERY_SCRUBBED}`,
      'url.query': `?${WEBHOOK_QUERY_SCRUBBED}`,
      'http.query': WEBHOOK_QUERY_SCRUBBED,
      'http.request.header.referer': `${SITE}/record/s/${FILTERED}`,
      'sentry.op': 'http.server',
    });
    expect(scrubbed.spans?.[0].description).toBe(`GET ${SITE}/api/record/shared/${FILTERED}`);
    expect(scrubbed.spans?.[0].data).toEqual({
      'http.url': `${SITE}/api/record/shared/${FILTERED}`,
      'http.query': `?a=${FILTERED}`,
      'http.response.status_code': 200,
    });
    expect(scrubbed.spans?.[1].description).toBe('GET /api/record/shared/[token]');
  });

  it("scrubs the transaction name in the envelope's trace header without changing the SDK's copy", () => {
    // Seen end to end on `next dev`: the page transaction was named
    // "GET /record/s/[token]" in the payload, but the trace header kept the
    // raw path it was frozen with.
    const dsc = {
      trace_id: 'trace',
      public_key: 'public',
      sampled: 'true',
      transaction: `GET /record/s/${FAKE_SHARE_TOKEN}`,
    };
    const event: Event = {
      type: 'transaction',
      transaction: 'GET /record/s/[token]',
      sdkProcessingMetadata: { dynamicSamplingContext: dsc },
    };

    const scrubbed = scrubSentryEvent(event);

    expect(scrubbed.sdkProcessingMetadata?.dynamicSamplingContext).toEqual({
      ...dsc,
      transaction: `GET /record/s/${FILTERED}`,
    });
    expect(dsc.transaction).toBe(`GET /record/s/${FAKE_SHARE_TOKEN}`);
    // Names that need nothing keep the same object.
    const route = { trace_id: 'trace', transaction: 'GET /api/health' };
    expect(
      scrubSentryEvent({ sdkProcessingMetadata: { dynamicSamplingContext: route } })
        .sdkProcessingMetadata?.dynamicSamplingContext,
    ).toBe(route);
  });

  it('scrubs captured messages', () => {
    expect(scrubSentryEvent({ message: `Login failed for ${FAKE_JWT}` }).message).toBe(
      `Login failed for ${FILTERED}`,
    );
    expect(
      scrubSentryEvent({ logentry: { message: 'Bad token %s', params: [FAKE_JWT, 3] } }).logentry,
    ).toEqual({ message: 'Bad token %s', params: [FILTERED, 3] });
  });

  it('drops a field it cannot scrub and keeps sending the event', () => {
    const request = { method: 'GET' } as NonNullable<Event['request']>;
    Object.defineProperty(request, 'url', {
      enumerable: true,
      configurable: true,
      get() {
        throw new Error('unreadable');
      },
    });
    const data: Record<string, unknown> = {};
    Object.defineProperty(data, 'url', {
      enumerable: true,
      get() {
        throw new Error('unreadable');
      },
    });
    const event: Event = {
      exception: { values: [{ type: 'Error', value: `boom ${FAKE_JWT}` }] },
      request,
      breadcrumbs: [{ category: 'fetch', message: `GET ?code=abc`, data }],
    };

    const scrubbed = scrubSentryEvent(event);

    expect(scrubbed).toBe(event);
    expect(scrubbed.request).toBeUndefined();
    expect(scrubbed.breadcrumbs).toEqual([{ category: 'fetch', message: `GET ?code=${FILTERED}` }]);
    expect(scrubbed.exception?.values?.[0].value).toBe(`boom ${FILTERED}`);
    expect(scrubbed.tags?.[DROPPED_FIELDS_TAG]).toBe('request,breadcrumbs.data');
  });
});

describe('scrubSentryBreadcrumb', () => {
  it("scrubs the message and top-level data without changing the app's objects", () => {
    const callbackUrl = `${SITE}/auth/callback#id_token=${FAKE_JWT}`;
    const urlInfo = { fullUrl: callbackUrl };
    const args = ['Callback URL:', callbackUrl, urlInfo];
    const breadcrumb: Breadcrumb = {
      timestamp: 1,
      category: 'console',
      level: 'log',
      message: `Callback URL: ${callbackUrl} [object Object]`,
      data: { arguments: args, logger: 'console' },
    };

    const result = scrubSentryBreadcrumb(breadcrumb);

    expect(result.message).toBe(`Callback URL: ${SITE}/auth/callback [object Object]`);
    expect(result.data).toEqual({
      arguments: ['Callback URL:', `${SITE}/auth/callback`, urlInfo],
      logger: 'console',
    });
    // The live object is passed through for beforeSend to scrub in the
    // SDK's normalized copy; the app's own array and object are untouched.
    expect(result.data?.arguments[2]).toBe(urlInfo);
    expect(args[1]).toBe(callbackUrl);
    expect(urlInfo.fullUrl).toBe(callbackUrl);
  });

  it('scrubs navigation, fetch and outgoing http breadcrumbs', () => {
    expect(
      scrubSentryBreadcrumb({
        category: 'navigation',
        data: { from: `/auth/callback#id_token=${FAKE_JWT}`, to: `/record/s/${FAKE_SHARE_TOKEN}` },
      }).data,
    ).toEqual({ from: '/auth/callback', to: `/record/s/${FILTERED}` });
    expect(
      scrubSentryBreadcrumb({
        category: 'http',
        type: 'http',
        data: {
          url: 'https://graph.facebook.com/v21.0/123456789012345/messages',
          'http.method': 'POST',
          'http.query': '?access_token=fake-access-token',
          'http.fragment': '#fake',
          status_code: 200,
        },
      }).data,
    ).toEqual({
      url: 'https://graph.facebook.com/v21.0/123456789012345/messages',
      'http.method': 'POST',
      'http.query': `?access_token=${FILTERED}`,
      status_code: 200,
    });
  });

  it('drops data it cannot read and keeps the breadcrumb', () => {
    const data: Record<string, unknown> = {};
    Object.defineProperty(data, 'url', {
      enumerable: true,
      get() {
        throw new Error('unreadable');
      },
    });
    const result = scrubSentryBreadcrumb({ category: 'xhr', message: `token ${FAKE_JWT}`, data });
    expect(result).toEqual({ category: 'xhr', message: `token ${FILTERED}` });
  });
});

describe('runtime configs', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    for (const name of ['SENTRY_DSN', 'NEXT_PUBLIC_SENTRY_DSN']) {
      if (ORIGINAL_ENV[name] === undefined) delete process.env[name];
      else process.env[name] = ORIGINAL_ENV[name];
    }
  });

  it.each([
    ['../../sentry.server.config', 'SENTRY_DSN'],
    ['../../sentry.edge.config', 'SENTRY_DSN'],
    ['../../../sentry.client.config', 'NEXT_PUBLIC_SENTRY_DSN'],
  ])('%s scrubs errors, transactions and breadcrumbs before sending', (configPath, dsnVar) => {
    process.env[dsnVar] = 'https://public@o0.ingest.sentry.io/0';
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
          beforeBreadcrumb: filters.scrubSentryBreadcrumb,
        }),
      );
    });
  });
});
