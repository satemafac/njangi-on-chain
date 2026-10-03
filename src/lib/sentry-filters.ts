// sentry-filters.ts — what the Sentry clients may report and send. Pure
// (type-only Sentry import), so the browser config and instrumentation.ts
// can use it in every runtime.
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
//
// Nor does it keep secrets out of URLs and log lines, in any runtime (same
// SDK, 2026-10-03):
//   * the browser client sends location.href, fragment included, as
//     request.url on every event. On /auth/callback the fragment holds the
//     OAuth id_token, and the navigation breadcrumb away from that page
//     keeps it ("from": "/auth/callback#id_token=…") on every later error in
//     the tab;
//   * console breadcrumbs keep the logged arguments, and the callback page
//     logs the whole URL;
//   * server events keep query strings (request.url, query_string, the
//     onRequestError context's request_path, the url.full and http.target
//     span attributes), such as the hub.verify_token Meta sends the WhatsApp
//     webhook;
//   * a Circle Record share link's token is a path segment
//     (/record/s/<token>, fetched from /api/record/shared/<token>).
// scrubSentryEvent and scrubSentryBreadcrumb drop fragments, keep only the
// names of query parameters, blank share tokens, and redact token-shaped
// strings in messages, exception values, breadcrumbs and span data.
//
// None of it may throw: Sentry drops an event whose beforeSend throws. A step
// that fails drops the field it was scrubbing instead, and names it in the
// event's DROPPED_FIELDS_TAG.

import type { Breadcrumb, Event } from '@sentry/nextjs';

/** What Sentry itself writes in place of a value it filters. */
export const FILTERED = '[Filtered]';

/** Event tag naming the fields a failed scrub step dropped. */
export const DROPPED_FIELDS_TAG = 'scrubber.dropped';

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

// ---------------------------------------------------------------------------
// Secrets in URLs and text
// ---------------------------------------------------------------------------

/**
 * A Circle Record share link shows the record to whoever holds
 * /record/s/<token>, and that page fetches /api/record/shared/<token>
 * (src/lib/circle-record-share.ts): the path segment is the secret.
 */
