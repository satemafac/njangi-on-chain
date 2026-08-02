import type { NextApiRequest, NextApiResponse } from 'next';
import handler from '@/pages/api/onramp/coinbase/session';
import { CoinbaseOnrampError } from '@/services/coinbase-onramp-service';

const mockCreateSessionToken = jest.fn();
const mockScreenAddress = jest.fn();

// The endpoint screens the destination wallet and fails CLOSED, so without a
// stub every test here would 503 on "Postgres not configured" rather than
// exercising the path it cares about.
jest.mock('@/lib/sanctions', () => ({
  screenAddress: (...args: unknown[]) => mockScreenAddress(...args),
}));

jest.mock('@/services/coinbase-onramp-service', () => {
  class MockCoinbaseOnrampError extends Error {
    readonly code: string;
    readonly statusCode: number;
    readonly fallbackProvider: 'moonpay' | null;
    readonly exposeMessage: boolean;

    constructor(
      message: string,
      code: string,
      statusCode: number,
      options?: {
        fallbackProvider?: 'moonpay' | null;
        exposeMessage?: boolean;
      },
    ) {
      super(message);
      this.code = code;
      this.statusCode = statusCode;
      this.fallbackProvider = options?.fallbackProvider ?? 'moonpay';
      this.exposeMessage = options?.exposeMessage ?? false;
    }
  }

  return {
    CoinbaseOnrampService: jest.fn(() => ({
      createSessionToken: mockCreateSessionToken,
    })),
    CoinbaseOnrampError: MockCoinbaseOnrampError,
    maskWalletAddress: (walletAddress: string) =>
      `${walletAddress.slice(0, 8)}...${walletAddress.slice(-4)}`,
  };
});

type MockResponse = NextApiResponse & {
  statusCode: number;
  body: unknown;
};

function createMockRequest(input: {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  ip?: string;
}): NextApiRequest {
  return {
    method: input.method ?? 'POST',
    body: input.body ?? {},
    headers: input.headers ?? {},
    socket: {
      remoteAddress: input.ip ?? '203.0.113.44',
    },
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

describe('POST /api/onramp/coinbase/session', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.COINBASE_ONRAMP_ALLOWED_ORIGINS;
    // The provider flag now gates this endpoint server-side. It defaults OFF,
    // so every test exercising real behaviour must opt in explicitly — the
    // disabled path is covered separately below.
    process.env.NEXT_PUBLIC_COINBASE_ONRAMP_ENABLED = 'true';
    mockScreenAddress.mockResolvedValue({ blocked: false, listVersion: '2026-08-01' });
  });

  afterEach(() => {
    delete process.env.NEXT_PUBLIC_COINBASE_ONRAMP_ENABLED;
  });

  it('refuses when the provider flag is off, even on a valid request', async () => {
    // Regression: this endpoint used to ignore its own flag entirely. The flag
    // hid the launcher in RampPicker while the route stayed callable directly,
    // so the ramp was reachable in an environment that reported it disabled.
    delete process.env.NEXT_PUBLIC_COINBASE_ONRAMP_ENABLED;
    mockCreateSessionToken.mockResolvedValue({
      token: 'session-token',
      channelId: 'channel-1',
      assetIntent: 'USDC_ON_SUI',
    });

    const req = createMockRequest({
      body: {
        walletAddress:
          '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcd',
        preferredAssetIntent: 'USDC_ON_SUI',
        country: 'US',
      },
    });
    const res = createMockResponse();

    await handler(req, res);

    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual(
      expect.objectContaining({ error: 'COINBASE_DISABLED' }),
    );
    // The point of a server-side gate: no session token is ever minted.
    expect(mockCreateSessionToken).not.toHaveBeenCalled();
  });

  it('creates session on happy path', async () => {
    mockCreateSessionToken.mockResolvedValue({
      token: 'session-token',
      channelId: 'channel-1',
      assetIntent: 'USDC_ON_SUI',
    });
    const req = createMockRequest({
      body: {
        walletAddress:
          '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcd',
        preferredAssetIntent: 'USDC_ON_SUI',
        country: 'US',
      },
      headers: {
        'x-correlation-id': 'corr-abc',
      },
    });
    const res = createMockResponse();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.getHeader('x-correlation-id')).toBe('corr-abc');
    expect(res.body).toEqual(
      expect.objectContaining({
        provider: 'coinbase',
        token: 'session-token',
        channelId: 'channel-1',
        assetIntent: 'USDC_ON_SUI',
      }),
    );
    expect(mockCreateSessionToken).toHaveBeenCalledWith(
      expect.objectContaining({
        preferredAssetIntent: 'USDC_ON_SUI',
      }),
    );
  });

  it('returns validation error for invalid wallet address', async () => {
    const req = createMockRequest({
      body: {
        walletAddress: 'bad',
        preferredAssetIntent: 'SUI',
        country: 'US',
      },
    });
    const res = createMockResponse();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual(
      expect.objectContaining({
        error: 'VALIDATION_ERROR',
      }),
    );
    expect(mockCreateSessionToken).not.toHaveBeenCalled();
  });

  it('returns 429 when per-minute ip limit is exceeded', async () => {
    const ip = '203.0.113.201';
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const req = createMockRequest({
        ip,
        body: {
          walletAddress:
            '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          preferredAssetIntent: 'SUI',
          country: 'US',
        },
      });
      const res = createMockResponse();
      await handler(req, res);
      expect(res.statusCode).not.toBe(429);
    }

    const finalReq = createMockRequest({
      ip,
      body: {
        walletAddress:
          '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        preferredAssetIntent: 'SUI',
        country: 'US',
      },
    });
    const finalRes = createMockResponse();
    await handler(finalReq, finalRes);

    expect(finalRes.statusCode).toBe(429);
    expect(finalRes.body).toEqual(
      expect.objectContaining({
        error: 'RATE_LIMITED',
      }),
    );
  });

  it('returns mapped Coinbase upstream error', async () => {
    mockCreateSessionToken.mockRejectedValue(
      new CoinbaseOnrampError(
        'Coinbase request timed out',
        'COINBASE_TIMEOUT',
        504,
      ),
    );
    const req = createMockRequest({
      body: {
        walletAddress:
          '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        preferredAssetIntent: 'SUI',
        country: 'US',
      },
      ip: '203.0.113.77',
    });
    const res = createMockResponse();

    await handler(req, res);

    expect(res.statusCode).toBe(504);
    expect(res.body).toEqual(
      expect.objectContaining({
        error: 'COINBASE_TIMEOUT',
        fallbackProvider: 'moonpay',
      }),
    );
  });

  it('uses forwarded client IP when socket address is private', async () => {
    mockCreateSessionToken.mockResolvedValue({
      token: 'session-token-forwarded',
      channelId: 'channel-forwarded',
      assetIntent: 'USDC_ON_SUI',
    });

    const req = createMockRequest({
      ip: '10.0.24.9',
      headers: {
        'x-forwarded-for': '198.51.100.77, 10.0.24.9',
      },
      body: {
        walletAddress:
          '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        preferredAssetIntent: 'USDC_ON_SUI',
        country: 'US',
      },
    });
    const res = createMockResponse();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(mockCreateSessionToken).toHaveBeenCalledWith(
      expect.objectContaining({
        clientIp: '198.51.100.77',
      }),
    );
  });
});

