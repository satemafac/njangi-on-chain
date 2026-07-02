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
import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import type { GetStaticProps } from 'next';
import { Instrument_Serif, Manrope } from 'next/font/google';
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

const wordmarkFont = Instrument_Serif({
  subsets: ['latin'],
  weight: '400',
  display: 'swap',
});

const bodyFont = Manrope({
  subsets: ['latin'],
  display: 'swap',
});

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

const sectionEyebrowClass =
  'text-[11px] font-semibold uppercase tracking-[0.28em] text-[#717784]';
const shellCardClass =
  'rounded-[30px] border border-[#ddd5c9] bg-white/88 shadow-[0_30px_90px_-62px_rgba(15,23,42,0.42)] backdrop-blur';
const mutedCardClass = 'rounded-[24px] border border-[#e9e1d6] bg-[#fbfaf7]';
const primaryButtonClass =
  'inline-flex w-full items-center justify-center gap-2 rounded-full bg-[#1d2533] px-5 py-3 text-sm font-semibold text-white shadow-[0_18px_44px_-34px_rgba(15,23,42,0.45)] transition-all duration-200 hover:-translate-y-0.5 hover:bg-[#101723] disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0';
const secondaryButtonClass =
  'inline-flex w-full items-center justify-center gap-2 rounded-full border border-[#d5ccbf] bg-white px-5 py-3 text-sm font-semibold text-[#334155] transition-colors duration-200 hover:bg-[#f6f3ee]';

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

  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'https://njangionchain.com';

  // Premium CTA: coming soon (flag off) → sign in → upgrade / manage.
  let premiumCta: React.ReactNode;
  if (!BILLING_ENABLED) {
    premiumCta = (
      <button type="button" disabled className={primaryButtonClass}>
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
      <Head>
        <title>Pricing | Njangi On-Chain — Free and Premium Savings Circles</title>
        <meta
          name="description"
          content="Njangi On-Chain pricing: a free plan for small circles and a Premium plan with bigger circles, WhatsApp notifications, smart goals, and analytics. Your funds are never behind a paywall."
        />
        <link rel="canonical" href={`${baseUrl}/pricing`} />
        <meta property="og:type" content="website" />
        <meta property="og:url" content={`${baseUrl}/pricing`} />
        <meta property="og:title" content="Pricing — Njangi On-Chain" />
        <meta
          property="og:description"
          content="Start free. Upgrade for bigger circles, WhatsApp notifications, smart goals, and analytics."
        />
        <meta property="og:image" content={`${baseUrl}/njangi-on-chain-logo.png`} />
        <meta name="theme-color" content="#f6f3ee" />
      </Head>

      <div
        className={`${bodyFont.className} relative min-h-screen overflow-hidden bg-[#f6f3ee] text-[#171923]`}
      >
        <div className="pointer-events-none absolute inset-x-0 top-0 h-[520px] bg-[radial-gradient(circle_at_top_left,_rgba(108,122,147,0.18),_transparent_36%),radial-gradient(circle_at_85%_10%,_rgba(218,204,178,0.34),_transparent_26%),linear-gradient(180deg,_rgba(255,255,255,0.58)_0%,_rgba(246,243,238,0)_72%)]" />

        {/* Breadcrumb */}
        <nav className="relative border-b border-[#e9e1d6] bg-white/60 backdrop-blur">
          <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
            <div className="flex items-center justify-between gap-3 py-3 text-sm text-[#596170]">
              <div className="flex items-center space-x-2">
                <Link href="/" className="transition-colors hover:text-[#171923]">
                  {t('pricing.breadcrumbHome')}
                </Link>
                <span>/</span>
                <span className="font-medium text-[#171923]">{t('pricing.breadcrumbPricing')}</span>
              </div>
              <LocaleSwitcher compact />
            </div>
          </div>
        </nav>

        {/* Hero */}
        <section className="relative">
          <div className="mx-auto max-w-4xl px-4 pb-12 pt-16 text-center sm:px-6 lg:px-8">
            <p className={sectionEyebrowClass}>{t('pricing.eyebrow')}</p>
            <h1
              className={`${wordmarkFont.className} mt-4 text-4xl tracking-[-0.03em] text-[#171923] sm:text-5xl`}
            >
              {t('pricing.title')}
            </h1>
            <p className="mx-auto mt-5 max-w-2xl text-base leading-7 text-[#596170] sm:text-lg">
              {t('pricing.subtitle')}
            </p>
            {!BILLING_ENABLED && (
              <div className="mt-6 inline-flex items-center gap-2 rounded-full border border-[#d8b66a]/60 bg-[#fdf6e7] px-4 py-2 text-sm font-medium text-[#8a5a21]">
                <Sparkles className="h-4 w-4" />
                {t('pricing.comingSoonBanner')}
              </div>
            )}
          </div>
        </section>

        {showCancelledNotice && (
          <div className="relative mx-auto max-w-4xl px-4 sm:px-6 lg:px-8">
            <div className="mb-8 flex items-start justify-between gap-4 rounded-[20px] border border-[#e0cfae] bg-[#fdf6e7] px-5 py-4 text-sm leading-6 text-[#8a5a21]">
              <p>{t('pricing.cancelledNotice')}</p>
              <button
                type="button"
                onClick={() => setShowCancelledNotice(false)}
                className="rounded-full p-1 text-[#8a5a21] transition-colors hover:bg-[#f4e8cf]"
              >
                <X className="h-4 w-4" />
                <span className="sr-only">Dismiss</span>
              </button>
            </div>
          </div>
        )}

        {/* Plans */}
        <main className="relative mx-auto max-w-5xl px-4 pb-16 sm:px-6 lg:px-8">
          <div className="grid gap-6 md:grid-cols-2">
            {/* Free tier */}
            <section className={`${shellCardClass} flex flex-col p-7 sm:p-8`}>
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold tracking-[-0.02em] text-[#171923]">
                  {t('pricing.free')}
                </h2>
                <span className="rounded-full border border-[#e9e1d6] bg-[#fbfaf7] px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-[#717784]">
                  {t('pricing.alwaysFreeBadge')}
                </span>
              </div>
              <div className="mt-4 flex items-baseline gap-2">
                <span className="text-4xl font-semibold tracking-[-0.04em] text-[#171923]">
                  $0
                </span>
                <span className="text-sm text-[#596170]">{t('pricing.forever')}</span>
              </div>
              <p className="mt-3 text-sm leading-6 text-[#596170]">
                {t('pricing.freeBlurb')}
              </p>

              <ul className="mt-6 flex-1 space-y-3">
                {freeFeatures.map((feature) => (
                  <li key={feature} className="flex items-start gap-3 text-sm leading-6 text-[#334155]">
                    <Check className="mt-0.5 h-4 w-4 flex-shrink-0 text-[#3f7d54]" />
                    <span>{feature}</span>
                  </li>
                ))}
              </ul>

              <div className={`${mutedCardClass} mt-6 flex items-start gap-3 p-4`}>
                <ShieldCheck className="mt-0.5 h-4 w-4 flex-shrink-0 text-[#3f7d54]" />
                <p className="text-xs leading-5 text-[#4b5565]">
                  <span className="font-semibold text-[#171923]">
                    {t('pricing.alwaysFreeNoteLabel')}
                  </span>{' '}
                  {t('pricing.alwaysFreeNoteBody')}
                </p>
              </div>

              <div className="mt-6">
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
            <section
              className={`${shellCardClass} relative flex flex-col border-[#c9bda7] p-7 ring-1 ring-[#d8cdb8] sm:p-8`}
            >
              <div className="flex items-center justify-between">
                <h2 className="flex items-center gap-2 text-lg font-semibold tracking-[-0.02em] text-[#171923]">
                  <Crown className="h-4 w-4 text-[#a07b2f]" />
                  {t('pricing.premium')}
                </h2>
                {!BILLING_ENABLED ? (
                  <span className="rounded-full border border-[#d8b66a]/60 bg-[#fdf6e7] px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-[#8a5a21]">
                    {t('pricing.comingSoon')}
                  </span>
                ) : currentPlan === 'premium' ? (
                  <span className="rounded-full border border-[#bcd6c4] bg-[#eef6f0] px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-[#3f7d54]">
                    {t('pricing.yourPlan')}
                  </span>
                ) : (
                  <span className="rounded-full border border-[#d8cdb8] bg-[#faf7f0] px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-[#7a6a45]">
                    {t('pricing.forOrganizers')}
                  </span>
                )}
              </div>
              <div className="mt-4 flex items-baseline gap-2">
                <span className="text-4xl font-semibold tracking-[-0.04em] text-[#171923]">
                  {PREMIUM_PRICE_LABEL}
                </span>
                <span className="text-sm text-[#596170]">{t('pricing.perMonth')}</span>
              </div>
              <p className="mt-3 text-sm leading-6 text-[#596170]">
                {t('pricing.premiumBlurb')}
              </p>

              <ul className="mt-6 flex-1 space-y-3">
                {premiumFeatures.map((feature) => (
                  <li key={feature} className="flex items-start gap-3 text-sm leading-6 text-[#334155]">
                    <Check className="mt-0.5 h-4 w-4 flex-shrink-0 text-[#a07b2f]" />
                    <span>{feature}</span>
                  </li>
                ))}
              </ul>

              <p className="mt-6 text-xs leading-5 text-[#717784]">
                {t('pricing.billedMonthly')}
              </p>

              <div className="mt-4">{premiumCta}</div>
            </section>
          </div>

          {/* Non-custodial assurance */}
          <section className={`${mutedCardClass} mt-10 p-6 sm:p-8`}>
            <div className="flex items-start gap-4">
              <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full border border-[#dcd3c4] bg-white">
                <ShieldCheck className="h-5 w-5 text-[#3f7d54]" />
              </div>
              <div>
                <h2 className="text-lg font-semibold tracking-[-0.02em] text-[#171923]">
                  {t('pricing.assuranceTitle')}
                </h2>
                <p className="mt-2 max-w-3xl text-sm leading-6 text-[#596170]">
                  {t('pricing.assuranceBody')}
                </p>
              </div>
            </div>
          </section>

          {/* Mini FAQ */}
          <section className="mt-12">
            <h2 className="text-center text-2xl font-semibold tracking-[-0.03em] text-[#171923]">
              {t('pricing.faqTitle')}
            </h2>
            <div className="mt-6 grid gap-4 md:grid-cols-3">
              <div className={`${shellCardClass} p-5`}>
                <h3 className="text-sm font-semibold text-[#171923]">
                  {t('pricing.faq.whoPays.q')}
                </h3>
                <p className="mt-2 text-sm leading-6 text-[#596170]">
                  {t('pricing.faq.whoPays.a')}
                </p>
              </div>
              <div className={`${shellCardClass} p-5`}>
                <h3 className="text-sm font-semibold text-[#171923]">
                  {t('pricing.faq.cancel.q')}
                </h3>
                <p className="mt-2 text-sm leading-6 text-[#596170]">
                  {t('pricing.faq.cancel.a')}
                </p>
              </div>
              <div className={`${shellCardClass} p-5`}>
                <h3 className="text-sm font-semibold text-[#171923]">
                  {t('pricing.faq.fees.q')}
                </h3>
                <p className="mt-2 text-sm leading-6 text-[#596170]">
                  {t('pricing.faq.fees.a')}
                </p>
              </div>
              <div className={`${shellCardClass} p-5`}>
                <h3 className="text-sm font-semibold text-[#171923]">
                  {t('pricing.faq.gasFree.q')}
                </h3>
                <p className="mt-2 text-sm leading-6 text-[#596170]">
                  {t('pricing.faq.gasFree.a')}
                </p>
              </div>
            </div>
          </section>
        </main>

        {/* Footer */}
        <footer className="relative border-t border-[#e9e1d6] bg-white/60">
          <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
            <p className="text-center text-xs leading-5 text-[#717784]">
              {t('pricing.footerDisclaimer')}
            </p>
          </div>
        </footer>
      </div>
    </>
  );
}
