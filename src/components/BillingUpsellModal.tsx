// BillingUpsellModal.tsx — Reusable upgrade prompt for entitlement 402s.
//
// API routes guarded by src/lib/entitlement-gate.ts reject un-entitled
// calls with HTTP 402 and the stable body produced by
// entitlementErrorBody():
//
//   { success: false, error: 'UPGRADE_REQUIRED', code: 'UPGRADE_REQUIRED',
//     feature, requiredPlan: 'premium', message, upgradeUrl: '/pricing' }
//
// Call sites detect that shape with `extractUpgradeRequired(response)`
// (or `parseUpgradeRequired(body)` for an already-parsed payload) and
// render <BillingUpsellModal> with the result instead of a generic error.
//
// IMPORTANT: only `import type` from entitlement-gate here. The gate
// transitively imports the Stripe SDK and the pg pool, which must never
// land in the client bundle; type-only imports are erased at compile time.
//
// i18n note: copy is hardcoded EN for now — pricing/upsell keys for
// src/lib/i18n.ts (owned by another track this cycle) are a follow-up.

import React from 'react';
import Link from 'next/link';
import * as Dialog from '@radix-ui/react-dialog';
import { Crown, ShieldCheck, X } from 'lucide-react';
import type { EntitlementFeature } from '@/lib/entitlement-gate';

// ---------------------------------------------------------------------------
// 402 response detection
// ---------------------------------------------------------------------------

/** Parsed form of the entitlement-gate 402 body (UI upsell contract). */
export interface UpgradeRequiredDetails {
  code: 'UPGRADE_REQUIRED';
  /** Null when the body omitted/garbled the feature — use generic copy. */
  feature: EntitlementFeature | null;
  requiredPlan: 'premium';
  /** Server-provided sentence; safe to show verbatim. */
  message: string;
  upgradeUrl: string;
}

const KNOWN_FEATURES: readonly EntitlementFeature[] = [
  'maxMembers',
  'maxCircles',
  'whatsappSuite',
  'smartGoals',
  'analytics',
];

function isEntitlementFeature(value: unknown): value is EntitlementFeature {
  return (
    typeof value === 'string' && (KNOWN_FEATURES as readonly string[]).includes(value)
  );
}

/**
 * Detects the entitlement-gate error shape in an already-parsed JSON body.
 * Returns null for anything that is not an UPGRADE_REQUIRED rejection.
 */
export function parseUpgradeRequired(body: unknown): UpgradeRequiredDetails | null {
  if (!body || typeof body !== 'object') return null;
  const candidate = body as Record<string, unknown>;
  if (candidate.code !== 'UPGRADE_REQUIRED' && candidate.error !== 'UPGRADE_REQUIRED') {
    return null;
  }
  return {
    code: 'UPGRADE_REQUIRED',
    feature: isEntitlementFeature(candidate.feature) ? candidate.feature : null,
    requiredPlan: 'premium',
    message: typeof candidate.message === 'string' ? candidate.message : '',
    upgradeUrl: typeof candidate.upgradeUrl === 'string' ? candidate.upgradeUrl : '/pricing',
  };
}

/**
 * Detects the 402 UPGRADE_REQUIRED shape on a fetch Response without
 * consuming its body (clones before reading). Usage:
 *
 *   const upgrade = await extractUpgradeRequired(response);
 *   if (upgrade) { setUpsell(upgrade); return; }
 */
export async function extractUpgradeRequired(
  response: Response,
): Promise<UpgradeRequiredDetails | null> {
  if (response.status !== 402) return null;
  try {
    const body = await response.clone().json();
    return parseUpgradeRequired(body);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Per-feature copy
// ---------------------------------------------------------------------------

const FEATURE_COPY: Record<EntitlementFeature, { title: string; body: string }> = {
  whatsappSuite: {
    title: 'WhatsApp updates are a Premium feature',
    body: 'Link your circle to WhatsApp so members get turn reminders and payout alerts right where they already chat.',
  },
  maxMembers: {
    title: 'Bigger circles are a Premium feature',
    body: 'Free circles hold a few close members. Premium grows a circle to the full rotation the contract supports.',
  },
  maxCircles: {
    title: 'More circles are a Premium feature',
    body: 'The Free plan covers one circle. Premium lets you organize several circles side by side.',
  },
  smartGoals: {
    title: 'Smart goals are a Premium feature',
    body: 'Set savings targets and milestones for your circle and watch progress build every round.',
  },
  analytics: {
    title: 'Analytics are a Premium feature',
    body: 'See contribution history, on-time rates, and payout trends across your circles.',
  },
};

const GENERIC_COPY = {
  title: 'This is a Premium feature',
  body: 'Upgrade to Premium to unlock it for your circles.',
};

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

export interface BillingUpsellModalProps {
  open: boolean;
  onClose: () => void;
  /** Which gate rejected — drives the headline copy. */
  feature?: EntitlementFeature | null;
  /** Optional server message (from the 402 body) shown under the headline. */
  message?: string;
}

export function BillingUpsellModal({
  open,
  onClose,
  feature,
  message,
}: BillingUpsellModalProps) {
  const copy = feature ? FEATURE_COPY[feature] : GENERIC_COPY;

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-[#14161c]/45 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-[28px] border border-[#dfd6ca] bg-[#fbfaf7] p-6 shadow-[0_28px_80px_-40px_rgba(15,23,42,0.45)] sm:p-7">
          <div className="flex h-11 w-11 items-center justify-center rounded-full border border-[#e2d3ae] bg-[#fdf6e7]">
            <Crown className="h-5 w-5 text-[#a07b2f]" />
          </div>

          <Dialog.Title className="mt-4 pr-8 text-xl font-semibold tracking-[-0.03em] text-[#171923]">
            {copy.title}
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-sm leading-6 text-[#5d6674]">
            {message || copy.body}
          </Dialog.Description>

          <div className="mt-5 flex items-start gap-3 rounded-[18px] border border-[#e9e1d6] bg-white p-3.5">
            <ShieldCheck className="mt-0.5 h-4 w-4 flex-shrink-0 text-[#3f7d54]" />
            <p className="text-xs leading-5 text-[#4b5565]">
              Collecting payouts, recovery, and withdrawing your funds are
              always free — Premium only adds coordination conveniences.
            </p>
          </div>

          <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={onClose}
              className="rounded-full border border-[#d5ccbf] bg-white px-5 py-2.5 text-sm font-semibold text-[#334155] transition-colors duration-200 hover:bg-[#f6f3ee]"
            >
              Not now
            </button>
            <Link
              href="/pricing"
              onClick={onClose}
              className="inline-flex items-center justify-center gap-2 rounded-full bg-[#1d2533] px-5 py-2.5 text-sm font-semibold text-white transition-colors duration-200 hover:bg-[#101723]"
            >
              See plans
            </Link>
          </div>

          <Dialog.Close asChild>
            <button
              type="button"
              onClick={onClose}
              className="absolute right-5 top-5 rounded-full border border-[#e5ddd2] bg-white p-2 text-[#667085] transition-colors duration-200 hover:text-[#171923]"
            >
              <X className="h-4 w-4" />
              <span className="sr-only">Close</span>
            </button>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export default BillingUpsellModal;
