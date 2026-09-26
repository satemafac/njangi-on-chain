// ArticleLayout — the shell for every public content page.
//
// Two problems this has solved since 2026-08:
//
// 1. Brand split. /learn, /faq and /blog were white template pages with a
//    different coloured gradient hero each; search traffic lands on them
//    first, so a visitor's first impression looked nothing like the homepage.
//    They now share the landing's Apple system: SF Pro (`.apple`), the black
//    canvas, the frosted global bar, gold as the single accent.
//
// 2. No shared navigation. src/pages/_app.tsx only renders <Navbar> for
//    signed-in users, so marketing pages had no site nav at all. An internal
//    link graph is also what Google uses to work out site structure (a
//    precondition for sitelinks), so the bar and footer link every section.
//
// Colours are the Tailwind tokens (tailwind.config.ts) — ink/cream/sand here
// resolve to the same neutrals as the landing's night/mist.

import Head from 'next/head';
import Link from 'next/link';
import type { ReactNode } from 'react';

import SiteHeader, { type SiteNavLink } from '../landing/SiteHeader';
import SiteFooter from '../landing/SiteFooter';
import { sansFont } from '../landing/fonts';
import {
  ChevronLink,
  eyebrowClass as appleEyebrowClass,
  goldButtonClass as appleGoldButtonClass,
  quietButtonClass,
} from '../landing/ui';

