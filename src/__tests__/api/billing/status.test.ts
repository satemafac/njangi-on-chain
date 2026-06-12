import type { NextApiRequest, NextApiResponse } from 'next';
import handler from '@/pages/api/billing/status';
import { getZkLoginSessionAccount } from '@/lib/zklogin-session-registry';
import { getSubscriptionForUser, isBillingEnabled } from '@/services/stripe-service';
import type { AccountData } from '@/services/zkLoginService';

jest.mock('@/lib/zklogin-session-registry', () => ({
  getZkLoginSessionAccount: jest.fn(),
}));

jest.mock('@/services/stripe-service', () => ({
  getSubscriptionForUser: jest.fn(),
  isBillingEnabled: jest.fn(),
}));

const mockedSessionAccount = getZkLoginSessionAccount as jest.MockedFunction<
  typeof getZkLoginSessionAccount
>;
const mockedGetSubscription = getSubscriptionForUser as jest.MockedFunction<
  typeof getSubscriptionForUser
>;
const mockedBillingEnabled = isBillingEnabled as jest.MockedFunction<
  typeof isBillingEnabled
>;

type MockResponse = NextApiResponse & {
  statusCode: number;
  body: unknown;
};

function createMockRequest(method = 'GET'): NextApiRequest {
  return {
    method,
    cookies: { 'session-id': 'session-1' },
    headers: {},
    query: {},
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

function sessionAccount(): AccountData {
  return {
    sub: 'oauth-sub',
    aud: 'oauth-aud',
    userAddr: '0xabc',
  } as AccountData;
}

describe('GET /api/billing/status', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedSessionAccount.mockResolvedValue(sessionAccount());
    mockedGetSubscription.mockResolvedValue(null);
    mockedBillingEnabled.mockReturnValue(true);
  });

  it('rejects non-GET methods', async () => {
    const res = createMockResponse();
    await handler(createMockRequest('POST'), res);
    expect(res.statusCode).toBe(405);
  });

  it('returns 401 when there is no verified zkLogin session', async () => {
    mockedSessionAccount.mockResolvedValue(null);
    const res = createMockResponse();

    await handler(createMockRequest(), res);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual(
      expect.objectContaining({ error: 'AUTH_REQUIRED', requiresReauth: true }),
    );
    // No subscription data may leak to unauthenticated callers.
    expect(mockedGetSubscription).not.toHaveBeenCalled();
  });

  it('reports free/none for users with no billing row', async () => {
    const res = createMockResponse();

    await handler(createMockRequest(), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: {
        plan: 'free',
        status: 'none',
        periodEnd: null,
        cancelAtPeriodEnd: false,
        billingEnabled: true,
      },
    });
  });

  it('returns the subscription state for the session identity (never client-supplied)', async () => {
    mockedGetSubscription.mockResolvedValue({
      sub: 'oauth-sub',
      aud: 'oauth-aud',
      userAddress: '0xabc',
      stripeCustomerId: 'cus_123',
      stripeSubscriptionId: 'sub_123',
      priceId: 'price_premium',
      plan: 'premium',
      status: 'active',
      currentPeriodEnd: '2026-07-12T00:00:00.000Z',
      cancelAtPeriodEnd: true,
    });
    const res = createMockResponse();

    await handler(createMockRequest(), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: {
        plan: 'premium',
        status: 'active',
        periodEnd: '2026-07-12T00:00:00.000Z',
        cancelAtPeriodEnd: true,
        billingEnabled: true,
      },
    });
    expect(mockedGetSubscription).toHaveBeenCalledWith({
      sub: 'oauth-sub',
      aud: 'oauth-aud',
      userAddress: '0xabc',
    });
  });

  it('surfaces billingEnabled=false while the kill switch is off', async () => {
    mockedBillingEnabled.mockReturnValue(false);
    const res = createMockResponse();

    await handler(createMockRequest(), res);

    expect(res.statusCode).toBe(200);
    expect((res.body as { data: { billingEnabled: boolean } }).data.billingEnabled).toBe(false);
  });
});
