// entitlement-gate.ts — Premium-tier feature gate for the Stripe
// subscription build. Clones the architecture of compliance-gate.ts:
// feature flag default-off, server-side assert helpers for API routes,
// a browser preflight, and a typed gate error with a stable code.
//
// Check flow:
//   1. Read NEXT_PUBLIC_BILLING_ENABLED (public; UI can preflight). While
//      it is false (the default) EVERY check passes — all features stay
//      free until the operator flips the kill switch.
//   2. Resolve the caller's plan from the subscriptions table via
//      stripe-service (lookup by (sub, aud) root identity, falling back
//      to the derived Sui address).
//   3. Map plan → entitlements and assert the requested feature/limit.
//
// Tier model (product decisions, June 2026):
//   free:    1 circle, 3 members max, no WhatsApp suite / smart goals /
//            analytics.
//   premium: $9.99/mo — 5 circles, 20 members (the Move-layer MAX_MEMBERS
//            in njangi_core.move), WhatsApp suite, smart goals, analytics.
//
// HARD INVARIANT — never gate fund access: recovery, claim, withdraw, and
// contribute paths must NEVER consult this module. Charging to reach
// one's own escrowed funds would undermine the non-custodial posture and
// is contractually excluded in the ToS drafts (see the GTM readiness
// review, "Risks"). Gate coordination conveniences only.
//
// Enforcement honesty: only server-mediated features (WhatsApp linking +
// notifications, server-computed analytics) are genuinely enforceable.
// On-chain limits (circle count, member cap) are SOFT gates — public Move
// entry points and the Phase 2 client-side signer can bypass the API
// broker entirely. Those gates are product friction for the upgrade
// funnel, not security, and they fail OPEN on infrastructure errors so a
// billing-DB blip never blocks circle operations.

import type { NetworkType } from '@/config/public-env';
import {
  getSubscriptionForUser,
  isBillingEnabled,
  type SubscriptionIdentity,
  type SubscriptionPlan,
} from '../services/stripe-service';
import { discoverMemberCircleIds } from './membership-discovery';
import {
  fetchCircleAdminAddress,
  suiAddressesEqual,
} from './circle-admin-verification';

// Re-export so gate call sites need a single import.
export { isBillingEnabled };
export type { SubscriptionPlan };

// ---------------------------------------------------------------------------
// Entitlement model
// ---------------------------------------------------------------------------

/** Features a plan can be entitled to. Numeric limits + boolean switches. */
export type EntitlementFeature =
  | 'maxMembers'
  | 'maxCircles'
  | 'whatsappSuite'
  | 'smartGoals'
  | 'analytics';

/** The boolean on/off subset of EntitlementFeature. */
export type BooleanEntitlementFeature = 'whatsappSuite' | 'smartGoals' | 'analytics';

export interface Entitlements {
  plan: SubscriptionPlan;
  /** Largest member cap a circle this user creates/configures may have. */
  maxMembers: number;
  /** Number of circles this user may concurrently administer. */
  maxCircles: number;
  whatsappSuite: boolean;
  smartGoals: boolean;
  analytics: boolean;
}

export const FREE_TIER_ENTITLEMENTS: Entitlements = Object.freeze({
  plan: 'free',
  maxMembers: 3,
  maxCircles: 1,
  whatsappSuite: false,
  smartGoals: false,
  analytics: false,
});

export const PREMIUM_TIER_ENTITLEMENTS: Entitlements = Object.freeze({
  plan: 'premium',
  maxMembers: 20, // Move-layer MAX_MEMBERS (move/sources/njangi_core.move)
  maxCircles: 5,
  whatsappSuite: true,
  smartGoals: true,
  analytics: true,
});

export function entitlementsForPlan(plan: SubscriptionPlan): Entitlements {
  return plan === 'premium'
    ? { ...PREMIUM_TIER_ENTITLEMENTS }
    : { ...FREE_TIER_ENTITLEMENTS };
}

/**
 * Identity for entitlement lookups. Either the (sub, aud) zkLogin root
 * key, the derived Sui address, or both — stripe-service matches the
 * (sub, aud) pair first and falls back to the address (covers rows
 * written before an OAuth-provider switch).
 */
export interface EntitlementIdentity {
  sub?: string;
  aud?: string;
  userAddress?: string;
}

function toSubscriptionIdentity(identity: EntitlementIdentity): SubscriptionIdentity {
  return {
    sub: identity.sub ?? '',
    aud: identity.aud ?? '',
    userAddress: identity.userAddress ?? '',
  };
}

