import type { NextApiRequest, NextApiResponse } from 'next';
import crypto from 'crypto';
import handler from '@/pages/api/onramp/coinbase/webhook';

type MockResponse = NextApiResponse & {
  statusCode: number;
  body: unknown;
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

function signBody(body: string, secret: string): string {
  const digest = crypto.createHmac('sha256', secret).update(body).digest('hex');
  return `sha256=${digest}`;
}

describe('POST /api/onramp/coinbase/webhook', () => {
  const secret = 'test-webhook-secret';

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.COINBASE_ONRAMP_WEBHOOK_SECRET = secret;
    delete process.env.COINBASE_ONRAMP_ALLOWED_ORIGINS;
  });

  afterEach(() => {
    delete process.env.COINBASE_ONRAMP_WEBHOOK_SECRET;
  });

  it('returns 503 when webhook secret is missing', () => {
    delete process.env.COINBASE_ONRAMP_WEBHOOK_SECRET;
    const req = createMockRequest({
      body: '{"id":"evt-1"}',
      headers: {},
    });
    const res = createMockResponse();

    handler(req, res);

    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual(
      expect.objectContaining({
        error: 'WEBHOOK_SECRET_MISSING',
      }),
    );
  });

  it('returns 401 for invalid signature', () => {
    const body = JSON.stringify({
      id: 'evt-invalid',
      type: 'onramp.transaction.updated',
      data: { status: 'pending' },
    });
    const req = createMockRequest({
      body,
      headers: {
        'x-cc-webhook-signature': 'sha256=invalid',
      },
    });
    const res = createMockResponse();

    handler(req, res);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual(
      expect.objectContaining({
        error: 'INVALID_SIGNATURE',
      }),
    );
  });

  it('accepts valid signed event and returns 201', () => {
    const body = JSON.stringify({
      id: 'evt-accepted',
      type: 'onramp.transaction.updated',
      data: {
        status: 'success',
        transaction_id: 'tx-123',
        walletAddress:
          '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcd',
      },
    });
    const req = createMockRequest({
      body,
      headers: {
        'x-cc-webhook-signature': signBody(body, secret),
      },
    });
    const res = createMockResponse();

    handler(req, res);

    expect(res.statusCode).toBe(201);
    expect(res.body).toEqual(
      expect.objectContaining({
        ok: true,
        duplicate: false,
        eventId: 'evt-accepted',
        status: 'success',
      }),
    );
  });

  it('returns duplicate=true for already processed event', () => {
    const body = JSON.stringify({
      id: 'evt-duplicate',
      type: 'onramp.transaction.updated',
      data: { status: 'pending' },
    });
    const headers = {
      'x-cc-webhook-signature': signBody(body, secret),
    };

    const firstReq = createMockRequest({ body, headers });
    const firstRes = createMockResponse();
    handler(firstReq, firstRes);
    expect(firstRes.statusCode).toBe(201);

    const secondReq = createMockRequest({ body, headers });
    const secondRes = createMockResponse();
    handler(secondReq, secondRes);

    expect(secondRes.statusCode).toBe(200);
    expect(secondRes.body).toEqual(
      expect.objectContaining({
        ok: true,
        duplicate: true,
        eventId: 'evt-duplicate',
      }),
    );
  });
});
