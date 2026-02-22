import type { NextApiRequest, NextApiResponse } from 'next';
import handler from '@/pages/api/onramp/coinbase/options';
import { CoinbaseOnrampError } from '@/services/coinbase-onramp-service';

const mockGetBuyConfig = jest.fn();
const mockGetBuyOptions = jest.fn();

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
      getBuyConfig: mockGetBuyConfig,
      getBuyOptions: mockGetBuyOptions,
    })),
    CoinbaseOnrampError: MockCoinbaseOnrampError,
    maskWalletAddress: (walletAddress: string) => walletAddress,
  };
});

type MockResponse = NextApiResponse & {
  statusCode: number;
  body: unknown;
};

function createMockRequest(input: {
  method?: string;
  query?: Record<string, string | string[]>;
  headers?: Record<string, string>;
  ip?: string;
}): NextApiRequest {
  return {
    method: input.method ?? 'GET',
    query: input.query ?? {},
    headers: input.headers ?? {},
    socket: {
      remoteAddress: input.ip ?? '203.0.113.10',
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

describe('GET /api/onramp/coinbase/options', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.COINBASE_ONRAMP_ALLOWED_ORIGINS;
  });

  it('returns normalized SUI and USDC_ON_SUI support on happy path', async () => {
    mockGetBuyConfig.mockResolvedValue({
      countries: [
        {
          id: 'US',
          payment_methods: [{ id: 'CARD' }],
          subdivisions: ['CA', 'NY'],
        },
      ],
    });
    mockGetBuyOptions.mockResolvedValue({
      purchase_currencies: [
        {
          id: 'SUI',
          symbol: 'SUI',
          icon_url: 'https://cdn.example/sui.png',
          networks: [{ name: 'Sui' }],
        },
        {
          id: 'USDC',
          symbol: 'USDC',
          icon_url: 'https://cdn.example/usdc.png',
          networks: [{ display_name: 'Sui Mainnet' }],
        },
      ],
      payment_currencies: [
        {
          id: 'USD',
          limits: [{ id: 'CARD', min: '10', max: '1000' }],
          payment_methods: [{ id: 'CARD' }],
        },
      ],
    });

    const req = createMockRequest({
      query: {
        walletAddress:
          '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcd',
        country: 'US',
        subdivision: 'CA',
      },
      headers: {
        'x-correlation-id': 'corr-options-1',
      },
      ip: '203.0.113.11',
    });
    const res = createMockResponse();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(mockGetBuyOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        country: 'US',
        subdivision: 'CA',
        networks: ['sui'],
      }),
    );

    const body = res.body as {
      eligible: boolean;
      supportedIntents: string[];
      fallbackProvider: string | null;
    };
    expect(body.eligible).toBe(true);
    expect(body.supportedIntents).toEqual(
      expect.arrayContaining(['SUI', 'USDC_ON_SUI']),
    );
    expect(body.fallbackProvider).toBeNull();
    expect(res.getHeader('x-correlation-id')).toBe('corr-options-1');
  });

  it('returns unsupported region without calling Coinbase service', async () => {
    const req = createMockRequest({
      query: {
        walletAddress:
          '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        country: 'FR',
      },
      ip: '203.0.113.12',
    });
    const res = createMockResponse();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(mockGetBuyConfig).not.toHaveBeenCalled();
    expect(mockGetBuyOptions).not.toHaveBeenCalled();

    const body = res.body as { eligible: boolean; reasonCode?: string };
    expect(body.eligible).toBe(false);
    expect(body.reasonCode).toBe('UNSUPPORTED_REGION');
  });

  it('returns validation error for missing walletAddress', async () => {
    const req = createMockRequest({
      query: { country: 'US' },
      ip: '203.0.113.13',
    });
    const res = createMockResponse();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual(
      expect.objectContaining({
        error: 'VALIDATION_ERROR',
      }),
    );
    expect(mockGetBuyConfig).not.toHaveBeenCalled();
    expect(mockGetBuyOptions).not.toHaveBeenCalled();
  });

  it('returns ineligible when assets are available only on non-Sui networks', async () => {
    mockGetBuyConfig.mockResolvedValue({
      countries: [{ id: 'US', payment_methods: [{ id: 'CARD' }] }],
    });
    mockGetBuyOptions.mockResolvedValue({
      purchase_currencies: [
        {
          id: 'USDC',
          symbol: 'USDC',
          networks: [{ name: 'Ethereum' }],
        },
      ],
      payment_currencies: [
        {
          id: 'USD',
          limits: [{ id: 'CARD', min: '20', max: '500' }],
        },
      ],
    });

    const req = createMockRequest({
      query: {
        walletAddress:
          '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        country: 'US',
      },
      ip: '203.0.113.14',
    });
    const res = createMockResponse();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        eligible: false,
        reasonCode: 'UNSUPPORTED_ASSET_OR_NETWORK',
        fallbackProvider: 'moonpay',
      }),
    );
  });

  it('returns timeout-style Coinbase error response when upstream call times out', async () => {
    mockGetBuyConfig.mockResolvedValue({
      countries: [{ id: 'US', payment_methods: [{ id: 'CARD' }] }],
    });
    mockGetBuyOptions.mockRejectedValue(
      new CoinbaseOnrampError(
        'Coinbase request timed out',
        'COINBASE_TIMEOUT',
        504,
      ),
    );

    const req = createMockRequest({
      query: {
        walletAddress:
          '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        country: 'US',
      },
      ip: '203.0.113.15',
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

  it('enforces IP rate limit and returns 429', async () => {
    const ip = '203.0.113.250';

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const req = createMockRequest({
        query: { country: 'US' },
        ip,
      });
      const res = createMockResponse();
      await handler(req, res);
      expect(res.statusCode).toBe(400);
    }

    const finalReq = createMockRequest({
      query: { country: 'US' },
      ip,
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
});