const NAV_LINKS: SiteNavLink[] = [
  { href: '/learn', label: 'Learn' },
  { href: '/faq', label: 'FAQ' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/blog', label: 'Writing' },
];

// Shared by the article bodies. Apple-style: pill buttons that press rather
// than lift, tiles lifted a few steps off black with no drop shadow.
export const goldButtonClass = appleGoldButtonClass;
export const ghostButtonClass = quietButtonClass;
export const cardClass = 'rounded-[28px] bg-ink-surface ring-1 ring-white/[0.06]';
export const chipClass =
  'inline-flex items-center gap-2 rounded-full bg-white/[0.06] px-4 py-2 text-sm font-medium text-cream-muted';
export const eyebrowClass = appleEyebrowClass;

export interface Crumb {
  label: string;
  href?: string;
}

/**
 * Visible breadcrumbs. The matching BreadcrumbList JSON-LD is emitted by each
 * page's <Seo jsonLd>; keep the two in step — Google expects the markup to
 * describe a trail the user can actually see.
 */
export function Breadcrumbs({ items, className = '' }: { items: Crumb[]; className?: string }) {
  return (
    <nav aria-label="Breadcrumb" className={className}>
      <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12px] text-mist-3">
        {items.map((item, index) => (
          <li key={item.href ?? item.label} className="flex items-center gap-1.5">
            {index > 0 && (
              <span aria-hidden="true" className="text-mist-4 rtl:rotate-180">
                ›
              </span>
            )}
            {item.href ? (
              <Link
                href={item.href}
                className="rounded transition-colors duration-200 hover:text-mist focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/80"
              >
                {item.label}
              </Link>
            ) : (
              <span className="text-mist-2" aria-current="page">
                {item.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

/**
 * Header + footer only, no hero — for pages that own their layout.
 *
 * `legacy` (default on) scopes the `.mkt-legacy` content adapter from
 * globals.css to the children: the older long-form pages (/learn/*, /blog/*)
 * keep their markup and are lifted onto the Apple system around it. Pages
 * rebuilt natively on the system pass `legacy={false}`.
 */
export function MarketingShell({
  children,
  legacy = true,
  headerControls,
  sheetExtras,
}: {
  children: ReactNode;
  legacy?: boolean;
  /** Desktop controls in the global bar (e.g. the language switcher). */
  headerControls?: ReactNode;
  /** Extra rows for the mobile menu sheet. */
  sheetExtras?: (close: () => void) => ReactNode;
}) {
  return (
    <div
      className={`apple ${sansFont.variable} relative min-h-screen overflow-x-clip bg-black text-mist`}
    >
      <Head>
        {/* Dark page: tint iOS safe areas / overscroll black instead of the
            app's global white body. Same key as <Seo>'s theme-color so the
            two never duplicate. */}
        <meta name="color-scheme" content="dark" />
        <meta key="seo:theme-color" name="theme-color" content="#000000" />
        <style>{`html,body{background-color:#000!important}`}</style>
      </Head>

      <a
        href="#main"
        className="sr-only rounded-full focus:not-sr-only focus:fixed focus:left-4 focus:top-3 focus:z-[60] focus:bg-gold focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-[#1d1d1f]"
      >
        Skip to content
      </a>

      <SiteHeader
        links={NAV_LINKS}
        primary={{ label: 'Start a circle', href: '/create-circle' }}
        controls={headerControls}
        sheetExtras={sheetExtras}
      />

      <div id="main" tabIndex={-1} className={`pt-[52px] focus:outline-none ${legacy ? 'mkt-legacy' : ''}`}>
        {children}
      </div>

      <SiteFooter
        links={[
          ...NAV_LINKS,
          { href: 'https://x.com/njangi_on_chain', label: 'X', external: true },
          { href: 'https://www.instagram.com/njangionchain', label: 'Instagram', external: true },
        ]}
        description="Coordination software for rotating savings circles. Built on Sui with zkLogin, so joining takes a social sign-in rather than a seed phrase."
        rights={`© ${new Date().getFullYear()} Njangi On-Chain`}
      />
    </div>
  );
}

export interface ArticleLayoutProps {
  eyebrow?: string;
  title: string;
  standfirst?: ReactNode;
  breadcrumbs?: Crumb[];
  /** Rendered under the standfirst, before the body — for pronunciation, region, etc. */
  meta?: ReactNode;
  children: ReactNode;
  /** Suppress the closing call to action on pages where it would be out of place. */
  hideCta?: boolean;
}

/** MarketingShell plus an Apple article hero and a closing call to action. */
export function ArticleLayout({
  eyebrow,
  title,
  standfirst,
  breadcrumbs,
  meta,
  children,
  hideCta = false,
}: ArticleLayoutProps) {
  return (
    <MarketingShell legacy={false}>
      <main>
        <header className="relative overflow-hidden">
          {/* One warm bloom, matching the landing's horizon. */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(900px_460px_at_78%_-10%,rgba(232,176,75,0.10),transparent_64%)]"
          />
          <div className="relative mx-auto max-w-[980px] px-5 pb-14 pt-8 sm:px-8 md:pb-20 md:pt-12">
            {breadcrumbs?.length ? <Breadcrumbs items={breadcrumbs} /> : null}
            {eyebrow && <p className={`${eyebrowClass} mt-10`}>{eyebrow}</p>}
            <h1 className={`type-section max-w-[22ch] text-balance text-mist ${eyebrow ? 'mt-3' : 'mt-10'}`}>
              {title}
            </h1>
            {standfirst && (
              <div className="type-intro mt-6 max-w-[42rem] text-mist-2">{standfirst}</div>
            )}
            {meta && <div className="mt-8">{meta}</div>}
          </div>
        </header>

        {/* The hero and CTA are native; only the article body is legacy markup. */}
        <div className="mkt-legacy mx-auto max-w-4xl px-5 pb-16 sm:px-8">{children}</div>

        {!hideCta && (
          <section className="mx-auto max-w-[980px] px-5 pb-24 sm:px-8">
            <div className="relative overflow-hidden rounded-[28px] bg-ink-surface px-7 py-14 text-center sm:px-12">
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-0 -top-32 mx-auto h-64 max-w-[640px] rounded-full"
                style={{ background: 'radial-gradient(closest-side, rgba(232,176,75,0.14), transparent)' }}
              />
              <h2 className="type-headline relative text-balance text-mist">
                Run your circle with the rules in the open
              </h2>
              <p className="type-body relative mx-auto mt-4 max-w-[36rem] text-mist-2">
                Njangi On-Chain keeps the tradition exactly as it is — everyone contributes on
                schedule, everyone takes a turn — and puts the schedule, the order, and the full
                history where the whole circle can see them. No treasurer holding the money.
              </p>
              <div className="relative mt-8 flex flex-col items-center justify-center gap-5 sm:flex-row sm:gap-8">
                <Link href="/create-circle" className={goldButtonClass}>
                  Start a circle
                </Link>
                <ChevronLink href="/learn">Browse the traditions</ChevronLink>
              </div>
            </div>
          </section>
        )}
      </main>
    </MarketingShell>
  );
}

export default ArticleLayout;
