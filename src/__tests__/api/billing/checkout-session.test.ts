import type { NextApiRequest, NextApiResponse } from 'next';
import type Stripe from 'stripe';
import handler from '@/pages/api/billing/checkout-session';
import { getZkLoginSessionAccount } from '@/lib/zklogin-session-registry';
import {
  createCheckoutSession,
  findOrCreateStripeCustomer,
  isBillingEnabled,
  isStripeConfigured,
} from '@/services/stripe-service';
import type { AccountData } from '@/services/zkLoginService';

jest.mock('@/lib/zklogin-session-registry', () => ({
  getZkLoginSessionAccount: jest.fn(),
}));

jest.mock('@/services/stripe-service', () => ({
  createCheckoutSession: jest.fn(),
  findOrCreateStripeCustomer: jest.fn(),
  isBillingEnabled: jest.fn(),
  isStripeConfigured: jest.fn(),
}));

const mockedSessionAccount = getZkLoginSessionAccount as jest.MockedFunction<
  typeof getZkLoginSessionAccount
>;
const mockedFindOrCreate = findOrCreateStripeCustomer as jest.MockedFunction<
  typeof findOrCreateStripeCustomer
>;
const mockedCreateCheckout = createCheckoutSession as jest.MockedFunction<
  typeof createCheckoutSession
>;
const mockedBillingEnabled = isBillingEnabled as jest.MockedFunction<
  typeof isBillingEnabled
>;
const mockedStripeConfigured = isStripeConfigured as jest.MockedFunction<
  typeof isStripeConfigured
>;

type MockResponse = NextApiResponse & {
  statusCode: number;
  body: unknown;
};

function createMockRequest(method = 'POST'): NextApiRequest {
  return {
    method,
    cookies: { 'session-id': 'session-1' },
    headers: {},
    body: {},
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

  return res;
}

describe('POST /api/billing/checkout-session', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedBillingEnabled.mockReturnValue(true);
    mockedStripeConfigured.mockReturnValue(true);
    mockedSessionAccount.mockResolvedValue({
      sub: 'oauth-sub',
      aud: 'oauth-aud',
      userAddr: '0xabc',
    } as AccountData);
    mockedFindOrCreate.mockResolvedValue('cus_123');
    mockedCreateCheckout.mockResolvedValue({
      id: 'cs_1',
      url: 'https://checkout.stripe.com/c/pay/cs_1',
    } as unknown as Stripe.Checkout.Session);
  });

  it('rejects non-POST methods', async () => {
    const res = createMockResponse();
    await handler(createMockRequest('GET'), res);
    expect(res.statusCode).toBe(405);
  });

  it('refuses checkout while the billing kill switch is off (everything stays free)', async () => {
    mockedBillingEnabled.mockReturnValue(false);
    const res = createMockResponse();

    await handler(createMockRequest(), res);

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual(expect.objectContaining({ error: 'BILLING_DISABLED' }));
    expect(mockedFindOrCreate).not.toHaveBeenCalled();
    expect(mockedCreateCheckout).not.toHaveBeenCalled();
  });

  it('returns 503 when Stripe is not configured', async () => {
    mockedStripeConfigured.mockReturnValue(false);
    const res = createMockResponse();

    await handler(createMockRequest(), res);

    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual(expect.objectContaining({ error: 'STRIPE_NOT_CONFIGURED' }));
  });

  it('returns 401 when there is no verified zkLogin session', async () => {
    mockedSessionAccount.mockResolvedValue(null);
    const res = createMockResponse();

    await handler(createMockRequest(), res);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual(
      expect.objectContaining({ error: 'AUTH_REQUIRED', requiresReauth: true }),
    );
    expect(mockedFindOrCreate).not.toHaveBeenCalled();
  });

  it('creates the customer + checkout session for the session identity and returns the hosted URL', async () => {
    const res = createMockResponse();

    await handler(createMockRequest(), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: { url: 'https://checkout.stripe.com/c/pay/cs_1', sessionId: 'cs_1' },
    });
    const identity = { sub: 'oauth-sub', aud: 'oauth-aud', userAddress: '0xabc' };
    expect(mockedFindOrCreate).toHaveBeenCalledWith(identity);
    expect(mockedCreateCheckout).toHaveBeenCalledWith(identity, 'cus_123');
  });

  it('returns 500 when Stripe checkout creation fails', async () => {
    mockedCreateCheckout.mockRejectedValue(new Error('stripe down'));
    const res = createMockResponse();

    await handler(createMockRequest(), res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual(
      expect.objectContaining({ error: 'CHECKOUT_SESSION_FAILED' }),
    );
  });
});
