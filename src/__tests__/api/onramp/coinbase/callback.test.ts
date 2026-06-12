import type { NextApiRequest, NextApiResponse } from 'next';
import handler from '@/pages/api/onramp/coinbase/callback';

type MockResponse = NextApiResponse & {
  statusCode: number;
  body: unknown;
};

function createMockRequest(input: {
  method?: string;
  query?: Record<string, string | string[]>;
  headers?: Record<string, string>;
}): NextApiRequest {
  return {
    method: input.method ?? 'GET',
    query: input.query ?? {},
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
    (key: string, value: string | string[] | number) => {
      headers.set(
        key.toLowerCase(),
        Array.isArray(value) ? value.join(',') : String(value),
      );
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

describe('GET /api/onramp/coinbase/callback', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.COINBASE_ONRAMP_ALLOWED_ORIGINS;
  });

  it('returns normalized callback payload for success status', () => {
    const req = createMockRequest({
      query: {
        status: 'completed',
        transaction_id: 'tx-123',
        session_id: 'sess-123',
        walletAddress:
          '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcd',
        asset: 'usdc',
      },
      headers: {
        'x-correlation-id': 'corr-callback-1',
      },
    });
    const res = createMockResponse();

    handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        provider: 'coinbase',
        status: 'success',
        transactionId: 'tx-123',
        sessionId: 'sess-123',
        assetIntent: 'USDC_ON_SUI',
      }),
    );
    const responseWithHeaders = res as unknown as {
      getHeader: (key: string) => string | undefined;
    };
    expect(responseWithHeaders.getHeader('x-correlation-id')).toBe(
      'corr-callback-1',
    );
  });

  it('returns validation error when wallet address format is invalid', () => {
    const req = createMockRequest({
      query: {
        status: 'completed',
        walletAddress: 'not-a-wallet',
      },
    });
    const res = createMockResponse();

    handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual(
      expect.objectContaining({
        error: 'VALIDATION_ERROR',
      }),
    );
  });

  it('rejects forbidden origin', () => {
    process.env.COINBASE_ONRAMP_ALLOWED_ORIGINS = 'https://allowed.example';
    const req = createMockRequest({
      headers: {
        origin: 'https://blocked.example',
      },
    });
    const res = createMockResponse();

    handler(req, res);

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual(
      expect.objectContaining({
        error: 'CORS_FORBIDDEN',
      }),
    );
  });

  it('rejects unsupported method', () => {
    const req = createMockRequest({ method: 'POST' });
    const res = createMockResponse();

    handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual(
      expect.objectContaining({
        error: 'METHOD_NOT_ALLOWED',
      }),
    );
  });
});
