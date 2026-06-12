import type { NextApiRequest, NextApiResponse } from 'next';
import handler from '@/pages/api/onramp/transak/webhook';
import { handleRampKycEvent } from '@/lib/ramp-kyc-bridge';
import { verifyTransakWebhookJwt } from '@/services/transak-service';
import { recordOnrampEvent } from '@/lib/onramp-logging';
import { __resetWebhookDedupeForTests } from '@/lib/webhook-dedupe';

jest.mock('@/lib/ramp-kyc-bridge', () => ({
  handleRampKycEvent: jest.fn(),
}));

jest.mock('@/services/transak-service', () => ({
  verifyTransakWebhookJwt: jest.fn(),
}));

jest.mock('@/lib/onramp-logging', () => ({
  recordOnrampEvent: jest.fn(),
}));

const mockedBridge = handleRampKycEvent as jest.MockedFunction<
  typeof handleRampKycEvent
>;
const mockedVerify = verifyTransakWebhookJwt as jest.MockedFunction<
  typeof verifyTransakWebhookJwt
>;
const mockedRecord = recordOnrampEvent as jest.MockedFunction<
  typeof recordOnrampEvent
>;

type MockResponse = NextApiResponse & {
  statusCode: number;
  body: unknown;
};

function createMockRequest(body: unknown): NextApiRequest {
  return {
    method: 'POST',
    body,
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

function approvedKycEnvelope(orderId: string): Record<string, unknown> {
  return {
    data: 'signed.jwt.token',
    webhookData: {
      id: orderId,
      status: 'COMPLETED',
      walletAddress:
        '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcd',
    },
  };
}

describe('POST /api/onramp/transak/webhook', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetWebhookDedupeForTests();
    mockedBridge.mockReset();
    mockedBridge.mockResolvedValue(undefined);
    mockedVerify.mockReset();
    mockedVerify.mockReturnValue(true);
    mockedRecord.mockReset();
    mockedRecord.mockResolvedValue(undefined);
    process.env.NEXT_PUBLIC_NJANGI_ATTESTATION_ISSUER = '0xissuer';
  });

  afterEach(() => {
    delete process.env.NEXT_PUBLIC_NJANGI_ATTESTATION_ISSUER;
  });

  it('rejects deliveries with an invalid JWT', async () => {
    mockedVerify.mockReturnValue(false);
    const res = createMockResponse();

    await handler(createMockRequest(approvedKycEnvelope('order-bad-jwt')), res);

    expect(res.statusCode).toBe(403);
    expect(mockedBridge).not.toHaveBeenCalled();
  });

  it('awaits the KYC bridge before responding (no fire-and-forget)', async () => {
    let bridgeFinished = false;
    mockedBridge.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      bridgeFinished = true;
    });
    const res = createMockResponse();

    await handler(createMockRequest(approvedKycEnvelope('order-awaited')), res);

    expect(mockedBridge).toHaveBeenCalledTimes(1);
    expect(bridgeFinished).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ received: true });
  });

  it('releases the dedupe claim and returns 500 on bridge failure so the provider retry re-runs the side effect', async () => {
    mockedBridge.mockRejectedValueOnce(new Error('attestation enqueue failed'));

    const firstRes = createMockResponse();
    await handler(
      createMockRequest(approvedKycEnvelope('order-failed')),
      firstRes,
    );

    expect(firstRes.statusCode).toBe(500);
    expect(firstRes.body).toEqual(
      expect.objectContaining({ error: 'KYC_BRIDGE_FAILED' }),
    );

    // Transak redelivers on non-2xx; the released claim lets the retry
    // re-run the bridge.
    const retryRes = createMockResponse();
    await handler(
      createMockRequest(approvedKycEnvelope('order-failed')),
      retryRes,
    );

    expect(retryRes.statusCode).toBe(200);
    expect(mockedBridge).toHaveBeenCalledTimes(2);
  });

  it('does not re-run the bridge for a duplicate delivery after success', async () => {
    const firstRes = createMockResponse();
    await handler(createMockRequest(approvedKycEnvelope('order-dup')), firstRes);
    expect(firstRes.statusCode).toBe(200);

    const secondRes = createMockResponse();
    await handler(createMockRequest(approvedKycEnvelope('order-dup')), secondRes);

    expect(secondRes.statusCode).toBe(200);
    expect(mockedBridge).toHaveBeenCalledTimes(1);
  });
});
