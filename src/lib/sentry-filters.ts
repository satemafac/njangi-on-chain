// sentry-filters.ts — what the server and edge Sentry clients may report and
// send. Pure (type-only Sentry import), so instrumentation.ts can use it in
// both runtimes.
//
// `sendDefaultPii: false` does not keep request data out of server events.
// Checked on @sentry/nextjs 10.57 against JAVASCRIPT-NEXTJS-A and stored
// spans (2026-10-02):
//   * error events carry the request body (the http integration buffers up
//     to 10 KB whatever sendDefaultPii says), every cookie, and every header
//     except a fixed list of standard IP headers. Vercel's
//     x-vercel-proxied-for (the client IP) and x-vercel-ip-* (city,
//     latitude, longitude, postal code) are not on that list;
//   * sampled transactions keep the span header attributes the SDK's deny
//     list misses, x-vercel-proxied-for among them.
// Sentry's ingest filters names that look like credentials (Authorization,
// the OIDC token), but only after they have left our servers.
// scrubSentryEvent removes all of it before sending instead.

import type { Event } from '@sentry/nextjs';

/**
 * True for the errors Next's pages-API body parser throws on a malformed
 * request body (next/dist/server/api-utils/node/parse-body). Next has
 * already answered 400 when it passes them to onRequestError, so they are
 * the client's mistake, not a server fault: JAVASCRIPT-NEXTJS-A was a curl
 * POST of `not json`. Oversized bodies (413) are still reported, since our
 * own pages could outgrow the 1 MB limit.
 */
export function isNextBodyParseError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as { statusCode?: unknown }).statusCode === 400 &&
    (error.message === 'Invalid JSON' || error.message === 'Invalid body')
  );
}

/**
 * Request headers an event may keep. An allowlist, because the private ones
 * keep turning up under new names: credentials (authorization,
 * x-internal-auth, x-hub-signature-256, Vercel's OIDC token), cookies, and
 * the client's IP address and location.
 */
const KEPT_REQUEST_HEADERS = new Set([
  'accept',
  'accept-encoding',
  'accept-language',
  'content-length',
  'content-type',
  'host',
  'origin',
  'referer',
  'user-agent',
  'x-matched-path',
  'x-vercel-deployment-url',
  'x-vercel-id',
]);

const REQUEST_HEADER_ATTRIBUTE = 'http.request.header.';

function scrubSpanData(data: Record<string, unknown> | undefined): void {
  if (!data) return;
  for (const key of Object.keys(data)) {
    if (key.startsWith(REQUEST_HEADER_ATTRIBUTE)) {
      // Span attributes spell headers with underscores, and cookies as
      // `http.request.header.cookie.<name>`.
      const header = key
        .slice(REQUEST_HEADER_ATTRIBUTE.length)
        .split('.')[0]
        .replace(/_/g, '-');
      if (!KEPT_REQUEST_HEADERS.has(header)) delete data[key];
    } else if (
      key === 'http.request.body.data' ||
      key.startsWith('http.response.header.set_cookie')
    ) {
      delete data[key];
    }
  }
}

/**
 * beforeSend / beforeSendTransaction for the server and edge clients: drops
 * the request body and cookies, every request header outside
 * KEPT_REQUEST_HEADERS, and the matching span attributes.
 */
export function scrubSentryEvent<T extends Event>(event: T): T {
  const request = event.request;
  if (request) {
    delete request.data;
    delete request.cookies;
    if (request.headers) {
      for (const name of Object.keys(request.headers)) {
        if (!KEPT_REQUEST_HEADERS.has(name.toLowerCase())) delete request.headers[name];
      }
    }
  }
  scrubSpanData(event.contexts?.trace?.data);
  for (const span of event.spans ?? []) scrubSpanData(span.data);
  return event;
}
