// entitlement-preflight.ts — CLIENT-SAFE mirror of the browser preflight
// in src/lib/entitlement-gate.ts (fetchEntitlementsPreflight /
// hasFeaturePreflight against GET /api/billing/status).
//
// Why a mirror instead of importing the gate: entitlement-gate.ts
// transitively imports the Stripe SDK and the pg pool via
// stripe-service.ts, which must never land in the client bundle — the
// webpack build fails on `net`/`tls`/`fs` the moment a page value-imports
// it (see the matching warnings in BillingUpsellModal.tsx and
// pricing.tsx, which only `import type` from the gate for this reason).
// This module reimplements ONLY the browser-side fetch contract; the
// server-side asserts in entitlement-gate.ts remain authoritative and are
// the single source of truth for tier contents.
//
// Contract being mirrored (entitlement-gate.ts "Browser preflight"):
//   * While NEXT_PUBLIC_BILLING_ENABLED is false (the default), EVERY
//     check passes — all features stay free until the operator flips the
//     kill switch.
//   * Otherwise GET /api/billing/status with the same-origin session
//     cookie; non-OK or thrown → free tier (worst case the UI shows an
//     upsell the server would not have required — never the reverse).
//   * `data.billingEnabled === false` from the server also passes
//     everything (server-side kill switch wins).
//   * Boolean features (whatsappSuite, smartGoals, analytics) are all
//     false on the free tier and all true on premium, so a boolean
//     feature check reduces to `plan === 'premium'`.

import type { BooleanEntitlementFeature } from '@/lib/entitlement-gate';

// Inline static read so Next.js substitutes the build-time value in the
// client bundle (same one-liner as Navbar.tsx / pricing.tsx).
const BILLING_ENABLED =
  (process.env.NEXT_PUBLIC_BILLING_ENABLED || 'false').toLowerCase() === 'true';

interface BillingStatusResponse {
  success?: boolean;
  data?: {
    plan?: string;
    billingEnabled?: boolean;
  };
}

/**
 * Browser preflight for a single boolean Premium feature. Resolves true
 * whenever billing is disabled (build-time or server-side kill switch);
 * resolves false on any error so the UI errs toward showing the upsell,
 * never toward hiding the gate. The server-side asserts stay
 * authoritative — this only decides whether to upsell BEFORE a 402.
 */
export async function hasFeaturePreflight(
  feature: BooleanEntitlementFeature,
): Promise<boolean> {
  void feature; // every boolean feature is premium-gated; see header note
  if (!BILLING_ENABLED) return true;
  try {
    const response = await fetch('/api/billing/status', {
      method: 'GET',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return false;
    const body = (await response.json()) as BillingStatusResponse;
    if (body?.data?.billingEnabled === false) return true;
    return body?.data?.plan === 'premium';
  } catch {
    return false;
  }
}
