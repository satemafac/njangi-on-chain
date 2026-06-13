/**
 * Transak webhook handler tests — signature path runs END TO END.
 *
 * The JWT verifier is deliberately NOT mocked: deliveries are signed with
 * the real HS256 scheme Transak uses (partner API secret), and the event
 * payload lives INSIDE the JWT claims (`{ eventID, createdAt, webhookData }`)
 * exactly like real Transak deliveries. The 2026-06 GTM audit found the
 * previous tests mocked the verifier and fed plaintext envelopes, codifying
 * a payload shape Transak never sends — and hiding that the handler trusted
 * unsigned fields.
 */

import { createHmac } from 'crypto';
import type { NextApiRequest, NextApiResponse } from 'next';
import handler from '@/pages/api/onramp/transak/webhook';
import { handleRampKycEvent } from '@/lib/ramp-kyc-bridge';
import { recordOnrampEvent } from '@/lib/onramp-logging';
import { __resetWebhookDedupeForTests } from '@/lib/webhook-dedupe';

jest.mock('@/lib/ramp-kyc-bridge', () => ({
  handleRampKycEvent: jest.fn(),
}));

jest.mock('@/lib/onramp-logging', () => ({
  recordOnrampEvent: jest.fn(),
}));

const mockedBridge = handleRampKycEvent as jest.MockedFunction<
  typeof handleRampKycEvent
>;
const mockedRecord = recordOnrampEvent as jest.MockedFunction<
  typeof recordOnrampEvent
>;

const TRANSAK_SECRET = 'transak-partner-secret';
const MEMBER_WALLET =
  '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcd';
const ATTACKER_WALLET =
  '0xattackerattackerattackerattackerattackerattackerattackerattacka';

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

