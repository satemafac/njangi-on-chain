/**
 * GET /api/onramp/geo tests — server-side country detection + authoritative
 * provider availability for the geo-aware ramp picker.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import handler from '@/pages/api/onramp/geo';

type MockResponse = NextApiResponse & {
  statusCode: number;
  body: unknown;
};

function createMockRequest(input: {
  method?: string;
  headers?: Record<string, string | string[]>;
}): NextApiRequest {
  return {
    method: input.method ?? 'GET',
    headers: input.headers ?? {},
  } as unknown as NextApiRequest;
}

function createMockResponse(): MockResponse {
  const headers = new Map<string, string>();
  const res = {
    statusCode: 200,
    body: undefined as unknown,
  } as MockResponse;

  (res as unknown as { setHeader: unknown }).setHeader = jest.fn(
    (key: string, value: string | number | readonly string[]) => {
      const normalized = Array.isArray(value) ? value.join(',') : String(value);
      headers.set(key.toLowerCase(), normalized);
      return res;
    },
  );
  (res as unknown as { getHeader: unknown }).getHeader = jest.fn((key: string) =>
    headers.get(key.toLowerCase()),
  );
  (res as unknown as { status: unknown }).status = jest.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  (res as unknown as { json: unknown }).json = jest.fn((payload: unknown) => {
    res.body = payload;
    return res;
  });
  (res as unknown as { end: unknown }).end = jest.fn(() => res);

  return res;
}

const ENV_KEYS = [
  'NEXT_PUBLIC_COINBASE_ONRAMP_ENABLED',
  'NEXT_PUBLIC_MOONPAY_ENABLED',
  'NEXT_PUBLIC_TRANSAK_ENABLED',
  'NEXT_PUBLIC_MOONPAY_API_KEY',
  'MOONPAY_SECRET_KEY',
  'NEXT_PUBLIC_TRANSAK_API_KEY',
  'TRANSAK_API_SECRET',
  'CDP_API_KEY_ID',
  'CDP_API_KEY_SECRET',
] as const;

describe('GET /api/onramp/geo', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('rejects non-GET methods', () => {
    const res = createMockResponse();
    handler(createMockRequest({ method: 'POST' }), res);
    expect(res.statusCode).toBe(405);
  });

  it('returns the country from x-vercel-ip-country', () => {
    const res = createMockResponse();
    handler(
      createMockRequest({ headers: { 'x-vercel-ip-country': 'CM' } }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({ country: 'CM', source: 'header' }),
    );
  });

  it('normalizes lower-case header values', () => {
    const res = createMockResponse();
    handler(
      createMockRequest({ headers: { 'x-vercel-ip-country': 'us' } }),
      res,
    );
    expect(res.body).toEqual(
      expect.objectContaining({ country: 'US', source: 'header' }),
    );
  });

  it('reports unknown when the header is missing or malformed', () => {
    const res = createMockResponse();
    handler(createMockRequest({}), res);
    expect(res.body).toEqual(
      expect.objectContaining({ country: null, source: 'unknown' }),
    );

    const malformed = createMockResponse();
    handler(
      createMockRequest({ headers: { 'x-vercel-ip-country': 'NOPE' } }),
      malformed,
    );
    expect(malformed.body).toEqual(
      expect.objectContaining({ country: null, source: 'unknown' }),
    );
  });

  it('never caches the per-user response in shared caches', () => {
    const res = createMockResponse();
    handler(createMockRequest({}), res);
    expect(res.getHeader('cache-control')).toContain('no-store');
  });

  it('reports provider availability gated on server secrets', () => {
    process.env.NEXT_PUBLIC_TRANSAK_ENABLED = 'true';
    process.env.NEXT_PUBLIC_MOONPAY_ENABLED = 'true';
    // Transak has its secrets; MoonPay is flag-only (secret-less).
    process.env.NEXT_PUBLIC_TRANSAK_API_KEY = 'pk_transak';
    process.env.TRANSAK_API_SECRET = 'transak-secret';

    const res = createMockResponse();
    handler(createMockRequest({}), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        providers: { coinbase: false, moonpay: false, transak: true },
      }),
    );
  });

  it('never leaks secret values — booleans only', () => {
    process.env.NEXT_PUBLIC_TRANSAK_ENABLED = 'true';
    process.env.NEXT_PUBLIC_TRANSAK_API_KEY = 'pk_transak';
    process.env.TRANSAK_API_SECRET = 'super-secret-value';

    const res = createMockResponse();
    handler(createMockRequest({}), res);

    expect(JSON.stringify(res.body)).not.toContain('super-secret-value');
  });
});
