import type { NextApiRequest, NextApiResponse } from 'next';
import { Readable } from 'stream';
import type Stripe from 'stripe';
import handler from '@/pages/api/billing/webhook';
import {
  constructStripeWebhookEvent,
  recordCheckoutSessionCompleted,
  recordInvoicePaymentFailed,
  recordSubscriptionDeleted,
  recordSubscriptionUpdated,
} from '@/services/stripe-service';
import { __resetWebhookDedupeForTests } from '@/lib/webhook-dedupe';

jest.mock('@/services/stripe-service', () => ({
  constructStripeWebhookEvent: jest.fn(),
  recordCheckoutSessionCompleted: jest.fn(),
  recordInvoicePaymentFailed: jest.fn(),
  recordSubscriptionDeleted: jest.fn(),
  recordSubscriptionUpdated: jest.fn(),
}));

const mockedConstruct = constructStripeWebhookEvent as jest.MockedFunction<
  typeof constructStripeWebhookEvent
>;
const mockedCheckoutCompleted = recordCheckoutSessionCompleted as jest.MockedFunction<
  typeof recordCheckoutSessionCompleted
>;
const mockedSubUpdated = recordSubscriptionUpdated as jest.MockedFunction<
  typeof recordSubscriptionUpdated
>;
const mockedSubDeleted = recordSubscriptionDeleted as jest.MockedFunction<
  typeof recordSubscriptionDeleted
>;
const mockedInvoiceFailed = recordInvoicePaymentFailed as jest.MockedFunction<
  typeof recordInvoicePaymentFailed
>;

type MockResponse = NextApiResponse & {
  statusCode: number;
  body: unknown;
};

