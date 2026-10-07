/**
 * /api/sui-price never answers without a number. The create form converts
 * the organizer's amount to SUI with it ONCE and package v11 pins that SUI
 * amount for the life of the circle, so each answer must say what kind of
 * number it is: a live quote, a cached quote (and how old), or the
 * hardcoded FALLBACK_PRICE that nobody quoted. Before this, the fallback
 * came back as `stale: true` with a 200, indistinguishable from a cached
 * quote, and circles got pinned to 3.71.
 */

import type { NextApiRequest, NextApiResponse } from 'next';

type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;

type PriceBody = {
  success: boolean;
  data?: {
    price: number;
    source: string;
    stale: boolean;
    fallback: boolean;
    fetchedAt?: number;
  };
  message?: string;
};

interface MockRes {
  statusCode: number;
  jsonBody: PriceBody | undefined;
}

function createMockRes(): NextApiResponse & MockRes {
  const res = {
    statusCode: 0,
    jsonBody: undefined as PriceBody | undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: PriceBody) {
      this.jsonBody = body;
      return this;
    },
  };
  return res as unknown as NextApiResponse & MockRes;
}

function createReq(method = 'GET'): NextApiRequest {
  return { method, headers: {}, query: {}, cookies: {} } as unknown as NextApiRequest;
}

// The handler keeps its last live quote in module state, so every test
// loads a fresh copy of the module.
function freshHandler(): Handler {
  let handler: Handler | undefined;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    handler = (require('@/pages/api/sui-price') as { default: Handler }).default;
  });
  if (!handler) throw new Error('handler did not load');
  return handler;
}

const T0 = 1_760_000_000_000;
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const upstreamsDown = async () => new Response('upstream down', { status: 503 });
const coinGeckoQuotes = (usd: number) => async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.includes('coingecko')) {
    return new Response(JSON.stringify({ sui: { usd } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  return new Response('upstream down', { status: 503 });
};

describe('/api/sui-price provenance', () => {
  const realFetch = global.fetch;
  let nowSpy: jest.SpyInstance<number, []>;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    nowSpy = jest.spyOn(Date, 'now').mockReturnValue(T0);
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    global.fetch = realFetch;
    nowSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('marks the hardcoded number as the fallback, with no quote time, still at 200', async () => {
    global.fetch = upstreamsDown as typeof fetch;
    const handler = freshHandler();

    const res = createMockRes();
    await handler(createReq(), res);

    // 200 on purpose: the only caller (price-service.ts) reads a non-2xx as
    // "no answer" and substitutes its own copy of this number, losing the flag.
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody).toEqual({
      success: true,
      data: { price: 3.71, source: 'fallback', stale: true, fallback: true },
      message: expect.stringContaining('fallback'),
    });
    expect(res.jsonBody?.data).not.toHaveProperty('fetchedAt');
  });

  it('marks a live quote as neither stale nor fallback and dates it', async () => {
    global.fetch = coinGeckoQuotes(1.37) as typeof fetch;
    const handler = freshHandler();

    const res = createMockRes();
    await handler(createReq(), res);

    expect(res.statusCode).toBe(200);
    expect(res.jsonBody).toEqual({
      success: true,
      data: { price: 1.37, source: 'CoinGecko', stale: false, fallback: false, fetchedAt: T0 },
    });
  });

  it('serves the five-minute server cache as fresh, dated by the quote', async () => {
    global.fetch = coinGeckoQuotes(1.37) as typeof fetch;
    const handler = freshHandler();
    await handler(createReq(), createMockRes());

    nowSpy.mockReturnValue(T0 + 2 * MINUTE);
    global.fetch = upstreamsDown as typeof fetch;
    const res = createMockRes();
    await handler(createReq(), res);

    expect(res.jsonBody?.data).toEqual({
      price: 1.37,
      source: 'CoinGecko (server-cache)',
      stale: false,
      fallback: false,
      fetchedAt: T0,
    });
  });

  it('serves a quote under six hours old as stale but not fallback, dated by the quote', async () => {
    global.fetch = coinGeckoQuotes(1.37) as typeof fetch;
    const handler = freshHandler();
    await handler(createReq(), createMockRes());

    nowSpy.mockReturnValue(T0 + 5 * HOUR);
    global.fetch = upstreamsDown as typeof fetch;
    const res = createMockRes();
    await handler(createReq(), res);

    expect(res.statusCode).toBe(200);
    expect(res.jsonBody?.data).toEqual({
      price: 1.37,
      source: 'CoinGecko (stale-cache)',
      stale: true,
      fallback: false,
      fetchedAt: T0,
    });
    expect(res.jsonBody?.message).toContain('stale');
  });

  it('drops to the fallback once the last quote is older than six hours', async () => {
    global.fetch = coinGeckoQuotes(1.37) as typeof fetch;
    const handler = freshHandler();
    await handler(createReq(), createMockRes());

    nowSpy.mockReturnValue(T0 + 6 * HOUR + MINUTE);
    global.fetch = upstreamsDown as typeof fetch;
    const res = createMockRes();
    await handler(createReq(), res);

    expect(res.jsonBody?.data).toEqual({ price: 3.71, source: 'fallback', stale: true, fallback: true });
  });

  it('refuses anything but GET', async () => {
    const handler = freshHandler();
    const res = createMockRes();
    await handler(createReq('POST'), res);
    expect(res.statusCode).toBe(405);
    expect(res.jsonBody?.success).toBe(false);
  });
});