/** HS256-signs claims the way Transak signs webhook deliveries. */
function signTransakJwt(
  claims: Record<string, unknown>,
  secret: string = TRANSAK_SECRET,
): string {
  const header = Buffer.from(
    JSON.stringify({ alg: 'HS256', typ: 'JWT' }),
    'utf8',
  ).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString(
    'base64url',
  );
  const signature = createHmac('sha256', secret)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

/**
 * A real-format Transak delivery: `{ data: <jwt> }` where the decoded JWT
 * claims are `{ eventID, createdAt, webhookData }` — NO plaintext payload
 * siblings exist outside the token.
 */
function signedDelivery(
  eventID: string,
  webhookData: Record<string, unknown>,
  secret: string = TRANSAK_SECRET,
): Record<string, unknown> {
  return {
    data: signTransakJwt(
      { eventID, createdAt: new Date().toISOString(), webhookData },
      secret,
    ),
  };
}

function completedOrderDelivery(orderId: string): Record<string, unknown> {
  return signedDelivery('ORDER_COMPLETED', {
    id: orderId,
    status: 'COMPLETED',
    walletAddress: MEMBER_WALLET,
  });
}

describe('POST /api/onramp/transak/webhook', () => {
  const originalSecret = process.env.TRANSAK_API_SECRET;

  beforeEach(() => {
    jest.clearAllMocks();
    __resetWebhookDedupeForTests();
    mockedBridge.mockReset();
    mockedBridge.mockResolvedValue(undefined);
    mockedRecord.mockReset();
    mockedRecord.mockResolvedValue(undefined);
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.TRANSAK_API_SECRET = TRANSAK_SECRET;
    process.env.NEXT_PUBLIC_NJANGI_ATTESTATION_ISSUER = '0xissuer';
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalSecret === undefined) delete process.env.TRANSAK_API_SECRET;
    else process.env.TRANSAK_API_SECRET = originalSecret;
    delete process.env.NEXT_PUBLIC_NJANGI_ATTESTATION_ISSUER;
  });

  it('rejects deliveries signed with the wrong secret', async () => {
    const res = createMockResponse();

    await handler(
      createMockRequest(
        signedDelivery(
          'ORDER_COMPLETED',
          { id: 'order-bad-jwt', status: 'COMPLETED', walletAddress: MEMBER_WALLET },
          'some-other-secret',
        ),
      ),
      res,
    );

    expect(res.statusCode).toBe(403);
    expect(mockedBridge).not.toHaveBeenCalled();
    expect(mockedRecord).not.toHaveBeenCalled();
  });

  it('rejects every delivery when TRANSAK_API_SECRET is unset (fail closed)', async () => {
    delete process.env.TRANSAK_API_SECRET;
    const res = createMockResponse();

    await handler(createMockRequest(completedOrderDelivery('order-no-secret')), res);

    expect(res.statusCode).toBe(403);
    expect(mockedBridge).not.toHaveBeenCalled();
  });

  it('rejects bodies that carry no JWT at all (plaintext-only envelope)', async () => {
    const res = createMockResponse();

    await handler(
      createMockRequest({
        eventID: 'KYC_APPROVED',
        webhookData: {
          id: 'forged-case',
          status: 'COMPLETED',
          walletAddress: ATTACKER_WALLET,
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(403);
    expect(mockedBridge).not.toHaveBeenCalled();
  });

  it('processes a real-format delivery where the payload exists ONLY inside the JWT', async () => {
    // Regression guard for the audit finding: against real Transak
    // deliveries there are no plaintext payload siblings — a handler that
    // reads body.webhookData/body.eventID would resolve nothing and the
    // compliance path would be dead.
    const res = createMockResponse();
    await handler(createMockRequest(completedOrderDelivery('order-real-format')), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ received: true });
    expect(mockedBridge).toHaveBeenCalledTimes(1);
    expect(mockedBridge).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'transak',
        outcome: 'approved',
        evidence: 'purchase_completed',
        providerCaseId: 'order-real-format',
        subjectAddress: MEMBER_WALLET,
      }),
      '0xissuer',
    );
  });

  it('accepts the raw JWT as the request body (no JSON envelope)', async () => {
    const res = createMockResponse();
    await handler(
      createMockRequest(
        signTransakJwt({
          eventID: 'ORDER_COMPLETED',
          createdAt: new Date().toISOString(),
          webhookData: {
            id: 'order-raw-body',
            status: 'COMPLETED',
            walletAddress: MEMBER_WALLET,
          },
        }),
      ),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(mockedBridge).toHaveBeenCalledWith(
      expect.objectContaining({ providerCaseId: 'order-raw-body' }),
      '0xissuer',
    );
  });

  it('ignores forged plaintext siblings — only signature-covered claims feed the bridge', async () => {
    // Integrity guard for the audit finding: a holder of ONE valid token
    // must not be able to attach an unsigned KYC_APPROVED + arbitrary
    // wallet and have it attested as a partner KYC decision.
    const delivery = {
      ...signedDelivery('ORDER_COMPLETED', {
        id: 'order-signed-7',
        status: 'COMPLETED',
        walletAddress: MEMBER_WALLET,
      }),
      // Unsigned attacker-controlled fields outside the JWT:
      eventID: 'KYC_APPROVED',
      status: 'COMPLETED',
      webhookData: {
        id: 'forged-case-7',
        status: 'COMPLETED',
        walletAddress: ATTACKER_WALLET,
      },
    };

    const res = createMockResponse();
    await handler(createMockRequest(delivery), res);

    expect(res.statusCode).toBe(200);
    expect(mockedBridge).toHaveBeenCalledTimes(1);
    expect(mockedBridge).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'approved',
        evidence: 'purchase_completed', // signed claims say ORDER_COMPLETED
        providerCaseId: 'order-signed-7',
        subjectAddress: MEMBER_WALLET,
      }),
      '0xissuer',
    );
    expect(mockedBridge).not.toHaveBeenCalledWith(
      expect.objectContaining({ subjectAddress: ATTACKER_WALLET }),
      expect.anything(),
    );
  });

  it('does nothing when the signed claims carry no payload, even if plaintext siblings look approved', async () => {
    const delivery = {
      data: signTransakJwt({ createdAt: new Date().toISOString() }),
      eventID: 'KYC_APPROVED',
      webhookData: {
        id: 'forged-case-8',
        status: 'COMPLETED',
        walletAddress: ATTACKER_WALLET,
      },
    };

    const res = createMockResponse();
    await handler(createMockRequest(delivery), res);

    expect(res.statusCode).toBe(200);
    expect(mockedBridge).not.toHaveBeenCalled();
  });

  it('audit-logs the verified claims, not the plaintext envelope', async () => {
    const delivery = {
      ...completedOrderDelivery('order-audit'),
      webhookData: { id: 'forged-audit', walletAddress: ATTACKER_WALLET },
    };

    const res = createMockResponse();
    await handler(createMockRequest(delivery), res);

    expect(res.statusCode).toBe(200);
    expect(mockedRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'transak',
        payload: expect.objectContaining({
          eventID: 'ORDER_COMPLETED',
          webhookData: expect.objectContaining({ id: 'order-audit' }),
        }),
      }),
    );
  });

  it('awaits the KYC bridge before responding (no fire-and-forget)', async () => {
    let bridgeFinished = false;
    mockedBridge.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      bridgeFinished = true;
    });
    const res = createMockResponse();

    await handler(createMockRequest(completedOrderDelivery('order-awaited')), res);

    expect(mockedBridge).toHaveBeenCalledTimes(1);
    expect(bridgeFinished).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ received: true });
  });

  it('releases the dedupe claim and returns 500 on bridge failure so the provider retry re-runs the side effect', async () => {
    mockedBridge.mockRejectedValueOnce(new Error('attestation enqueue failed'));

    const firstRes = createMockResponse();
    await handler(createMockRequest(completedOrderDelivery('order-failed')), firstRes);

    expect(firstRes.statusCode).toBe(500);
    expect(firstRes.body).toEqual(
      expect.objectContaining({ error: 'KYC_BRIDGE_FAILED' }),
    );

    // Transak redelivers on non-2xx; the released claim lets the retry
    // re-run the bridge.
    const retryRes = createMockResponse();
    await handler(createMockRequest(completedOrderDelivery('order-failed')), retryRes);

    expect(retryRes.statusCode).toBe(200);
    expect(mockedBridge).toHaveBeenCalledTimes(2);
  });

  it('does not re-run the bridge for a duplicate delivery after success', async () => {
    const firstRes = createMockResponse();
    await handler(createMockRequest(completedOrderDelivery('order-dup')), firstRes);
    expect(firstRes.statusCode).toBe(200);

    const secondRes = createMockResponse();
    await handler(createMockRequest(completedOrderDelivery('order-dup')), secondRes);

    expect(secondRes.statusCode).toBe(200);
    expect(mockedBridge).toHaveBeenCalledTimes(1);
  });

  it('labels a completed order as purchase-completion evidence only', async () => {
    const res = createMockResponse();
    await handler(createMockRequest(completedOrderDelivery('order-evidence')), res);

    expect(res.statusCode).toBe(200);
    // Truthful attestation: a completed order implies Transak's KYC/AML
    // program settled a purchase for this buyer — the policy must not
    // claim sanctions/jurisdiction screening Njangi never performed.
    expect(mockedBridge).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'transak',
        outcome: 'approved',
        evidence: 'purchase_completed',
        providerCaseId: 'order-evidence',
      }),
      '0xissuer',
    );
  });

  it('prefers the dedicated KYC_APPROVED event as a partner KYC decision', async () => {
    const res = createMockResponse();
    await handler(
      createMockRequest(
        signedDelivery('KYC_APPROVED', {
          id: 'kyc-case-5',
          walletAddress: MEMBER_WALLET,
        }),
      ),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(mockedBridge).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'transak',
        outcome: 'approved',
        evidence: 'partner_kyc_decision',
        providerCaseId: 'kyc-case-5',
      }),
      '0xissuer',
    );
  });

  it('maps KYC rejection events to a declined outcome', async () => {
    const res = createMockResponse();
    await handler(
      createMockRequest(
        signedDelivery('KYC_REJECTED', {
          id: 'kyc-case-6',
          walletAddress: MEMBER_WALLET,
        }),
      ),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(mockedBridge).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'declined',
        evidence: 'partner_kyc_decision',
      }),
      '0xissuer',
    );
  });

  it('skips the bridge when the signed payload has no real case id', async () => {
    // The event-type constant (KYC_APPROVED, ...) is identical across
    // users — using it as the case id would collapse the dedupe and queue
    // keys, so without an order id the handler must not enqueue anything.
    const res = createMockResponse();
    await handler(
      createMockRequest(
        signedDelivery('KYC_APPROVED', { walletAddress: MEMBER_WALLET }),
      ),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(mockedBridge).not.toHaveBeenCalled();
  });

  it('never accepts a bare event-type constant as the case id', async () => {
    const res = createMockResponse();
    await handler(
      createMockRequest(
        signedDelivery('KYC_APPROVED', {
          id: 'KYC_APPROVED',
          walletAddress: MEMBER_WALLET,
        }),
      ),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(mockedBridge).not.toHaveBeenCalled();
  });
});
