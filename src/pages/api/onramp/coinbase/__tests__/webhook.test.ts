import type { NextApiRequest, NextApiResponse } from 'next';
import crypto from 'crypto';
import handler from '@/pages/api/onramp/coinbase/webhook';
import { handleRampKycEvent } from '@/lib/ramp-kyc-bridge';
import { __resetWebhookDedupeForTests } from '@/lib/webhook-dedupe';

jest.mock('@/lib/ramp-kyc-bridge', () => ({
  handleRampKycEvent: jest.fn(),
}));

const mockedBridge = handleRampKycEvent as jest.MockedFunction<
  typeof handleRampKycEvent
>;

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
    __resetWebhookDedupeForTests();
    mockedBridge.mockReset();
    mockedBridge.mockResolvedValue(undefined);
    process.env.COINBASE_ONRAMP_WEBHOOK_SECRET = secret;
    delete process.env.COINBASE_ONRAMP_ALLOWED_ORIGINS;
    delete process.env.NEXT_PUBLIC_NJANGI_ATTESTATION_ISSUER;
  });

  afterEach(() => {
    delete process.env.COINBASE_ONRAMP_WEBHOOK_SECRET;
    delete process.env.NEXT_PUBLIC_NJANGI_ATTESTATION_ISSUER;
  });

  it('returns 503 when webhook secret is missing', async () => {
    delete process.env.COINBASE_ONRAMP_WEBHOOK_SECRET;
    const req = createMockRequest({
      body: '{"id":"evt-1"}',
      headers: {},
    });
    const res = createMockResponse();

    await handler(req, res);

    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual(
      expect.objectContaining({
        error: 'WEBHOOK_SECRET_MISSING',
      }),
    );
  });

  it('returns 401 for invalid signature', async () => {
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

    await handler(req, res);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual(
      expect.objectContaining({
        error: 'INVALID_SIGNATURE',
      }),
    );
  });

  it('accepts valid signed event and returns 201', async () => {
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

    await handler(req, res);

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

  it('returns duplicate=true for already processed event', async () => {
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
    await handler(firstReq, firstRes);
    expect(firstRes.statusCode).toBe(201);

    const secondReq = createMockRequest({ body, headers });
    const secondRes = createMockResponse();
    await handler(secondReq, secondRes);

    expect(secondRes.statusCode).toBe(200);
    expect(secondRes.body).toEqual(
      expect.objectContaining({
        ok: true,
        duplicate: true,
        eventId: 'evt-duplicate',
      }),
    );
  });

  function signedKycRequest(eventId: string): NextApiRequest {
    const body = JSON.stringify({
      id: eventId,
      type: 'onramp.transaction.updated',
      data: {
        status: 'success',
        transaction_id: `tx-${eventId}`,
        walletAddress:
          '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcd',
      },
    });
    return createMockRequest({
      body,
      headers: { 'x-cc-webhook-signature': signBody(body, secret) },
    });
  }

  it('awaits the KYC bridge before responding (no fire-and-forget)', async () => {
    process.env.NEXT_PUBLIC_NJANGI_ATTESTATION_ISSUER = '0xissuer';
    let bridgeFinished = false;
    mockedBridge.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      bridgeFinished = true;
    });

    const res = createMockResponse();
    await handler(signedKycRequest('evt-kyc-awaited'), res);

    // With the old `void handleRampKycEvent(...)` the handler resolved
    // before the bridge did; on serverless that froze the side effect.
    expect(mockedBridge).toHaveBeenCalledTimes(1);
    expect(bridgeFinished).toBe(true);
    expect(res.statusCode).toBe(201);
  });

  it('releases the dedupe claim and returns 500 on bridge failure so the provider retry re-runs the side effect', async () => {
    process.env.NEXT_PUBLIC_NJANGI_ATTESTATION_ISSUER = '0xissuer';
    mockedBridge.mockRejectedValueOnce(new Error('attestation enqueue failed'));

    const firstRes = createMockResponse();
    await handler(signedKycRequest('evt-kyc-failed'), firstRes);

    expect(firstRes.statusCode).toBe(500);
    expect(firstRes.body).toEqual(
      expect.objectContaining({ ok: false, error: 'KYC_BRIDGE_FAILED' }),
    );

    // Provider retry: the claim was released, so the event is treated as
    // new and the bridge runs again (this time succeeding).
    const retryRes = createMockResponse();
    await handler(signedKycRequest('evt-kyc-failed'), retryRes);

    expect(retryRes.statusCode).toBe(201);
    expect(retryRes.body).toEqual(
      expect.objectContaining({ ok: true, duplicate: false }),
    );
    expect(mockedBridge).toHaveBeenCalledTimes(2);
  });

  it('does not re-run the bridge for a duplicate delivery after success', async () => {
    process.env.NEXT_PUBLIC_NJANGI_ATTESTATION_ISSUER = '0xissuer';

    const firstRes = createMockResponse();
    await handler(signedKycRequest('evt-kyc-dup'), firstRes);
    expect(firstRes.statusCode).toBe(201);

    const secondRes = createMockResponse();
    await handler(signedKycRequest('evt-kyc-dup'), secondRes);

    expect(secondRes.statusCode).toBe(200);
    expect(secondRes.body).toEqual(expect.objectContaining({ duplicate: true }));
    expect(mockedBridge).toHaveBeenCalledTimes(1);
  });
});