function hasUsableIdentity(identity: EntitlementIdentity): boolean {
  return Boolean((identity.sub && identity.aud) || identity.userAddress);
}

// ---------------------------------------------------------------------------
// Typed gate error
// ---------------------------------------------------------------------------

/**
 * Thrown by the assert helpers when the caller's plan does not cover the
 * requested feature. API routes translate this into a 402 with
 * `entitlementErrorBody` so the UI can render an upgrade prompt instead
 * of a generic failure.
 */
export class EntitlementError extends Error {
  readonly code = 'UPGRADE_REQUIRED' as const;
  readonly feature: EntitlementFeature;
  readonly requiredPlan: SubscriptionPlan = 'premium';

  constructor(feature: EntitlementFeature, message: string) {
    super(message);
    this.name = 'EntitlementError';
    this.feature = feature;
  }
}

/** Stable JSON body for the 402 response (UI upsell contract). */
export function entitlementErrorBody(error: EntitlementError): {
  success: false;
  error: 'UPGRADE_REQUIRED';
  code: 'UPGRADE_REQUIRED';
  feature: EntitlementFeature;
  requiredPlan: SubscriptionPlan;
  message: string;
  upgradeUrl: string;
} {
  return {
    success: false,
    error: error.code,
    code: error.code,
    feature: error.feature,
    requiredPlan: error.requiredPlan,
    message: error.message,
    upgradeUrl: '/pricing',
  };
}

// ---------------------------------------------------------------------------
// Server-side lookups + asserts
// ---------------------------------------------------------------------------

/**
 * Resolves the caller's entitlements. While the billing kill switch is
 * off, everyone gets the premium entitlement set (everything passes —
 * "free until flipped"). With billing on, an unknown identity or a
 * missing subscription row resolves to the free tier.
 */
export async function getEntitlements(
  identity: EntitlementIdentity,
): Promise<Entitlements> {
  if (!isBillingEnabled()) {
    return entitlementsForPlan('premium');
  }
  if (!hasUsableIdentity(identity)) {
    return entitlementsForPlan('free');
  }
  const record = await getSubscriptionForUser(toSubscriptionIdentity(identity));
  return entitlementsForPlan(record?.plan ?? 'free');
}

/**
 * Server assert for boolean features (WhatsApp suite, smart goals,
 * analytics). No-op while billing is disabled; throws EntitlementError
 * when the plan lacks the feature. Safe to call unconditionally from API
 * routes — callers map EntitlementError to a 402 and treat any OTHER
 * error as fail-open (billing infra trouble must not take features down;
 * this gate is product friction, not access control).
 */
export async function assertEntitled(
  feature: BooleanEntitlementFeature,
  identity: EntitlementIdentity,
): Promise<void> {
  if (!isBillingEnabled()) return;
  const entitlements = await getEntitlements(identity);
  if (!entitlements[feature]) {
    throw new EntitlementError(
      feature,
      featureUpgradeMessage(feature),
    );
  }
}

function featureUpgradeMessage(feature: BooleanEntitlementFeature): string {
  switch (feature) {
    case 'whatsappSuite':
      return 'WhatsApp linking and notifications are a Premium feature. Upgrade to Premium ($9.99/mo) to enable them for your circles.';
    case 'smartGoals':
      return 'Smart goals are a Premium feature. Upgrade to Premium ($9.99/mo) to set savings goals and milestones.';
    case 'analytics':
      return 'Circle analytics are a Premium feature. Upgrade to Premium ($9.99/mo) to unlock them.';
  }
}

/**
 * Asserts a requested circle member cap fits the caller's plan
 * (free: 3, premium: 20 — the Move-layer hard max). Used by the
 * create-circle and adminSetMaxMembers broker paths.
 */
export async function assertWithinMemberLimit(
  requestedMaxMembers: number,
  identity: EntitlementIdentity,
): Promise<void> {
  if (!isBillingEnabled()) return;
  const entitlements = await getEntitlements(identity);
  if (requestedMaxMembers > entitlements.maxMembers) {
    throw new EntitlementError(
      'maxMembers',
      `Your ${entitlements.plan} plan supports up to ${entitlements.maxMembers} members per circle. ` +
        `Upgrade to Premium ($9.99/mo) for circles of up to ${PREMIUM_TIER_ENTITLEMENTS.maxMembers} members.`,
    );
  }
}

/**
 * Asserts that creating ONE MORE circle keeps the caller within their
 * plan's concurrent-circle limit, given how many they already administer.
 */