describe('POST /api/onramp/coinbase/session — wallet sanctions screen', () => {
  const validBody = {
    walletAddress: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcd',
    preferredAssetIntent: 'USDC_ON_SUI',
    country: 'US',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.COINBASE_ONRAMP_ALLOWED_ORIGINS;
    process.env.NEXT_PUBLIC_COINBASE_ONRAMP_ENABLED = 'true';
    mockCreateSessionToken.mockResolvedValue({
      token: 'session-token',
      channelId: 'channel-1',
      assetIntent: 'USDC_ON_SUI',
    });
  });

  afterEach(() => {
    delete process.env.NEXT_PUBLIC_COINBASE_ONRAMP_ENABLED;
  });

  it('refuses a listed destination wallet and mints no session token', async () => {
    // Geo-blocking alone misses this: a listed address funding itself from a
    // permitted jurisdiction. The wallet is the thing receiving funds, so the
    // wallet is what has to be screened.
    mockScreenAddress.mockResolvedValue({
      blocked: true,
      listVersion: '2026-08-01',
      reason: 'hit',
    });

    const req = createMockRequest({ body: validBody });
    const res = createMockResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual(
      expect.objectContaining({ error: 'SANCTIONS_BLOCKED' }),
    );
    expect(mockCreateSessionToken).not.toHaveBeenCalled();
  });

  it('fails CLOSED with a retryable 503 when screening is unavailable', async () => {
    // Distinct from a match: the user is not refused, the check could not
    // run. Saying 403 here would tell an innocent user they are banned.
    mockScreenAddress.mockResolvedValue({
      blocked: true,
      listVersion: null,
      reason: 'unavailable',
    });

    const req = createMockRequest({ body: validBody });
    const res = createMockResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual(
      expect.objectContaining({ error: 'SCREENING_UNAVAILABLE' }),
    );
    expect(mockCreateSessionToken).not.toHaveBeenCalled();
  });

  it('screens the wallet as a new commitment (failClosed)', async () => {
    const req = createMockRequest({ body: validBody });
    const res = createMockResponse();
    await handler(req, res);

    expect(mockScreenAddress).toHaveBeenCalledWith(
      validBody.walletAddress,
      'ramp_session',
      { failClosed: true },
    );
  });
});