function createMockRequest(options: { method?: string; signature?: string | null } = {}): NextApiRequest {
  const req = Readable.from([
    Buffer.from('{"raw":"payload"}', 'utf8'),
  ]) as unknown as NextApiRequest;
  (req as { method?: string }).method = options.method ?? 'POST';
  const headers: Record<string, string> = {};
  if (options.signature !== null) {
    headers['stripe-signature'] = options.signature ?? 't=123,v1=sig';
  }
  (req as { headers: Record<string, string> }).headers = headers;
  return req;
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

function makeEvent(id: string, type: string, object: Record<string, unknown> = {}): Stripe.Event {
  return { id, type, data: { object } } as unknown as Stripe.Event;
}

describe('POST /api/billing/webhook', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetWebhookDedupeForTests();
    delete process.env.DATABASE_URL; // keep webhook-dedupe in memory mode
    mockedCheckoutCompleted.mockResolvedValue(undefined);
    mockedSubUpdated.mockResolvedValue(undefined);
    mockedSubDeleted.mockResolvedValue(undefined);
    mockedInvoiceFailed.mockResolvedValue(undefined);
  });

  it('rejects non-POST methods', async () => {
    const res = createMockResponse();
    await handler(createMockRequest({ method: 'GET' }), res);
    expect(res.statusCode).toBe(405);
  });

  it('rejects deliveries without a stripe-signature header', async () => {
    const res = createMockResponse();
    await handler(createMockRequest({ signature: null }), res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual(expect.objectContaining({ error: 'MISSING_SIGNATURE' }));
    expect(mockedConstruct).not.toHaveBeenCalled();
  });

  it('rejects deliveries with an invalid signature and runs no side effects', async () => {
    mockedConstruct.mockImplementation(() => {
      throw new Error('No signatures found matching the expected signature');
    });
    const res = createMockResponse();

    await handler(createMockRequest(), res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual(expect.objectContaining({ error: 'INVALID_SIGNATURE' }));
    expect(mockedCheckoutCompleted).not.toHaveBeenCalled();
    expect(mockedSubUpdated).not.toHaveBeenCalled();
    expect(mockedSubDeleted).not.toHaveBeenCalled();
    expect(mockedInvoiceFailed).not.toHaveBeenCalled();
  });

  it('returns 500 (so Stripe retries) when the webhook secret is not configured', async () => {
    mockedConstruct.mockImplementation(() => {
      const err = new Error('STRIPE_WEBHOOK_SECRET is not configured');
      err.name = 'StripeBillingConfigError';
      throw err;
    });
    const res = createMockResponse();

    await handler(createMockRequest(), res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual(expect.objectContaining({ error: 'WEBHOOK_NOT_CONFIGURED' }));
  });

  it('dispatches checkout.session.completed to the provisioning handler', async () => {
    const session = { id: 'cs_1', mode: 'subscription' };
    mockedConstruct.mockReturnValue(makeEvent('evt_checkout', 'checkout.session.completed', session));
    const res = createMockResponse();

    await handler(createMockRequest(), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ received: true });
    expect(mockedCheckoutCompleted).toHaveBeenCalledWith(session);
  });

  it('dispatches customer.subscription.updated to the state sync handler', async () => {
    const subscription = { id: 'sub_1', status: 'active' };
    mockedConstruct.mockReturnValue(
      makeEvent('evt_updated', 'customer.subscription.updated', subscription),
    );
    const res = createMockResponse();

    await handler(createMockRequest(), res);

    expect(res.statusCode).toBe(200);
    expect(mockedSubUpdated).toHaveBeenCalledWith(subscription);
  });

  it('dispatches customer.subscription.deleted to the cancellation handler', async () => {
    const subscription = { id: 'sub_1', status: 'canceled' };
    mockedConstruct.mockReturnValue(
      makeEvent('evt_deleted', 'customer.subscription.deleted', subscription),
    );
    const res = createMockResponse();

    await handler(createMockRequest(), res);

    expect(res.statusCode).toBe(200);
    expect(mockedSubDeleted).toHaveBeenCalledWith(subscription);
  });

  it('dispatches invoice.payment_failed to the dunning handler', async () => {
    const invoice = { id: 'in_1', customer: 'cus_1' };
    mockedConstruct.mockReturnValue(makeEvent('evt_failed', 'invoice.payment_failed', invoice));
    const res = createMockResponse();

    await handler(createMockRequest(), res);

    expect(res.statusCode).toBe(200);
    expect(mockedInvoiceFailed).toHaveBeenCalledWith(invoice);
  });

  it('acknowledges unhandled event types without side effects', async () => {
    mockedConstruct.mockReturnValue(makeEvent('evt_other', 'charge.succeeded'));
    const res = createMockResponse();

    await handler(createMockRequest(), res);

    expect(res.statusCode).toBe(200);
    expect(mockedCheckoutCompleted).not.toHaveBeenCalled();
    expect(mockedSubUpdated).not.toHaveBeenCalled();
    expect(mockedSubDeleted).not.toHaveBeenCalled();
    expect(mockedInvoiceFailed).not.toHaveBeenCalled();
  });

  it('deduplicates redeliveries of the same event id after success', async () => {
    mockedConstruct.mockReturnValue(
      makeEvent('evt_dup', 'customer.subscription.updated', { id: 'sub_1' }),
    );

    const firstRes = createMockResponse();
    await handler(createMockRequest(), firstRes);
    expect(firstRes.statusCode).toBe(200);

    const secondRes = createMockResponse();
    await handler(createMockRequest(), secondRes);

    expect(secondRes.statusCode).toBe(200);
    expect(secondRes.body).toEqual({ received: true, duplicate: true });
    expect(mockedSubUpdated).toHaveBeenCalledTimes(1);
  });

  it('releases the dedupe claim and returns 500 on persistence failure so the retry re-runs', async () => {
    mockedConstruct.mockReturnValue(
      makeEvent('evt_retry', 'customer.subscription.updated', { id: 'sub_1' }),
    );
    mockedSubUpdated.mockRejectedValueOnce(new Error('postgres down'));

    const firstRes = createMockResponse();
    await handler(createMockRequest(), firstRes);

    expect(firstRes.statusCode).toBe(500);
    expect(firstRes.body).toEqual(
      expect.objectContaining({ error: 'WEBHOOK_PROCESSING_FAILED' }),
    );

    // Stripe redelivers on non-2xx; the released claim lets the retry
    // re-run the upsert.
    const retryRes = createMockResponse();
    await handler(createMockRequest(), retryRes);

    expect(retryRes.statusCode).toBe(200);
    expect(mockedSubUpdated).toHaveBeenCalledTimes(2);
  });
});
