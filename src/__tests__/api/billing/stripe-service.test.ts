/**
 * Event → subscriptions-row upsert mapping in src/services/stripe-service.ts,
 * with the shared pg pool mocked so the exact SQL + parameters are asserted.
 */

import type Stripe from 'stripe';
import {
  __resetStripeServiceForTests,
  constructStripeWebhookEvent,
  extractCurrentPeriodEnd,
  getStripeClient,
  planForStatus,
  recordCheckoutSessionCompleted,
  recordInvoicePaymentFailed,
  recordSubscriptionDeleted,
  recordSubscriptionUpdated,
  upsertSubscriptionIdentity,
} from '@/services/stripe-service';
import { getSharedPgPool, isPostgresConfigured } from '@/lib/pg-pool';

jest.mock('@/lib/pg-pool', () => ({
  getSharedPgPool: jest.fn(),
  isPostgresConfigured: jest.fn(),
}));

const mockedPoolGetter = getSharedPgPool as jest.MockedFunction<typeof getSharedPgPool>;
const mockedConfigured = isPostgresConfigured as jest.MockedFunction<
  typeof isPostgresConfigured
>;

const mockQuery = jest.fn();

/** Calls to the pool excluding the lazy CREATE TABLE bootstrap. */
function dataCalls(): unknown[][] {
  return mockQuery.mock.calls.filter(
    ([sql]) => !(typeof sql === 'string' && sql.includes('CREATE TABLE')),
  );
}

const PERIOD_END_SECONDS = 1_790_000_000;

function makeSubscription(overrides: Record<string, unknown> = {}): Stripe.Subscription {
  return {
    id: 'sub_123',
    customer: 'cus_123',
    status: 'active',
    cancel_at_period_end: false,
    items: {
      data: [
        {
          price: { id: 'price_premium' },
          current_period_end: PERIOD_END_SECONDS,
        },
      ],
    },
    metadata: { sub: 'oauth-sub', aud: 'oauth-aud', suiAddress: '0xabc' },
    ...overrides,
  } as unknown as Stripe.Subscription;
}