const SHARE_TOKEN_SEGMENT = /(\/record\/s\/|\/api\/record\/shared\/)([^/?#\s"'<>]+)/g;

/** `scheme://user:password@`, e.g. a database connection string in an error. */
const URL_USERINFO = /\b([a-z][a-z0-9+.-]{1,15}:\/\/)[^\s/?#@"'<>]+@/gi;

/** An absolute URL inside free text. */
const ABSOLUTE_URL = /\b(?:https?|wss?):\/\/[^\s"'<>\\`]+/gi;

/** `?name=value`, `&name=value` or `#name=value` (an OAuth fragment) in free text. */
const URL_PARAM = /([?#&])([^\s=&#?"'<>]+)=[^\s&#"'<>]+/g;

/**
 * A base64url-encoded JSON object: a JWT or JWE (an `eyJ…` header, then
 * dot-separated segments), or one segment of one.
 */
const JWT_LIKE = /eyJ[A-Za-z0-9_-]{16,}(?:\.[A-Za-z0-9_-]*){0,4}/g;

/** An Authorization header value written into a log line. */
const BEARER_CREDENTIAL = /\b(bearer)\s+[A-Za-z0-9._~+/=-]{16,}/gi;

/**
 * Secrets whose bodies are lowercase letters and digits, which the
 * mixed-case test in redactLongRun lets through: Enoki private API keys and
 * Sui private keys (bech32).
 */
const PREFIXED_SECRET = /\b(?:enoki_private_|suiprivkey1)[A-Za-z0-9_-]+/g;

/** A run of standard base64 characters (see redactBase64Run). */
const BASE64_RUN = /[A-Za-z0-9+/]{32,}={0,2}/g;

/** A run of base64url, hex or decimal characters (see redactLongRun). */
const LONG_RUN = /[A-Za-z0-9_-]{32,}/g;

const HEX_OR_DECIMAL = /^[0-9a-fA-F]+$/;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
const MOVE_ADDRESS_LABEL = /address:\s*$/i;
const URL_SHAPED = /^(?:(?:https?|wss?):\/\/|\/|\?)\S*$/i;

/** Longer strings are dropped, not scanned: a log line that long is a data dump. */
const MAX_SCRUBBED_LENGTH = 100_000;

function isMixedCaseWithDigit(value: string): boolean {
  return /[a-z]/.test(value) && /[A-Z]/.test(value) && /[0-9]/.test(value);
}

/** Standard base64 only counts with a `+` or `=` padding, which paths rarely have. */
function redactBase64Run(run: string): string {
  return (run.includes('+') || run.endsWith('=')) && isMixedCaseWithDigit(run) ? FILTERED : run;
}

function redactLongRun(run: string, offset: number, text: string): string {
  // 0x…: Sui object ids, addresses and package ids are public, and they say
  // what an error is about.
  if (/^0x/i.test(run)) return run;
  if (HEX_OR_DECIMAL.test(run)) {
    // Move prints a package address without 0x in aborts ("ModuleId {
    // address: 89cd…, name: …") and in type paths ("89cd…::module::Type").
    if (text.startsWith('::', offset + run.length)) return run;
    if (MOVE_ADDRESS_LABEL.test(text.slice(Math.max(0, offset - 12), offset))) return run;
    // Any other hex or decimal run this long is a digest, an HMAC, a
    // generated secret or a zkLogin salt.
    return FILTERED;
  }
  // Identifiers, CONSTANT_NAMES and slugs. A random token mixes all three.
  if (!isMixedCaseWithDigit(run)) return run;
  // Sui transaction and object digests: base58, 43 or 44 characters.
  if (run.length < 64 && BASE58.test(run)) return run;
  return FILTERED;
}

/** JWTs, bearer credentials, and long hex or base64 secrets anywhere in `text`. */
function redactSecrets(text: string): string {
  let out = text;
  if (out.includes('eyJ')) out = out.replace(JWT_LIKE, FILTERED);
  out = out.replace(PREFIXED_SECRET, FILTERED).replace(BEARER_CREDENTIAL, `$1 ${FILTERED}`);
  if (out.length >= 32) {
    out = out.replace(BASE64_RUN, redactBase64Run).replace(LONG_RUN, redactLongRun);
  }
  return out;
}

function redactShareToken(match: string, prefix: string, segment: string): string {
  // `[token]` or `%5Btoken%5D` is the route (transaction names, chunk paths).
  return segment[0] === '[' || /^%5B/i.test(segment) ? match : `${prefix}${FILTERED}`;
}

/** Every value of a query string (without its `?`) becomes [Filtered]; names stay. */
function scrubQueryString(query: string): string {
  const hash = query.indexOf('#');
  return (hash === -1 ? query : query.slice(0, hash))
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      // A bare value has no name to keep.
      if (eq === -1) return pair === '' ? pair : FILTERED;
      return eq === pair.length - 1 ? pair : `${pair.slice(0, eq)}=${FILTERED}`;
    })
    .join('&');
}

/** A query string with or without its leading `?`. */
function scrubQueryValue(value: string): string {
  if (value.length > MAX_SCRUBBED_LENGTH) return FILTERED;
  return value.startsWith('?') ? `?${scrubQueryString(value.slice(1))}` : scrubQueryString(value);
}

/** Drops the fragment and any credentials, keeps only query names, blanks share tokens. */
function scrubUrlStructure(url: string): string {
  const hash = url.indexOf('#');
  const withoutFragment = hash === -1 ? url : url.slice(0, hash);
  const q = withoutFragment.indexOf('?');
  const path = (q === -1 ? withoutFragment : withoutFragment.slice(0, q))
    .replace(URL_USERINFO, `$1${FILTERED}@`)
    .replace(SHARE_TOKEN_SEGMENT, redactShareToken);
  return q === -1 ? path : `${path}?${scrubQueryString(withoutFragment.slice(q + 1))}`;
}

/**
 * A URL or path: drops the fragment, keeps only the names of query
 * parameters (`?token=[Filtered]`), and blanks share tokens and token-shaped
 * path segments.
 */
export function scrubUrl(url: string): string {
  if (url.length > MAX_SCRUBBED_LENGTH) return FILTERED;
  return redactSecrets(scrubUrlStructure(url));
}

/**
 * Free text (a log line, an error message): URLs in it as scrubUrl does,
 * query strings and fragments written without a host, and token-shaped
 * strings.
 */
export function scrubText(text: string): string {
  if (text.length > MAX_SCRUBBED_LENGTH) return FILTERED;
  let out = text;
  if (out.includes('://')) {
    out = out.replace(URL_USERINFO, `$1${FILTERED}@`).replace(ABSOLUTE_URL, scrubUrlStructure);
  }
  out = out.replace(SHARE_TOKEN_SEGMENT, redactShareToken);
  if (out.includes('=')) out = out.replace(URL_PARAM, `$1$2=${FILTERED}`);
  return redactSecrets(out);
}

/** A string of unknown shape: scrubUrl when it is one URL or path, scrubText otherwise. */
export function scrubString(value: string): string {
  if (value.length > MAX_SCRUBBED_LENGTH) return FILTERED;
  // Too short to hold a token, and no URL punctuation.
  if (value.length < 20 && !/[=?#/]/.test(value)) return value;
  return URL_SHAPED.test(value) ? scrubUrl(value) : scrubText(value);
}

// ---------------------------------------------------------------------------
// Breadcrumb and span data
// ---------------------------------------------------------------------------

/** Span attributes and breadcrumb data keys that hold a URL's fragment or query string. */
const FRAGMENT_KEY = /^(?:http|url)\.fragment$/;
const QUERY_KEY = /^(?:(?:http|url)\.query|query_string)$/;

/** Deeper than the SDK's normalized copies ever go; anything below is dropped, not sent unscanned. */
const MAX_DATA_DEPTH = 10;

/** A scrubbed copy of breadcrumb or span data: every string at any depth; fragments dropped. */
function scrubData(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return scrubString(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DATA_DEPTH) return FILTERED;
  if (Array.isArray(value)) return value.map((item) => scrubData(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (FRAGMENT_KEY.test(key)) continue;
    out[key] =
      typeof item === 'string' && QUERY_KEY.test(key)
        ? scrubQueryValue(item)
        : scrubData(item, depth + 1);
  }
  return out;
}

/**
 * Breadcrumb data as the SDK hands it to beforeBreadcrumb: a copy with the
 * top-level strings scrubbed, and the strings directly inside top-level
 * arrays (console arguments). Anything deeper can be one of the app's live
 * objects, so it is passed through untouched; beforeSend scrubs it once the
 * SDK has normalized a copy into the event.
 */
function scrubDataShallow(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (FRAGMENT_KEY.test(key)) continue;
    if (typeof value === 'string') {
      out[key] = QUERY_KEY.test(key) ? scrubQueryValue(value) : scrubString(value);
    } else if (Array.isArray(value)) {
      out[key] = value.map((item) => (typeof item === 'string' ? scrubString(item) : item));
    } else {
      out[key] = value;
    }
  }
  return out;
}

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
      if (!KEPT_REQUEST_HEADERS.has(header)) {
        delete data[key];
        continue;
      }
    } else if (
      key === 'http.request.body.data' ||
      key.startsWith('http.response.header.set_cookie') ||
      FRAGMENT_KEY.test(key)
    ) {
      delete data[key];
      continue;
    }
    const value = data[key];
    data[key] =
      typeof value === 'string' && QUERY_KEY.test(key) ? scrubQueryValue(value) : scrubData(value);
  }
}

function scrubBreadcrumbFields(
  breadcrumb: Breadcrumb,
  scrubFields: (data: Record<string, unknown>) => unknown,
  onDrop: (field: string) => void,
): void {
  if (typeof breadcrumb.message === 'string') {
    try {
      breadcrumb.message = scrubString(breadcrumb.message);
    } catch {
      delete breadcrumb.message;
      onDrop('breadcrumbs.message');
    }
  }
  if (breadcrumb.data) {
    try {
      breadcrumb.data = scrubFields(breadcrumb.data) as Breadcrumb['data'];
    } catch {
      delete breadcrumb.data;
      onDrop('breadcrumbs.data');
    }
  }
}

/**
 * beforeBreadcrumb for every client. Scrubs the message and the data's
 * top-level strings (navigation from/to, fetch and xhr urls, string console
 * arguments) as the breadcrumb is recorded; scrubSentryEvent scrubs the rest
 * when an event carries it.
 */
export function scrubSentryBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb {
  try {
    scrubBreadcrumbFields(breadcrumb, scrubDataShallow, () => undefined);
    return breadcrumb;
  } catch {
    // Not even the fields could be dropped: keep only what cannot hold a secret.
    return {
      timestamp: breadcrumb.timestamp,
      type: breadcrumb.type,
      category: breadcrumb.category,
      level: breadcrumb.level,
    };
  }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

type QueryParams = NonNullable<NonNullable<Event['request']>['query_string']>;

function scrubQueryParams(query: QueryParams): QueryParams {
  if (typeof query === 'string') return scrubQueryValue(query);
  if (Array.isArray(query)) {
    return query.map((pair): [string, string] => [
      Array.isArray(pair) ? String(pair[0]) : FILTERED,
      FILTERED,
    ]);
  }
  return Object.fromEntries(Object.keys(query).map((name) => [name, FILTERED]));
}

function scrubRequest(event: Event): void {
  const request = event.request;
  if (!request) return;
  delete request.data;
  delete request.cookies;
  if (request.headers) {
    for (const name of Object.keys(request.headers)) {
      const value = request.headers[name];
      if (!KEPT_REQUEST_HEADERS.has(name.toLowerCase())) {
        delete request.headers[name];
      } else if (typeof value === 'string') {
        // Referer is a URL: a share link, or a page with a query string.
        request.headers[name] = scrubString(value);
      }
    }
  }
  if (typeof request.url === 'string') request.url = scrubUrl(request.url);
  if (request.query_string !== undefined && request.query_string !== null) {
    request.query_string = scrubQueryParams(request.query_string);
  }
}

/**
 * Runs one scrub step. If it throws, `drop` removes what the step was
 * scrubbing and DROPPED_FIELDS_TAG names it, so the event still goes out and
 * the gap shows.
 */
function attempt(event: Event, field: string, scrub: () => void, drop: () => void): void {
  try {
    scrub();
  } catch {
    try {
      drop();
    } catch {
      // Nothing more to remove it with.
    }
    noteDropped(event, field);
  }
}

function noteDropped(event: Event, field: string): void {
  try {
    if (!event.tags) event.tags = {};
    const previous = event.tags[DROPPED_FIELDS_TAG];
    event.tags[DROPPED_FIELDS_TAG] = (previous ? `${String(previous)},${field}` : field).slice(0, 200);
  } catch {
    // The event still goes out, without the note.
  }
}

/**
 * beforeSend / beforeSendTransaction for every client.
 *
 * Request data: drops the body and cookies, every request header outside
 * KEPT_REQUEST_HEADERS, and the matching span attributes.
 *
 * Secrets in URLs and text: request.url, query_string, Referer, the
 * onRequestError context's request_path, the transaction name (and its copy
 * in the envelope's trace header), messages, exception values, breadcrumbs,
 * span descriptions and span data lose their fragments, query values, share
 * tokens and token-shaped strings.
 */
export function scrubSentryEvent<T extends Event>(event: T): T {
  attempt(
    event,
    'request',
    () => scrubRequest(event),
    () => {
      delete event.request;
    },
  );
  attempt(
    event,
    'contexts.nextjs',
    () => {
      const nextjs = event.contexts?.nextjs;
      if (nextjs && typeof nextjs.request_path === 'string') {
        nextjs.request_path = scrubUrl(nextjs.request_path);
      }
    },
    () => {
      if (event.contexts) delete event.contexts.nextjs;
    },
  );
  attempt(
    event,
    'transaction',
    () => {
      if (typeof event.transaction === 'string') event.transaction = scrubString(event.transaction);
    },
    () => {
      if (event.transaction !== undefined) event.transaction = FILTERED;
    },
  );
  attempt(
    event,
    'dynamicSamplingContext',
    () => {
      // The envelope header's trace context carries its own copy of the
      // transaction name, frozen before Next parameterizes it, e.g.
      // "GET /record/s/<token>".
      const metadata = event.sdkProcessingMetadata;
      const dsc = metadata?.dynamicSamplingContext;
      if (dsc && typeof dsc.transaction === 'string') {
        const transaction = scrubString(dsc.transaction);
        // A copy: the SDK can share this object with the span.
        if (transaction !== dsc.transaction) {
          metadata.dynamicSamplingContext = { ...dsc, transaction };
        }
      }
    },
    () => {
      if (event.sdkProcessingMetadata) delete event.sdkProcessingMetadata.dynamicSamplingContext;
    },
  );
  attempt(
    event,
    'message',
    () => {
      if (typeof event.message === 'string') event.message = scrubString(event.message);
    },
    () => {
      delete event.message;
    },
  );
  attempt(
    event,
    'logentry',
    () => {
      const logentry = event.logentry;
      if (!logentry) return;
      if (typeof logentry.message === 'string') logentry.message = scrubString(logentry.message);
      if (Array.isArray(logentry.params)) logentry.params = logentry.params.map((p) => scrubData(p));
    },
    () => {
      delete event.logentry;
    },
  );
  attempt(
    event,
    'exception',
    () => {
      for (const exception of event.exception?.values ?? []) {
        if (typeof exception.value === 'string') exception.value = scrubString(exception.value);
      }
    },
    () => {
      try {
        for (const exception of event.exception?.values ?? []) exception.value = FILTERED;
      } catch {
        delete event.exception;
      }
    },
  );
  attempt(
    event,
    'breadcrumbs',
    () => {
      const breadcrumbs = event.breadcrumbs;
      if (!breadcrumbs) return;
      // The SDK has already normalized a copy of each breadcrumb's data into
      // the event, so deep data is safe to rebuild here.
      event.breadcrumbs = breadcrumbs.map((breadcrumb) => {
        const copy = { ...breadcrumb };
        scrubBreadcrumbFields(copy, (data) => scrubData(data), (field) =>
          noteDropped(event, field),
        );
        return copy;
      });
    },
    () => {
      delete event.breadcrumbs;
    },
  );
  attempt(
    event,
    'contexts.trace.data',
    () => scrubSpanData(event.contexts?.trace?.data),
    () => {
      if (event.contexts?.trace) delete event.contexts.trace.data;
    },
  );
  attempt(
    event,
    'spans',
    () => {
      for (const span of event.spans ?? []) {
        if (typeof span.description === 'string') span.description = scrubString(span.description);
        scrubSpanData(span.data);
      }
    },
    () => {
      for (const span of event.spans ?? []) {
        delete span.description;
        span.data = {};
      }
    },
  );
  return event;
}
