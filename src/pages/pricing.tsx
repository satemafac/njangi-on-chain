// pricing.tsx — Public two-tier pricing page (Free vs Premium $9.99/mo).
//
// Tier numbers are NOT hardcoded here: getStaticProps imports
// FREE_TIER_ENTITLEMENTS / PREMIUM_TIER_ENTITLEMENTS from
// src/lib/entitlement-gate.ts (the single source of truth the API gates
// enforce) and passes them down as props. The import happens inside
// getStaticProps on purpose — the entitlement gate transitively pulls the
// Stripe SDK and the pg pool, which must never reach the client bundle.
// The pages router strips getStaticProps (and its dynamic import) from
// the client build.
//
// CTA behavior:
//   * NEXT_PUBLIC_BILLING_ENABLED=false (default): "Coming soon" badge on
//     Premium, checkout never starts (the API would 409 anyway).
//   * Billing on + signed out: CTA routes through the home page login
//     flow with returnUrl=/pricing.
//   * Billing on + signed in + free: POST /api/billing/checkout-session
//     and redirect to the hosted Stripe page.
//   * Billing on + signed in + premium: POST /api/billing/portal-session
//     ("Manage subscription").
//
// HARD INVARIANT (ToS): recovery, payout claiming, and withdrawals are
// never gated on subscription status — the page says so explicitly.
//
// i18n note: copy is hardcoded EN for now. The shared dictionary in
// src/lib/i18n.ts is owned by another track this cycle; pricing.* keys
// (EN/FR) should be added there in the i18n pass.

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import type { GetStaticProps } from 'next';
import {
  ArrowRight,
  Check,
  Crown,
  Loader2,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuth } from '@/contexts/AuthContext';
import { LocaleSwitcher } from '@/components/ui/LocaleSwitcher';
import { useTranslation } from '@/hooks/useTranslation';
import type { Entitlements } from '@/lib/entitlement-gate';
import { Seo } from '../components/Seo';
import { breadcrumbs } from '../lib/structured-data';
import { Breadcrumbs, MarketingShell } from '../components/marketing/ArticleLayout';
import { goldButtonClass, quietButtonClass } from '../components/landing/ui';

// Inline static read so Next.js substitutes the build-time value in the
// client bundle (same one-line check as entitlement-gate.isBillingEnabled).
const BILLING_ENABLED =
  (process.env.NEXT_PUBLIC_BILLING_ENABLED || 'false').toLowerCase() === 'true';

const PREMIUM_PRICE_LABEL = '$9.99';

interface PricingPageProps {
  freeTier: Entitlements;
  premiumTier: Entitlements;
}

export const getStaticProps: GetStaticProps<PricingPageProps> = async () => {
  // Server-only import — see file header. Keeps the displayed limits in
  // lockstep with what the API gates actually enforce.
  const { FREE_TIER_ENTITLEMENTS, PREMIUM_TIER_ENTITLEMENTS } = await import(
    '@/lib/entitlement-gate'
  );
  return {
    props: {
      freeTier: { ...FREE_TIER_ENTITLEMENTS },
      premiumTier: { ...PREMIUM_TIER_ENTITLEMENTS },
    },
  };
};

// Apple pricing tiles on the public site's black system (see ArticleLayout).
const planTileClass = 'relative flex flex-col rounded-[28px] bg-ink-surface p-7 sm:p-9';
const noteTileClass = 'rounded-[20px] bg-white/[0.05]';
const badgeClass = 'rounded-full px-3 py-1 text-[12px] font-medium';
const primaryButtonClass = `${goldButtonClass} w-full`;
const secondaryButtonClass = `${quietButtonClass} w-full`;