describe('stripe-service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetStripeServiceForTests();
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mockedConfigured.mockReturnValue(true);
    mockedPoolGetter.mockReturnValue({ query: mockQuery } as never);
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
  });

  describe('lazy configuration', () => {
    it('getStripeClient throws a typed config error when STRIPE_SECRET_KEY is unset', () => {
      expect(() => getStripeClient()).toThrow(/STRIPE_SECRET_KEY/);
      let caught: unknown;
      try {
        getStripeClient();
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).name).toBe('StripeBillingConfigError');
    });

    it('constructStripeWebhookEvent throws a typed config error when STRIPE_WEBHOOK_SECRET is unset', () => {
      let caught: unknown;
      try {
        constructStripeWebhookEvent('{}', 't=1,v1=sig');
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).name).toBe('StripeBillingConfigError');
      expect((caught as Error).message).toMatch(/STRIPE_WEBHOOK_SECRET/);
    });
  });

  describe('planForStatus', () => {
    it('keeps premium through the past_due grace window', () => {
      expect(planForStatus('active')).toBe('premium');
      expect(planForStatus('trialing')).toBe('premium');
      expect(planForStatus('past_due')).toBe('premium');
    });

    it('drops to free for terminal/incomplete statuses', () => {
      for (const status of ['canceled', 'incomplete', 'incomplete_expired', 'unpaid', 'paused']) {
        expect(planForStatus(status)).toBe('free');
      }
    });
  });

  describe('extractCurrentPeriodEnd', () => {
    it('reads the basil-era per-item period end', () => {
      const result = extractCurrentPeriodEnd(makeSubscription());
      expect(result).toEqual(new Date(PERIOD_END_SECONDS * 1000));
    });

    it('prefers the legacy subscription-level field when present', () => {
      const legacy = makeSubscription({ current_period_end: PERIOD_END_SECONDS + 60 });
      expect(extractCurrentPeriodEnd(legacy)).toEqual(
        new Date((PERIOD_END_SECONDS + 60) * 1000),
      );
    });

    it('returns null when no period end exists anywhere', () => {
      const bare = makeSubscription({ items: { data: [{ price: { id: 'p' } }] } });
      expect(extractCurrentPeriodEnd(bare)).toBeNull();
    });
  });

  describe('upsertSubscriptionIdentity', () => {
    it('inserts a free/incomplete row keyed by (sub, aud)', async () => {
      await upsertSubscriptionIdentity(
        { sub: 'oauth-sub', aud: 'oauth-aud', userAddress: '0xabc' },
        'cus_123',
      );

      const [sql, params] = dataCalls()[0] as [string, unknown[]];
      expect(sql).toContain('INSERT INTO subscriptions');
      expect(sql).toContain("'free', 'incomplete'");
      expect(sql).toContain('ON CONFLICT (sub, aud)');
      expect(params).toEqual(['oauth-sub', 'oauth-aud', '0xabc', 'cus_123']);
    });
  });

  describe('recordSubscriptionUpdated', () => {
    it('updates the row keyed by stripe_customer_id with derived plan + period end', async () => {
      mockQuery.mockImplementation(async (sql: string) =>
        sql.includes('UPDATE subscriptions')
          ? { rows: [], rowCount: 1 }
          : { rows: [], rowCount: 0 },
      );

      await recordSubscriptionUpdated(makeSubscription());

      const updateCall = dataCalls().find(([sql]) =>
        (sql as string).includes('UPDATE subscriptions'),
      );
      expect(updateCall).toBeDefined();
      const [, params] = updateCall as [string, unknown[]];
      expect(params).toEqual([
        'cus_123',
        'sub_123',
        'price_premium',
        'premium',
        'active',
        new Date(PERIOD_END_SECONDS * 1000).toISOString(),
        false,
      ]);
    });

    it('recreates a missing row from subscription metadata (webhook raced ahead of checkout)', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

      await recordSubscriptionUpdated(makeSubscription());

      const insertCall = dataCalls().find(([sql]) =>
        (sql as string).includes('INSERT INTO subscriptions'),
      );
      expect(insertCall).toBeDefined();
      const [sql, params] = insertCall as [string, unknown[]];
      expect(sql).toContain('ON CONFLICT (sub, aud)');
      expect(params).toEqual([
        'oauth-sub',
        'oauth-aud',
        '0xabc',
        'cus_123',
        'sub_123',
        'price_premium',
        'premium',
        'active',
        new Date(PERIOD_END_SECONDS * 1000).toISOString(),
        false,
      ]);
    });

    it('throws (so the webhook 500s and Stripe retries) when no row exists and no identity metadata is present', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

      await expect(
        recordSubscriptionUpdated(makeSubscription({ metadata: {} })),
      ).rejects.toThrow(/no identity metadata/i);
    });
  });

  describe('recordSubscriptionDeleted', () => {
    it('drops the row to plan free / status canceled', async () => {
      mockQuery.mockImplementation(async (sql: string) =>
        sql.includes('UPDATE subscriptions')
          ? { rows: [], rowCount: 1 }
          : { rows: [], rowCount: 0 },
      );

      await recordSubscriptionDeleted(makeSubscription({ status: 'canceled' }));

      const updateCall = dataCalls().find(([sql]) =>
        (sql as string).includes('UPDATE subscriptions'),
      );
      const [, params] = updateCall as [string, unknown[]];
      expect(params[3]).toBe('free'); // plan
      expect(params[4]).toBe('canceled'); // status
    });
  });

  describe('recordInvoicePaymentFailed', () => {
    it('marks the customer past_due while keeping premium (grace window)', async () => {
      await recordInvoicePaymentFailed({
        id: 'in_1',
        customer: 'cus_123',
      } as unknown as Stripe.Invoice);

      const [sql, params] = dataCalls()[0] as [string, unknown[]];
      expect(sql).toContain("status = 'past_due'");
      expect(sql).toContain("plan = 'premium'");
      expect(sql).toContain('stripe_subscription_id IS NOT NULL');
      expect(params).toEqual(['cus_123']);
    });

    it('ignores invoices without a customer reference instead of failing the webhook', async () => {
      await expect(
        recordInvoicePaymentFailed({ id: 'in_2', customer: null } as unknown as Stripe.Invoice),
      ).resolves.toBeUndefined();
      expect(dataCalls()).toHaveLength(0);
    });
  });

  describe('recordCheckoutSessionCompleted', () => {
    it('provisions from an expanded subscription using session metadata for identity', async () => {
      mockQuery.mockImplementation(async (sql: string) =>
        sql.includes('UPDATE subscriptions')
          ? { rows: [], rowCount: 1 }
          : { rows: [], rowCount: 0 },
      );

      await recordCheckoutSessionCompleted({
        id: 'cs_1',
        mode: 'subscription',
        customer: 'cus_123',
        subscription: makeSubscription({ metadata: {} }),
        metadata: { sub: 'oauth-sub', aud: 'oauth-aud', suiAddress: '0xabc' },
      } as unknown as Stripe.Checkout.Session);

      const updateCall = dataCalls().find(([sql]) =>
        (sql as string).includes('UPDATE subscriptions'),
      );
      expect(updateCall).toBeDefined();
      const [, params] = updateCall as [string, unknown[]];
      expect(params[0]).toBe('cus_123');
      expect(params[3]).toBe('premium');
      expect(params[4]).toBe('active');
    });

    it('ignores non-subscription checkout sessions', async () => {
      await recordCheckoutSessionCompleted({
        id: 'cs_2',
        mode: 'payment',
      } as unknown as Stripe.Checkout.Session);
      expect(dataCalls()).toHaveLength(0);
    });
  });
});
