/**
 * POST /api/onramp/transak/session tests — the CEMAC-primary provider's
 * session route must fail closed without its webhook secret, validate
 * input, and mint staging vs production widget URLs by env flag.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import handler from '@/pages/api/onramp/transak/session';

type MockResponse = NextApiResponse & {
  statusCode: number;
  body: unknown;
};

const MEMBER_WALLET =
  '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcd';

function createMockRequest(input: {
  method?: string;
  body?: unknown;
}): NextApiRequest {
  return {
    method: input.method ?? 'POST',
    body: input.body ?? {},
    headers: {},
  } as unknown as NextApiRequest;
}

function createMockResponse(): MockResponse {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
  } as MockResponse;

  (res as unknown as { setHeader: unknown }).setHeader = jest.fn(() => res);
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

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    walletAddress: MEMBER_WALLET,
    preferredAssetIntent: 'USDC_ON_SUI',
    ...overrides,
  };
}

const ENV_KEYS = [
  'NEXT_PUBLIC_TRANSAK_ENABLED',
  'NEXT_PUBLIC_TRANSAK_API_KEY',
  'TRANSAK_API_SECRET',
  'TRANSAK_ENVIRONMENT',
  'NEXT_PUBLIC_SUI_NETWORK',
] as const;

describe('POST /api/onramp/transak/session', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    process.env.NEXT_PUBLIC_TRANSAK_ENABLED = 'true';
    process.env.NEXT_PUBLIC_TRANSAK_API_KEY = 'pk_transak_test';
    process.env.TRANSAK_API_SECRET = 'transak-secret';
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('rejects non-POST methods', async () => {
    const res = createMockResponse();
    await handler(createMockRequest({ method: 'GET' }), res);
    expect(res.statusCode).toBe(405);
  });

  it('returns 503 TRANSAK_DISABLED when the public flag is off', async () => {
    process.env.NEXT_PUBLIC_TRANSAK_ENABLED = 'false';
    const res = createMockResponse();
    await handler(createMockRequest({ body: validBody() }), res);

    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual(
      expect.objectContaining({ error: 'TRANSAK_DISABLED' }),
    );
  });

  it('returns 503 when the flag is on but TRANSAK_API_SECRET is unset (fail closed)', async () => {
    delete process.env.TRANSAK_API_SECRET;
    const res = createMockResponse();
    await handler(createMockRequest({ body: validBody() }), res);

    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual(
      expect.objectContaining({ error: 'TRANSAK_DISABLED' }),
    );
  });

  it('rejects missing walletAddress / preferredAssetIntent', async () => {
    const res = createMockResponse();
    await handler(createMockRequest({ body: {} }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual(
      expect.objectContaining({ error: 'INVALID_REQUEST' }),
    );
  });

  it('rejects a malformed wallet address', async () => {
    const res = createMockResponse();
    await handler(
      createMockRequest({
        body: validBody({ walletAddress: 'javascript:alert(1)' }),
      }),
      res,
    );
    expect(res.statusCode).toBe(400);
  });

  it('rejects an unknown asset intent', async () => {
    const res = createMockResponse();
    await handler(
      createMockRequest({ body: validBody({ preferredAssetIntent: 'BTC' }) }),
      res,
    );
    expect(res.statusCode).toBe(400);
  });

  it('rejects non-positive fiat amounts', async () => {
    const res = createMockResponse();
    await handler(
      createMockRequest({ body: validBody({ fiatAmount: -5 }) }),
      res,
    );
    expect(res.statusCode).toBe(400);
  });

  it('rejects malformed fiat currency and country codes', async () => {
    const badCurrency = createMockResponse();
    await handler(
      createMockRequest({ body: validBody({ fiatCurrency: 'FRANC' }) }),
      badCurrency,
    );
    expect(badCurrency.statusCode).toBe(400);

    const badCountry = createMockResponse();
    await handler(
      createMockRequest({ body: validBody({ countryCode: 'CMR' }) }),
      badCountry,
    );
    expect(badCountry.statusCode).toBe(400);
  });

  it('rejects non-https redirect URLs', async () => {
    const res = createMockResponse();
    await handler(
      createMockRequest({
        body: validBody({ redirectURL: 'http://evil.example.com/phish' }),
      }),
      res,
    );
    expect(res.statusCode).toBe(400);
  });

  it('mints a staging widget URL with XAF + CM parameters (CEMAC happy path)', async () => {
    const res = createMockResponse();
    await handler(
      createMockRequest({
        body: validBody({ fiatCurrency: 'xaf', countryCode: 'cm', fiatAmount: 25000 }),
      }),
      res,
    );

    expect(res.statusCode).toBe(200);
    const body = res.body as { provider: string; url: string; assetIntent: string };
    expect(body.provider).toBe('transak');
    expect(body.assetIntent).toBe('USDC_ON_SUI');

    const url = new URL(body.url);
    // Testnet default → Transak STAGING host.
    expect(url.origin).toBe('https://global-stg.transak.com');
    expect(url.searchParams.get('apiKey')).toBe('pk_transak_test');
    expect(url.searchParams.get('network')).toBe('sui');
    expect(url.searchParams.get('cryptoCurrencyCode')).toBe('USDC');
    expect(url.searchParams.get('walletAddress')).toBe(MEMBER_WALLET);
    expect(url.searchParams.get('fiatCurrency')).toBe('XAF');
    expect(url.searchParams.get('countryCode')).toBe('CM');
    expect(url.searchParams.get('fiatAmount')).toBe('25000');
    expect(url.searchParams.get('disableWalletAddressForm')).toBe('true');
  });

  it('honours TRANSAK_ENVIRONMENT=PRODUCTION over the network default', async () => {
    process.env.TRANSAK_ENVIRONMENT = 'PRODUCTION';
    const res = createMockResponse();
    await handler(createMockRequest({ body: validBody() }), res);

    expect(res.statusCode).toBe(200);
    const body = res.body as { url: string };
    expect(new URL(body.url).origin).toBe('https://global.transak.com');
  });

  it('honours TRANSAK_ENVIRONMENT=STAGING even on mainnet', async () => {
    process.env.NEXT_PUBLIC_SUI_NETWORK = 'mainnet';
    process.env.TRANSAK_ENVIRONMENT = 'STAGING';
    const res = createMockResponse();
    await handler(createMockRequest({ body: validBody() }), res);

    expect(res.statusCode).toBe(200);
    const body = res.body as { url: string };
    expect(new URL(body.url).origin).toBe('https://global-stg.transak.com');
  });

  it('falls back to the production host on mainnet without the env flag', async () => {
    process.env.NEXT_PUBLIC_SUI_NETWORK = 'mainnet';
    const res = createMockResponse();
    await handler(createMockRequest({ body: validBody() }), res);

    expect(res.statusCode).toBe(200);
    const body = res.body as { url: string };
    expect(new URL(body.url).origin).toBe('https://global.transak.com');
  });
});
