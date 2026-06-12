/**
 * entitlement-gate.test.ts — Premium-tier gate behavior:
 *
 * - Kill switch off (NEXT_PUBLIC_BILLING_ENABLED unset/false): every
 *   check passes and no subscription/RPC lookups run.
 * - Billing on + free tier: 4th member and 2nd circle are blocked with a
 *   typed EntitlementError {code:'UPGRADE_REQUIRED', feature}; WhatsApp
 *   suite is unentitled.
 * - Billing on + premium: 20 members / 5 circles / WhatsApp all pass;
 *   limits beyond the Move-layer caps still reject.
 * - countAdminCircles only counts circles whose on-chain admin is the
 *   user, and skips unreadable candidates (fail-permissive soft gate).
 *
 * Uses the real stripe-service against its in-memory dev store (pg-pool
 * mocked unconfigured), mirroring how the gate runs without DATABASE_URL.
 */

jest.mock('@/lib/pg-pool', () => ({
  getSharedPgPool: jest.fn(),
  isPostgresConfigured: jest.fn(() => false),
}));
jest.mock('@/lib/membership-discovery', () => ({
  discoverMemberCircleIds: jest.fn(),
}));
jest.mock('@/lib/circle-admin-verification', () => {
  const actual = jest.requireActual('@/lib/circle-admin-verification');
  return {
    ...actual,
    fetchCircleAdminAddress: jest.fn(),
  };
});

import {
  assertCanCreateCircle,
  assertEntitled,
  assertWithinCircleLimit,
  assertWithinMemberLimit,
  countAdminCircles,
  EntitlementError,
  entitlementErrorBody,
  FREE_TIER_ENTITLEMENTS,
  getEntitlements,
  PREMIUM_TIER_ENTITLEMENTS,
} from '@/lib/entitlement-gate';
import {
  __resetStripeServiceForTests,
  applySubscriptionState,
  upsertSubscriptionIdentity,
} from '@/services/stripe-service';
import { discoverMemberCircleIds } from '@/lib/membership-discovery';
import { fetchCircleAdminAddress } from '@/lib/circle-admin-verification';

const mockedDiscover = discoverMemberCircleIds as jest.MockedFunction<
  typeof discoverMemberCircleIds
>;
const mockedFetchAdmin = fetchCircleAdminAddress as jest.MockedFunction<
  typeof fetchCircleAdminAddress
>;

const USER_ADDRESS = '0x' + 'a1'.repeat(32);
const OTHER_ADDRESS = '0x' + 'b2'.repeat(32);
const IDENTITY = { sub: 'oauth-sub', aud: 'oauth-aud', userAddress: USER_ADDRESS };

const ORIGINAL_FLAG = process.env.NEXT_PUBLIC_BILLING_ENABLED;

function setBillingEnabled(enabled: boolean): void {
  process.env.NEXT_PUBLIC_BILLING_ENABLED = enabled ? 'true' : 'false';
}

async function seedPremiumSubscription(
  identity = IDENTITY,
  status = 'active',
): Promise<void> {
  await upsertSubscriptionIdentity(identity, `cus_${identity.sub}`);
  await applySubscriptionState({
    stripeCustomerId: `cus_${identity.sub}`,
    stripeSubscriptionId: `sub_${identity.sub}`,
    priceId: 'price_premium',
    status,
    currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    cancelAtPeriodEnd: false,
  });
}

async function expectEntitlementRejection(
  promise: Promise<unknown>,
  feature: string,
): Promise<EntitlementError> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(EntitlementError);
  const error = caught as EntitlementError;
  expect(error.code).toBe('UPGRADE_REQUIRED');
  expect(error.feature).toBe(feature);
  return error;
}