export async function assertWithinCircleLimit(
  existingAdminCircleCount: number,
  identity: EntitlementIdentity,
): Promise<void> {
  if (!isBillingEnabled()) return;
  const entitlements = await getEntitlements(identity);
  if (existingAdminCircleCount >= entitlements.maxCircles) {
    throw new EntitlementError(
      'maxCircles',
      `Your ${entitlements.plan} plan supports ${entitlements.maxCircles} ` +
        `${entitlements.maxCircles === 1 ? 'circle' : 'circles'}. ` +
        `Upgrade to Premium ($9.99/mo) to run up to ${PREMIUM_TIER_ENTITLEMENTS.maxCircles} circles.`,
    );
  }
}

/**
 * Counts circles `userAddress` currently administers. Reuses the
 * existing scalable discovery path: owned CircleMembership receipts
 * (O(this user's circles) — create_circle auto-joins the admin, so every
 * admin'd circle is covered) and verifies the on-chain `admin` field per
 * candidate. NO global event scan. `stopAt` short-circuits the per-circle
 * verification once the limit in question is provably exceeded.
 */
export async function countAdminCircles(
  userAddress: string,
  network: NetworkType,
  opts: { stopAt?: number } = {},
): Promise<number> {
  const candidateIds = await discoverMemberCircleIds(userAddress, { network });
  let count = 0;
  for (const circleId of candidateIds) {
    try {
      const adminAddress = await fetchCircleAdminAddress(circleId, network);
      if (suiAddressesEqual(adminAddress, userAddress)) {
        count += 1;
      }
    } catch (error) {
      // Unreadable candidate (stale receipt, transient RPC error): skip it.
      // Under-counting only makes the soft gate more permissive.
      console.warn(
        `[entitlement-gate] Skipping unreadable circle candidate ${circleId}:`,
        error,
      );
    }
    if (opts.stopAt !== undefined && count >= opts.stopAt) {
      break;
    }
  }
  return count;
}

/**
 * Combined soft gate for the create-circle broker path: member cap +
 * concurrent-circle count. SOFT — create_circle is a public Move entry
 * point and client-side signers bypass /api/zkLogin entirely, so this is
 * upgrade-funnel friction, not security. No-op while billing is off.
 */
export async function assertCanCreateCircle(args: {
  identity: EntitlementIdentity;
  requestedMaxMembers: number;
  network: NetworkType;
}): Promise<void> {
  if (!isBillingEnabled()) return;
  await assertWithinMemberLimit(args.requestedMaxMembers, args.identity);
  if (!args.identity.userAddress) {
    // Can't count circles without an address; member-cap check above
    // already ran. Fail open on the count rather than guessing.
    return;
  }
  const entitlements = await getEntitlements(args.identity);
  const adminCircleCount = await countAdminCircles(
    args.identity.userAddress,
    args.network,
    { stopAt: entitlements.maxCircles },
  );
  await assertWithinCircleLimit(adminCircleCount, args.identity);
}

// ---------------------------------------------------------------------------
// Browser preflight
// ---------------------------------------------------------------------------

interface BillingStatusResponse {
  success?: boolean;
  data?: {
    plan?: string;
    status?: string;
    periodEnd?: string | null;
    cancelAtPeriodEnd?: boolean;
    billingEnabled?: boolean;
  };
}

/**
 * Browser-side preflight via GET /api/billing/status (HttpOnly session
 * cookie rides along on same-origin requests). Mirrors compliance-gate's
 * hasValidAttestation: UI surfaces use this to decide whether to show an
 * upsell BEFORE the server rejects with 402 — the server asserts remain
 * authoritative. Resolves to the free tier on any error (worst case the
 * UI shows an upsell the server would not have required).
 */
export async function fetchEntitlementsPreflight(): Promise<Entitlements> {
  if (!isBillingEnabled()) {
    return entitlementsForPlan('premium');
  }
  try {
    const response = await fetch('/api/billing/status', {
      method: 'GET',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      return entitlementsForPlan('free');
    }
    const body = (await response.json()) as BillingStatusResponse;
    if (body?.data?.billingEnabled === false) {
      return entitlementsForPlan('premium');
    }
    return entitlementsForPlan(body?.data?.plan === 'premium' ? 'premium' : 'free');
  } catch {
    return entitlementsForPlan('free');
  }
}

/** Convenience boolean preflight for a single feature. */
export async function hasFeaturePreflight(
  feature: BooleanEntitlementFeature,
): Promise<boolean> {
  const entitlements = await fetchEntitlementsPreflight();
  return entitlements[feature];
}
