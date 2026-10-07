/**
 * POST /api/onramp/moonpay/session tests — the fallback ramp's session route
 * must refuse disabled/invalid requests, block embargoed locations on the
 * edge headers, and screen the DESTINATION WALLET (fail closed) before any
 * signed widget URL is minted.
 *
 * Until 2026-10 this route checked the IP country only, while
 * docs/sanctions-program.md listed every `api/onramp/*\/session.ts` as
 * wallet-screened. The screen's status/code/message must match the
 * Coinbase route exactly (src/lib/ramp-wallet-screen.ts).
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import handler from '@/pages/api/onramp/moonpay/session';

const mockScreenAddress = jest.fn();
const mockCreateMoonPaySession = jest.fn();

// The route screens the destination wallet and fails CLOSED, so without a
// stub every test here would 503 on "Postgres not configured" rather than
// exercising the path it cares about.
jest.mock('@/lib/sanctions', () => ({
  screenAddress: (...args: unknown[]) => mockScreenAddress(...args),
}));

// The builder signs a MoonPay URL with MOONPAY_SECRET_KEY. These tests care
// about whether it is reached, not about the URL, so it is stubbed.
jest.mock('@/services/moonpay-service', () => ({
  createMoonPaySession: (...args: unknown[]) => mockCreateMoonPaySession(...args),
}));

type MockResponse = NextApiResponse & {
  statusCode: number;
  body: unknown;
};

const MEMBER_WALLET =
  '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcd';

const SESSION_RESULT = {
  provider: 'moonpay',
  url: 'https://buy-sandbox.moonpay.com/?apiKey=pk_test&signature=sig',
  assetIntent: 'USDC_ON_SUI',
};

function createMockRequest(input: {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
}): NextApiRequest {
  return {
    method: input.method ?? 'POST',
    body: input.body ?? {},
    headers: input.headers ?? {},
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

describe('POST /api/onramp/moonpay/session', () => {
  let savedEnabled: string | undefined;

  beforeEach(() => {
    savedEnabled = process.env.NEXT_PUBLIC_MOONPAY_ENABLED;
    process.env.NEXT_PUBLIC_MOONPAY_ENABLED = 'true';
    mockScreenAddress.mockResolvedValue({ blocked: false, listVersion: '2026-10-01' });
    mockCreateMoonPaySession.mockReturnValue(SESSION_RESULT);
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    if (savedEnabled === undefined) delete process.env.NEXT_PUBLIC_MOONPAY_ENABLED;
    else process.env.NEXT_PUBLIC_MOONPAY_ENABLED = savedEnabled;
  });

  it('rejects non-POST methods', async () => {
    const res = createMockResponse();
    await handler(createMockRequest({ method: 'GET' }), res);
    expect(res.statusCode).toBe(405);
    expect(mockScreenAddress).not.toHaveBeenCalled();
  });

  it('returns 503 MOONPAY_DISABLED when the public flag is off', async () => {
    process.env.NEXT_PUBLIC_MOONPAY_ENABLED = 'false';
    const res = createMockResponse();
    await handler(createMockRequest({ body: validBody() }), res);

    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual(expect.objectContaining({ error: 'MOONPAY_DISABLED' }));
    expect(mockCreateMoonPaySession).not.toHaveBeenCalled();
  });

  it('rejects missing walletAddress / preferredAssetIntent', async () => {
    const res = createMockResponse();
    await handler(createMockRequest({ body: {} }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual(expect.objectContaining({ error: 'INVALID_REQUEST' }));
    expect(mockScreenAddress).not.toHaveBeenCalled();
  });

  it('rejects a non-string walletAddress before the wallet screen', async () => {
    const res = createMockResponse();
    await handler(
      createMockRequest({ body: validBody({ walletAddress: { toString: 'x' } }) }),
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(mockScreenAddress).not.toHaveBeenCalled();
  });

  it('mints the signed URL on the happy path', async () => {
    const res = createMockResponse();
    await handler(createMockRequest({ body: validBody() }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(SESSION_RESULT);
    expect(mockCreateMoonPaySession).toHaveBeenCalledWith(
      expect.objectContaining({
        walletAddress: MEMBER_WALLET,
        preferredAssetIntent: 'USDC_ON_SUI',
      }),
    );
  });
});

describe('POST /api/onramp/moonpay/session — geo block', () => {
  let savedEnabled: string | undefined;

  beforeEach(() => {
    savedEnabled = process.env.NEXT_PUBLIC_MOONPAY_ENABLED;
    process.env.NEXT_PUBLIC_MOONPAY_ENABLED = 'true';
    mockScreenAddress.mockResolvedValue({ blocked: false, listVersion: '2026-10-01' });
    mockCreateMoonPaySession.mockReturnValue(SESSION_RESULT);
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    if (savedEnabled === undefined) delete process.env.NEXT_PUBLIC_MOONPAY_ENABLED;
    else process.env.NEXT_PUBLIC_MOONPAY_ENABLED = savedEnabled;
  });

  it.each(['IR', 'KP', 'SY', 'CU'])(
    'refuses an embargoed IP country (%s) before screening or minting',
    async (country) => {
      const res = createMockResponse();
      await handler(
        createMockRequest({
          body: validBody(),
          headers: { 'x-vercel-ip-country': country },
        }),
        res,
      );

      expect(res.statusCode).toBe(403);
      expect(res.body).toEqual(
        expect.objectContaining({ provider: 'moonpay', error: 'BLOCKED_REGION' }),
      );
      expect(mockScreenAddress).not.toHaveBeenCalled();
      expect(mockCreateMoonPaySession).not.toHaveBeenCalled();
    },
  );

  it.each(['RU', 'BY'])('refuses the ramp-only extra %s', async (country) => {
    const res = createMockResponse();
    await handler(
      createMockRequest({
        body: validBody(),
        headers: { 'x-vercel-ip-country': country },
      }),
      res,
    );
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual(expect.objectContaining({ error: 'BLOCKED_REGION' }));
    expect(mockCreateMoonPaySession).not.toHaveBeenCalled();
  });

  it('refuses an embargoed Ukrainian region from the region header', async () => {
    const res = createMockResponse();
    await handler(
      createMockRequest({
        body: validBody(),
        headers: { 'x-vercel-ip-country': 'UA', 'x-vercel-ip-country-region': '43' },
      }),
      res,
    );
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual(expect.objectContaining({ error: 'BLOCKED_REGION' }));
    expect(mockCreateMoonPaySession).not.toHaveBeenCalled();
  });

  it('leaves the rest of Ukraine open', async () => {
    const res = createMockResponse();
    await handler(
      createMockRequest({
        body: validBody(),
        headers: { 'x-vercel-ip-country': 'UA', 'x-vercel-ip-country-region': '30' },
      }),
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(mockCreateMoonPaySession).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/onramp/moonpay/session — wallet sanctions screen', () => {
  let savedEnabled: string | undefined;

  beforeEach(() => {
    savedEnabled = process.env.NEXT_PUBLIC_MOONPAY_ENABLED;
    process.env.NEXT_PUBLIC_MOONPAY_ENABLED = 'true';
    mockScreenAddress.mockResolvedValue({ blocked: false, listVersion: '2026-10-01' });
    mockCreateMoonPaySession.mockReturnValue(SESSION_RESULT);
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    if (savedEnabled === undefined) delete process.env.NEXT_PUBLIC_MOONPAY_ENABLED;
    else process.env.NEXT_PUBLIC_MOONPAY_ENABLED = savedEnabled;
  });

  it('refuses a listed destination wallet and mints no URL', async () => {
    // Geo-blocking alone misses this: a listed address funding itself from a
    // permitted jurisdiction. Same status, code and copy as the Coinbase route.
    mockScreenAddress.mockResolvedValue({
      blocked: true,
      listVersion: '2026-10-01',
      reason: 'hit',
    });

    const res = createMockResponse();
    await handler(createMockRequest({ body: validBody() }), res);

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({
      provider: 'moonpay',
      error: 'SANCTIONS_BLOCKED',
      message: "This wallet can't use Njangi On-Chain.",
    });
    expect(mockCreateMoonPaySession).not.toHaveBeenCalled();
  });

  it('fails CLOSED with a retryable 503 when screening is unavailable', async () => {
    // Distinct from a match: the user is not refused, the check could not
    // run. Saying 403 here would tell an innocent user they are banned.
    mockScreenAddress.mockResolvedValue({
      blocked: true,
      listVersion: null,
      reason: 'unavailable',
    });

    const res = createMockResponse();
    await handler(createMockRequest({ body: validBody() }), res);

    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({
      provider: 'moonpay',
      error: 'SCREENING_UNAVAILABLE',
      message:
        'We could not complete a required compliance check. Please try again shortly.',
    });
    expect(mockCreateMoonPaySession).not.toHaveBeenCalled();
  });

  it('screens the wallet as a new commitment (failClosed) and then proceeds to the builder', async () => {
    const res = createMockResponse();
    await handler(createMockRequest({ body: validBody() }), res);

    expect(mockScreenAddress).toHaveBeenCalledWith(MEMBER_WALLET, 'ramp_session', {
      failClosed: true,
    });
    expect(res.statusCode).toBe(200);
    expect(mockCreateMoonPaySession).toHaveBeenCalledTimes(1);
    // Order matters: the screen runs before anything is signed.
    expect(mockScreenAddress.mock.invocationCallOrder[0]).toBeLessThan(
      mockCreateMoonPaySession.mock.invocationCallOrder[0],
    );
  });
});