describe('entitlement-gate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetStripeServiceForTests();
    setBillingEnabled(false);
    mockedDiscover.mockResolvedValue([]);
    mockedFetchAdmin.mockResolvedValue(null);
  });

  afterAll(() => {
    if (ORIGINAL_FLAG === undefined) {
      delete process.env.NEXT_PUBLIC_BILLING_ENABLED;
    } else {
      process.env.NEXT_PUBLIC_BILLING_ENABLED = ORIGINAL_FLAG;
    }
  });

  describe('billing disabled (default) — everything passes', () => {
    it('grants the full premium entitlement set to an unknown user', async () => {
      const entitlements = await getEntitlements(IDENTITY);
      expect(entitlements).toEqual(PREMIUM_TIER_ENTITLEMENTS);
    });

    it('passes every assert without any subscription or chain lookup', async () => {
      await expect(assertEntitled('whatsappSuite', IDENTITY)).resolves.toBeUndefined();
      await expect(assertWithinMemberLimit(20, IDENTITY)).resolves.toBeUndefined();
      await expect(assertWithinCircleLimit(99, IDENTITY)).resolves.toBeUndefined();
      await expect(
        assertCanCreateCircle({
          identity: IDENTITY,
          requestedMaxMembers: 20,
          network: 'testnet',
        }),
      ).resolves.toBeUndefined();
      // No-op fast path: the soft gate must not touch RPC while disabled.
      expect(mockedDiscover).not.toHaveBeenCalled();
      expect(mockedFetchAdmin).not.toHaveBeenCalled();
    });
  });

  describe('billing enabled — free tier (no subscription row)', () => {
    beforeEach(() => setBillingEnabled(true));

    it('resolves the free entitlement shape', async () => {
      const entitlements = await getEntitlements(IDENTITY);
      expect(entitlements).toEqual(FREE_TIER_ENTITLEMENTS);
      expect(entitlements).toEqual(
        expect.objectContaining({
          plan: 'free',
          maxMembers: 3,
          maxCircles: 1,
          whatsappSuite: false,
          smartGoals: false,
          analytics: false,
        }),
      );
    });

    it('blocks a 4th member but allows the 3-member minimum', async () => {
      await expect(assertWithinMemberLimit(3, IDENTITY)).resolves.toBeUndefined();
      await expectEntitlementRejection(
        assertWithinMemberLimit(4, IDENTITY),
        'maxMembers',
      );
    });

    it('blocks a 2nd circle when the user already administers one', async () => {
      mockedDiscover.mockResolvedValue(['0xcircle1']);
      mockedFetchAdmin.mockResolvedValue(USER_ADDRESS);

      await expectEntitlementRejection(
        assertCanCreateCircle({
          identity: IDENTITY,
          requestedMaxMembers: 3,
          network: 'testnet',
        }),
        'maxCircles',
      );
    });

    it('allows the first circle', async () => {
      mockedDiscover.mockResolvedValue([]);
      await expect(
        assertCanCreateCircle({
          identity: IDENTITY,
          requestedMaxMembers: 3,
          network: 'testnet',
        }),
      ).resolves.toBeUndefined();
    });

    it('rejects the member cap before counting circles', async () => {
      await expectEntitlementRejection(
        assertCanCreateCircle({
          identity: IDENTITY,
          requestedMaxMembers: 10,
          network: 'testnet',
        }),
        'maxMembers',
      );
      expect(mockedDiscover).not.toHaveBeenCalled();
    });

    it('leaves the WhatsApp suite unentitled', async () => {
      await expectEntitlementRejection(
        assertEntitled('whatsappSuite', IDENTITY),
        'whatsappSuite',
      );
    });

    it('treats an empty identity as free tier (fail-closed on identity, not infra)', async () => {
      const entitlements = await getEntitlements({});
      expect(entitlements.plan).toBe('free');
    });
  });

  describe('billing enabled — premium subscription', () => {
    beforeEach(async () => {
      setBillingEnabled(true);
      await seedPremiumSubscription();
    });

    it('resolves the premium entitlement shape', async () => {
      const entitlements = await getEntitlements(IDENTITY);
      expect(entitlements).toEqual(PREMIUM_TIER_ENTITLEMENTS);
    });

    it('passes 20 members and rejects beyond the Move-layer cap', async () => {
      await expect(assertWithinMemberLimit(20, IDENTITY)).resolves.toBeUndefined();
      await expectEntitlementRejection(
        assertWithinMemberLimit(21, IDENTITY),
        'maxMembers',
      );
    });

    it('passes a 5th circle and rejects a 6th', async () => {
      const fourCircles = ['0xc1', '0xc2', '0xc3', '0xc4'];
      mockedDiscover.mockResolvedValue(fourCircles);
      mockedFetchAdmin.mockResolvedValue(USER_ADDRESS);
      await expect(
        assertCanCreateCircle({
          identity: IDENTITY,
          requestedMaxMembers: 20,
          network: 'testnet',
        }),
      ).resolves.toBeUndefined();

      mockedDiscover.mockResolvedValue([...fourCircles, '0xc5']);
      await expectEntitlementRejection(
        assertCanCreateCircle({
          identity: IDENTITY,
          requestedMaxMembers: 20,
          network: 'testnet',
        }),
        'maxCircles',
      );
    });

    it('entitles the WhatsApp suite', async () => {
      await expect(assertEntitled('whatsappSuite', IDENTITY)).resolves.toBeUndefined();
    });

    it('finds the subscription by address alone (WhatsApp gate identity shape)', async () => {
      await expect(
        assertEntitled('whatsappSuite', { userAddress: USER_ADDRESS }),
      ).resolves.toBeUndefined();
    });

    it('keeps premium through the past_due dunning grace window', async () => {
      await seedPremiumSubscription(IDENTITY, 'past_due');
      const entitlements = await getEntitlements(IDENTITY);
      expect(entitlements.plan).toBe('premium');
    });

    it('drops to free once the subscription is canceled', async () => {
      await seedPremiumSubscription(IDENTITY, 'canceled');
      const entitlements = await getEntitlements(IDENTITY);
      expect(entitlements).toEqual(FREE_TIER_ENTITLEMENTS);
    });
  });

  describe('countAdminCircles', () => {
    it('counts only circles whose on-chain admin is the user', async () => {
      mockedDiscover.mockResolvedValue(['0xmine', '0xtheirs', '0xmine2']);
      mockedFetchAdmin.mockImplementation(async (circleId: string) =>
        circleId === '0xtheirs' ? OTHER_ADDRESS : USER_ADDRESS,
      );

      await expect(countAdminCircles(USER_ADDRESS, 'testnet')).resolves.toBe(2);
    });

    it('skips unreadable candidates instead of failing the gate', async () => {
      mockedDiscover.mockResolvedValue(['0xbroken', '0xmine']);
      mockedFetchAdmin.mockImplementation(async (circleId: string) => {
        if (circleId === '0xbroken') throw new Error('rpc unavailable');
        return USER_ADDRESS;
      });

      await expect(countAdminCircles(USER_ADDRESS, 'testnet')).resolves.toBe(1);
    });

    it('short-circuits once stopAt is reached', async () => {
      mockedDiscover.mockResolvedValue(['0xc1', '0xc2', '0xc3']);
      mockedFetchAdmin.mockResolvedValue(USER_ADDRESS);

      await expect(
        countAdminCircles(USER_ADDRESS, 'testnet', { stopAt: 1 }),
      ).resolves.toBe(1);
      expect(mockedFetchAdmin).toHaveBeenCalledTimes(1);
    });
  });

  describe('entitlementErrorBody', () => {
    it('produces the stable 402 upsell contract', () => {
      const error = new EntitlementError('whatsappSuite', 'Upgrade required.');
      expect(entitlementErrorBody(error)).toEqual({
        success: false,
        error: 'UPGRADE_REQUIRED',
        code: 'UPGRADE_REQUIRED',
        feature: 'whatsappSuite',
        requiredPlan: 'premium',
        message: 'Upgrade required.',
        upgradeUrl: '/pricing',
      });
    });
  });
});
