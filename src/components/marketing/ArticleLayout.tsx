// ArticleLayout — the shell for every public content page.
//
// Two problems this solves at once:
//
// 1. Brand split. The landing and /pricing use the dark + gold system; /learn,
//    /faq and /blog were white pages with a different coloured gradient hero
//    each (green, indigo, purple, orange, blue). Search traffic lands on those
//    pages first, so a visitor's first impression of the product was a page
//    that looked nothing like the homepage.
//
// 2. No shared navigation. src/pages/_app.tsx only renders <Navbar> when the
//    user is authenticated, so marketing pages had no site nav at all — each
//    page hand-rolled its own breadcrumb strip and nothing else. Beyond the
//    obvious UX cost, an internal link graph is what Google uses to work out
//    site structure, which is a precondition for sitelinks.
//
// Colours are the promoted Tailwind tokens (tailwind.config.ts): ink, gold,
// cream, sand.

import Image from 'next/image';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Instrument_Serif, Manrope } from 'next/font/google';

import { LegalFooter } from '../LegalFooter';

const wordmarkFont = Instrument_Serif({ subsets: ['latin'], weight: '400', display: 'swap' });
const bodyFont = Manrope({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  display: 'swap',
});

const NAV_LINKS = [
  { href: '/learn', label: 'Learn' },
  { href: '/faq', label: 'FAQ' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/blog', label: 'Writing' },
];

const navLinkClass =
  'text-sm font-medium text-cream-muted transition-colors duration-200 hover:text-gold-hi focus-visible:outline-none focus-visible:underline focus-visible:underline-offset-4';

export const goldButtonClass =
  'inline-flex items-center justify-center gap-2 rounded-full bg-gradient-to-r from-gold-hi via-gold to-gold-deep px-6 py-3 text-sm font-semibold text-gold-on shadow-[0_14px_44px_-14px_rgba(232,176,75,0.6)] transition-transform duration-200 hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-hi focus-visible:ring-offset-2 focus-visible:ring-offset-ink';

export const ghostButtonClass =
  'inline-flex items-center justify-center gap-2 rounded-full border border-gold-deep/55 bg-white/[0.03] px-6 py-3 text-sm font-semibold text-gold-hi backdrop-blur transition-colors duration-200 hover:border-gold hover:bg-gold/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-hi focus-visible:ring-offset-2 focus-visible:ring-offset-ink';

export const cardClass =
  'rounded-3xl border border-ink-border bg-ink-surface/85 shadow-[0_20px_60px_-30px_rgba(0,0,0,0.85)] backdrop-blur-sm';

export const chipClass =
  'inline-flex items-center gap-2 rounded-full border border-ink-border bg-ink-surface/70 px-4 py-2 text-sm font-medium text-cream-muted';

export const eyebrowClass =
  'text-[11px] font-semibold uppercase tracking-[0.32em] text-gold';

export function Wordmark({ className = '' }: { className?: string }) {
  return (
    <Link href="/" className={`flex min-w-0 items-center gap-3 ${className}`}>
      {/* The generated icon tile rather than njangi-on-chain-logo.png: same
          artwork, but pre-trimmed and on an opaque ground, so it fills its box
          without the scale-[2.25] hack the untrimmed file used to need. */}
      <Image
        src="/icons/icon-192.png"
        alt=""
        width={48}
        height={48}
        className="h-12 w-12 shrink-0 rounded-2xl border border-white/10"
        priority
      />
      <span className="min-w-0">
        <span
          className={`${wordmarkFont.className} block truncate text-[1.9rem] leading-none tracking-[-0.04em] text-cream`}
        >
          Njangi
        </span>
        <span className="mt-1 block truncate pl-0.5 text-[0.62rem] font-semibold uppercase tracking-[0.42em] text-gold">
          On-chain
        </span>
      </span>
    </Link>
  );
}

export interface Crumb {
  label: string;
  href?: string;
}

/**
 * Visible breadcrumbs. The matching BreadcrumbList JSON-LD is emitted by each
 * page's <Seo jsonLd>; keep the two in step — Google expects the markup to
 * describe a trail the user can actually see.
 */
function Breadcrumbs({ items }: { items: Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb" className="border-b border-ink-border/60">
      <ol className="mx-auto flex max-w-4xl flex-wrap items-center gap-x-2 gap-y-1 px-5 py-3 text-sm text-sand sm:px-8">
        {items.map((item, index) => (
          <li key={item.href ?? item.label} className="flex items-center gap-2">
            {index > 0 && (
              <span aria-hidden="true" className="text-ink-border">
                /
              </span>
            )}
            {item.href ? (
              <Link
                href={item.href}
                className="transition-colors duration-200 hover:text-gold-hi"
              >
                {item.label}
              </Link>
            ) : (
              <span className="font-medium text-cream" aria-current="page">
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
 * Header + footer only, no hero.
 *
 * For the legacy long-form pages (/learn/*, /faq, /blog/*) which already have
 * their own hero, table of contents and section structure. They get the shared
 * navigation and the dark ground without their content being restructured;
 * their internal markup is recoloured onto the same tokens. New pages should
 * use ArticleLayout instead, which owns the hero too.
 */
export function MarketingShell({ children }: { children: ReactNode }) {
  return (
    <div
      className={`${bodyFont.className} relative min-h-screen overflow-x-clip bg-ink text-cream`}
    >
      <a
        href="#main"
        className="sr-only rounded-full focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[60] focus:bg-gold focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-gold-on"
      >
        Skip to content
      </a>

      <header className="sticky top-0 z-30 border-b border-ink-border/80 bg-ink/70 backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-5 py-4 sm:px-8">
          <Wordmark />
          <div className="flex flex-wrap items-center gap-5">
            <nav aria-label="Main" className="flex flex-wrap items-center gap-5">
              {NAV_LINKS.map((link) => (
                <Link key={link.href} href={link.href} className={navLinkClass}>
                  {link.label}
                </Link>
              ))}
            </nav>
            <Link href="/create-circle" className={`${goldButtonClass} !px-5 !py-2`}>
              Start a circle
            </Link>
          </div>
        </div>
      </header>

      {children}

      <SiteFooter />
    </div>
  );
}

function SiteFooter() {
  return (
    <footer className="border-t border-ink-border bg-ink/80">
      <div className="mx-auto flex max-w-6xl flex-col gap-8 px-5 py-12 sm:px-8">
        <div className="flex flex-wrap items-start justify-between gap-8">
          <div className="max-w-sm">
            <Wordmark />
            <p className="mt-4 text-sm leading-6 text-sand-dim">
              Coordination software for rotating savings circles. Built on Sui with zkLogin, so
              joining takes a social sign-in rather than a seed phrase.
            </p>
          </div>
          <nav aria-label="Footer" className="flex flex-col gap-2">
            {NAV_LINKS.map((link) => (
              <Link key={link.href} href={link.href} className={navLinkClass}>
                {link.label}
              </Link>
            ))}
          </nav>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-4 border-t border-ink-border pt-6">
          <LegalFooter className="!text-sand-dim [&_a:hover]:!text-gold-hi [&_span]:!text-ink-border" />
          <p className="text-xs text-sand-dim">© {new Date().getFullYear()} Njangi On-Chain</p>
        </div>
      </div>
    </footer>
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
    <div
      className={`${bodyFont.className} relative min-h-screen overflow-x-clip bg-ink text-cream`}
    >
      <a
        href="#main"
        className="sr-only rounded-full focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[60] focus:bg-gold focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-gold-on"
      >
        Skip to content
      </a>

      <header className="sticky top-0 z-30 border-b border-ink-border/80 bg-ink/70 backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-5 py-4 sm:px-8">
          <Wordmark />
          <div className="flex flex-wrap items-center gap-5">
            <nav aria-label="Main" className="flex flex-wrap items-center gap-5">
              {NAV_LINKS.map((link) => (
                <Link key={link.href} href={link.href} className={navLinkClass}>
                  {link.label}
                </Link>
              ))}
            </nav>
            <Link href="/create-circle" className={`${goldButtonClass} !px-5 !py-2`}>
              Start a circle
            </Link>
          </div>
        </div>
      </header>

      {breadcrumbs?.length ? <Breadcrumbs items={breadcrumbs} /> : null}

      <main id="main">
        <div className="relative overflow-hidden border-b border-ink-border">
          {/* Single warm bloom, matching the OG cards and the landing hero. */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(900px_460px_at_78%_-10%,rgba(232,176,75,0.14),transparent_64%)]"
          />
          <div className="relative mx-auto max-w-4xl px-5 py-16 sm:px-8 sm:py-20">
            {eyebrow && <p className={eyebrowClass}>{eyebrow}</p>}
            <h1
              className={`${wordmarkFont.className} mt-4 text-[clamp(2.2rem,5vw,3.4rem)] font-normal leading-[1.06] tracking-[-0.01em] text-cream`}
            >
              {title}
            </h1>
            {standfirst && (
              <div className="mt-6 max-w-3xl text-lg leading-8 text-sand">{standfirst}</div>
            )}
            {meta && <div className="mt-8">{meta}</div>}
          </div>
        </div>

        <div className="mx-auto max-w-4xl px-5 py-14 sm:px-8">{children}</div>

        {!hideCta && (
          <section className="mx-auto max-w-4xl px-5 pb-20 sm:px-8">
            <div className={`${cardClass} px-7 py-9 sm:px-10`}>
              <h2
                className={`${wordmarkFont.className} text-[clamp(1.6rem,3vw,2.2rem)] leading-tight text-cream`}
              >
                Run your circle with the rules in the open
              </h2>
              <p className="mt-4 max-w-2xl text-base leading-7 text-sand">
                Njangi On-Chain keeps the tradition exactly as it is — everyone contributes on
                schedule, everyone takes a turn — and puts the schedule, the order, and the full
                history where the whole circle can see them. No treasurer holding the money.
              </p>
              <div className="mt-7 flex flex-wrap gap-3">
                <Link href="/create-circle" className={goldButtonClass}>
                  Start a circle
                </Link>
                <Link href="/learn" className={ghostButtonClass}>
                  Browse the traditions
                </Link>
              </div>
            </div>
          </section>
        )}
      </main>

      <SiteFooter />
    </div>
  );
}

export default ArticleLayout;