export default function PricingPage({ freeTier, premiumTier }: PricingPageProps) {
  const { isAuthenticated, account } = useAuth();
  const { t } = useTranslation();
  const router = useRouter();
  const [currentPlan, setCurrentPlan] = useState<'free' | 'premium' | null>(null);
  const [busyAction, setBusyAction] = useState<'checkout' | 'portal' | null>(null);
  const [showCancelledNotice, setShowCancelledNotice] = useState(false);

  // Cancel URL from checkout points at /pricing?billing=cancelled.
  useEffect(() => {
    if (router.isReady && router.query.billing === 'cancelled') {
      setShowCancelledNotice(true);
    }
  }, [router.isReady, router.query.billing]);

  // Resolve the signed-in user's plan so the Premium CTA can flip to
  // "Manage subscription". Silent on any failure — the server gates stay
  // authoritative; worst case the user sees the upgrade CTA and the API
  // routes them correctly.
  useEffect(() => {
    if (!BILLING_ENABLED || !isAuthenticated) {
      setCurrentPlan(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch('/api/billing/status', {
          method: 'GET',
          credentials: 'same-origin',
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) return;
        const body = await response.json();
        if (!cancelled && body?.success) {
          setCurrentPlan(body.data?.plan === 'premium' ? 'premium' : 'free');
        }
      } catch {
        /* keep null — CTA falls back to upgrade */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, account?.userAddr]);

  const startCheckout = useCallback(async () => {
    setBusyAction('checkout');
    try {
      const response = await fetch('/api/billing/checkout-session', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      });
      const body = await response.json().catch(() => null);
      if (response.ok && body?.success && body.data?.url) {
        window.location.assign(body.data.url);
        return;
      }
      if (response.status === 401) {
        toast.error('Please sign in again to upgrade.');
        router.push(`/?returnUrl=${encodeURIComponent('/pricing')}`);
        return;
      }
      if (response.status === 409) {
        toast('Billing is not live yet — everything is free for now.');
        return;
      }
      toast.error(body?.message || 'Could not start checkout. Please try again.');
    } catch {
      toast.error('Network error — could not start checkout.');
    } finally {
      setBusyAction(null);
    }
  }, [router]);

  const openBillingPortal = useCallback(async () => {
    setBusyAction('portal');
    try {
      const response = await fetch('/api/billing/portal-session', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      });
      const body = await response.json().catch(() => null);
      if (response.ok && body?.success && body.data?.url) {
        window.location.assign(body.data.url);
        return;
      }
      if (response.status === 401) {
        toast.error('Please sign in again to manage your subscription.');
        router.push(`/?returnUrl=${encodeURIComponent('/pricing')}`);
        return;
      }
      toast.error(body?.message || 'Could not open the billing portal. Please try again.');
    } catch {
      toast.error('Network error — could not open the billing portal.');
    } finally {
      setBusyAction(null);
    }
  }, [router]);

  const freeFeatures = [
    t('pricing.free.feature.circles', { count: freeTier.maxCircles }),
    t('pricing.free.feature.members', { count: freeTier.maxMembers }),
    t('pricing.free.feature.escrow'),
    t('pricing.free.feature.recovery'),
    t('pricing.free.feature.zklogin'),
  ];

  const premiumFeatures = [
    t('pricing.premium.feature.members', { count: premiumTier.maxMembers }),
    t('pricing.premium.feature.circles', { count: premiumTier.maxCircles }),
    t('pricing.premium.feature.whatsapp'),
    t('pricing.premium.feature.goals'),
    t('pricing.premium.feature.gasFree'),
    t('pricing.premium.feature.analytics'),
    t('pricing.premium.feature.everything'),
  ];


  // Premium CTA: coming soon (flag off) → sign in → upgrade / manage.
  let premiumCta: React.ReactNode;
  if (!BILLING_ENABLED) {
    premiumCta = (
      // Not a dimmed gold (reads as a broken primary) — a quiet, plainly
      // unavailable control.
      <button type="button" disabled className={secondaryButtonClass}>
        {t('pricing.ctaComingSoon')}
      </button>
    );
  } else if (!isAuthenticated) {
    premiumCta = (
      <Link
        href={`/?returnUrl=${encodeURIComponent('/pricing')}`}
        className={primaryButtonClass}
      >
        {t('pricing.ctaSignInToUpgrade')}
        <ArrowRight className="h-4 w-4" />
      </Link>
    );
  } else if (currentPlan === 'premium') {
    premiumCta = (
      <button
        type="button"
        onClick={openBillingPortal}
        disabled={busyAction !== null}
        className={secondaryButtonClass}
      >
        {busyAction === 'portal' ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('pricing.ctaOpeningPortal')}
          </>
        ) : (
          t('pricing.ctaManageSubscription')
        )}
      </button>
    );
  } else {
    premiumCta = (
      <button
        type="button"
        onClick={startCheckout}
        disabled={busyAction !== null}
        className={primaryButtonClass}
      >
        {busyAction === 'checkout' ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('pricing.ctaStartingCheckout')}
          </>
        ) : (
          <>
            {t('pricing.ctaUpgrade')}
            <ArrowRight className="h-4 w-4" />
          </>
        )}
      </button>
    );
  }

  return (
    <>
      <Seo
        title="Pricing"
        description="A free plan for small circles, and Premium for bigger circles, WhatsApp notifications, smart goals, and analytics. We never take a cut of contributions or payouts."
        path="/pricing"
        ogTitle="Pricing — Njangi On-Chain"
        ogDescription="Start free. Upgrade for bigger circles, WhatsApp notifications, smart goals, and analytics."
        image={{
          url: '/og/pricing.png',
          alt: 'Njangi On-Chain pricing — free to run a circle, pay only for coordination',
        }}
        themeColor="#000000"
        jsonLd={[breadcrumbs([{ name: 'Home', path: '/' }, { name: 'Pricing' }])]}
      />

      <MarketingShell
        legacy={false}
        headerControls={<LocaleSwitcher compact variant="glass" />}
        sheetExtras={() => (
          <div className="flex items-center justify-between gap-4">
            <span className="text-[13px] text-mist-3">Language</span>
            <LocaleSwitcher compact variant="glass" />
          </div>
        )}
      >
        {/* ================= HERO ================= */}
        <header className="relative overflow-hidden">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(900px_460px_at_50%_-12%,rgba(232,176,75,0.10),transparent_64%)]"
          />
          <div className="relative mx-auto max-w-[980px] px-5 pb-14 pt-8 text-center sm:px-8 md:pb-20 md:pt-12">
            <Breadcrumbs
              className="flex justify-center"
              items={[
                { label: t('pricing.breadcrumbHome'), href: '/' },
                { label: t('pricing.breadcrumbPricing') },
              ]}
            />
            <p className="type-eyebrow mt-12 text-gold">{t('pricing.eyebrow')}</p>
            <h1 className="type-hero mx-auto mt-3 max-w-[16ch] text-balance text-mist">
              {t('pricing.title')}
            </h1>
            <p className="type-intro mx-auto mt-6 max-w-[40rem] text-balance text-mist-2">
              {t('pricing.subtitle')}
            </p>
            {!BILLING_ENABLED && (
              <p className="mt-8 inline-flex items-center gap-2 rounded-full bg-gold/[0.12] px-4 py-2 text-[14px] font-medium text-gold-hi">
                <Sparkles aria-hidden className="h-4 w-4" />
                {t('pricing.comingSoonBanner')}
              </p>
            )}
          </div>
        </header>

        {showCancelledNotice && (
          <div className="mx-auto max-w-[980px] px-5 sm:px-8">
            <div
              role="status"
              className="mb-8 flex items-start justify-between gap-4 rounded-[20px] bg-gold/[0.1] px-5 py-4 text-[14px] leading-6 text-gold-hi"
            >
              <p>{t('pricing.cancelledNotice')}</p>
              <button
                type="button"
                onClick={() => setShowCancelledNotice(false)}
                className="rounded-full p-1 text-gold-hi transition-colors hover:bg-white/[0.08] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/80"
              >
                <X className="h-4 w-4" />
                <span className="sr-only">Dismiss</span>
              </button>
            </div>
          </div>
        )}

        {/* ================= PLANS ================= */}
        <main className="mx-auto max-w-[980px] px-5 pb-24 sm:px-8 md:pb-32">
          <div className="grid gap-4 md:grid-cols-2 md:gap-5">
            {/* Free tier */}
            <section className={planTileClass}>
              <div className="flex items-center justify-between gap-4">
                <h2 className="type-tile text-mist">{t('pricing.free')}</h2>
                <span className={`${badgeClass} bg-white/[0.08] text-mist-2`}>
                  {t('pricing.alwaysFreeBadge')}
                </span>
              </div>
              <div className="mt-6 flex items-baseline gap-2">
                <span className="text-[3.5rem] font-semibold leading-none tracking-[-0.02em] text-mist">
                  $0
                </span>
                <span className="type-caption text-mist-3">{t('pricing.forever')}</span>
              </div>
              <p className="type-body mt-4 text-mist-2">{t('pricing.freeBlurb')}</p>

              <ul className="mt-7 flex-1 space-y-3 border-t border-white/[0.08] pt-7">
                {freeFeatures.map((feature) => (
                  <li key={feature} className="type-caption flex items-start gap-3 text-mist-2">
                    <Check aria-hidden className="mt-0.5 h-4 w-4 flex-shrink-0 text-mist-3" strokeWidth={2.2} />
                    <span>{feature}</span>
                  </li>
                ))}
              </ul>

              <div className={`${noteTileClass} mt-7 flex items-start gap-3 p-4`}>
                <ShieldCheck aria-hidden className="mt-0.5 h-4 w-4 flex-shrink-0 text-gold" />
                <p className="type-fine text-mist-2">
                  <span className="font-semibold text-mist">{t('pricing.alwaysFreeNoteLabel')}</span>{' '}
                  {t('pricing.alwaysFreeNoteBody')}
                </p>
              </div>

              <div className="mt-7">
                {isAuthenticated ? (
                  <Link href="/dashboard" className={secondaryButtonClass}>
                    {t('pricing.ctaGoToDashboard')}
                  </Link>
                ) : (
                  <Link href="/" className={secondaryButtonClass}>
                    {t('pricing.ctaGetStarted')}
                  </Link>
                )}
              </div>
            </section>

            {/* Premium tier */}
            <section className={`${planTileClass} ring-1 ring-gold/35`}>
              <div
                aria-hidden
                className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full"
                style={{ background: 'radial-gradient(closest-side, rgba(232,176,75,0.14), transparent)' }}
              />
              <div className="relative flex items-center justify-between gap-4">
                <h2 className="type-tile flex items-center gap-2 text-mist">
                  <Crown aria-hidden className="h-5 w-5 text-gold" />
                  {t('pricing.premium')}
                </h2>
                {!BILLING_ENABLED ? (
                  <span className={`${badgeClass} bg-gold/[0.14] text-gold-hi`}>
                    {t('pricing.comingSoon')}
                  </span>
                ) : currentPlan === 'premium' ? (
                  <span className={`${badgeClass} bg-[#30d158]/[0.14] text-[#30d158]`}>
                    {t('pricing.yourPlan')}
                  </span>
                ) : (
                  <span className={`${badgeClass} bg-white/[0.08] text-mist-2`}>
                    {t('pricing.forOrganizers')}
                  </span>
                )}
              </div>
              <div className="relative mt-6 flex items-baseline gap-2">
                <span className="text-[3.5rem] font-semibold leading-none tracking-[-0.02em] text-mist">
                  {PREMIUM_PRICE_LABEL}
                </span>
                <span className="type-caption text-mist-3">{t('pricing.perMonth')}</span>
              </div>
              <p className="type-body relative mt-4 text-mist-2">{t('pricing.premiumBlurb')}</p>

              <ul className="relative mt-7 flex-1 space-y-3 border-t border-white/[0.08] pt-7">
                {premiumFeatures.map((feature) => (
                  <li key={feature} className="type-caption flex items-start gap-3 text-mist-2">
                    <Check aria-hidden className="mt-0.5 h-4 w-4 flex-shrink-0 text-gold" strokeWidth={2.2} />
                    <span>{feature}</span>
                  </li>
                ))}
              </ul>

              <p className="type-fine relative mt-7 text-mist-3">{t('pricing.billedMonthly')}</p>

              <div className="relative mt-4">{premiumCta}</div>
            </section>
          </div>

          {/* Non-custodial assurance */}
          <section className="mt-5 rounded-[28px] bg-ink-surface p-7 sm:p-9">
            <div className="flex items-start gap-4">
              <span className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full bg-gold/[0.12] text-gold">
                <ShieldCheck aria-hidden className="h-5 w-5" />
              </span>
              <div>
                <h2 className="text-[21px] font-semibold tracking-[0.011em] text-mist">
                  {t('pricing.assuranceTitle')}
                </h2>
                <p className="type-body mt-2 max-w-3xl text-mist-2">{t('pricing.assuranceBody')}</p>
              </div>
            </div>
          </section>

          {/* Mini FAQ */}
          <section className="mt-24 md:mt-32">
            <h2 className="type-section text-center text-balance text-mist">{t('pricing.faqTitle')}</h2>
            <div className="mt-12 grid gap-4 md:grid-cols-2 md:gap-5">
              {(['whoPays', 'cancel', 'fees', 'gasFree'] as const).map((key) => (
                <div key={key} className="rounded-[28px] bg-ink-surface p-7 sm:p-8">
                  <h3 className="text-[19px] font-semibold tracking-[0.012em] text-mist">
                    {t(`pricing.faq.${key}.q`)}
                  </h3>
                  <p className="type-body mt-3 text-mist-2">{t(`pricing.faq.${key}.a`)}</p>
                </div>
              ))}
            </div>
          </section>
        </main>

        {/* ================= DISCLAIMER ================= */}
        <aside className="px-5 pb-16 sm:px-8">
          <p className="type-fine mx-auto max-w-[44rem] text-center text-mist-3">
            {t('pricing.footerDisclaimer')}
          </p>
        </aside>
      </MarketingShell>
    </>
  );
}
