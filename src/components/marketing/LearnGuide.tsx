// LearnGuide — the layout for the original /learn guides (njangi, ROSCA,
// susu, tontine).
//
// Those pages were built on a SaaS template: a breadcrumb strip, a grey hero
// band, and a row of tabs that hid three quarters of the article until
// clicked. Here every section renders, in order, under a sticky jump bar —
// the same "everything renders, no tabs" rule as the newer pillar pages
// (chama, chit fund, esusu) — and the body is a `.prose-apple` reading column
// with ProseBlocks for the structured parts.

import Link from 'next/link';
import type { ReactNode } from 'react';

import { Breadcrumbs, MarketingShell } from './ArticleLayout';
import {
  ClosingCta,
  Disclaimer,
  RelatedTiles,
  ShareLinks,
  type ClosingCtaProps,
  type RelatedPost,
} from './PageBlocks';
import { ChevronLink, focusRing, goldButtonClass } from '../landing/ui';

type Action = { label: string; href: string };

export interface LearnGuideProps {
  /** Current-page label for the breadcrumb trail (Home › Learn › this). */
  crumb: string;
  title: string;
  standfirst: ReactNode;
  actions?: { primary: Action; secondary?: Action };
  /** SourcedStat / PlainStat children, shown as a band under the hero. */
  figures?: ReactNode;
  /** One entry per GuideSection, in order — the sticky jump bar. */
  toc: { id: string; label: string }[];
  children: ReactNode;
  related: RelatedPost[];
  relatedTitle?: string;
  cta: ClosingCtaProps;
  /** Canonical path + title for the share links; omit to hide them. */
  share?: { path: string; title: string };
}

export function LearnGuide({
  crumb,
  title,
  standfirst,
  actions,
  figures,
  toc,
  children,
  related,
  relatedTitle = 'Related Content',
  cta,
  share,
}: LearnGuideProps) {
  return (
    <MarketingShell legacy={false}>
      <article>
        <header className="relative overflow-hidden">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(900px_460px_at_78%_-10%,rgba(232,176,75,0.10),transparent_64%)]"
          />
          <div className="relative mx-auto max-w-[980px] px-5 pb-14 pt-8 sm:px-8 md:pb-20 md:pt-12">
            <Breadcrumbs
              items={[{ label: 'Home', href: '/' }, { label: 'Learn', href: '/learn' }, { label: crumb }]}
            />
            <h1 className="type-section mt-10 max-w-[22ch] text-balance text-mist">{title}</h1>
            <div className="type-intro mt-6 max-w-[44rem] text-mist-2 [&_strong]:font-semibold [&_strong]:text-mist">
              {standfirst}
            </div>
            {actions && (
              <div className="mt-10 flex flex-col items-start gap-5 sm:flex-row sm:items-center sm:gap-8">
                <Link href={actions.primary.href} className={goldButtonClass}>
                  {actions.primary.label}
                </Link>
                {actions.secondary && (
                  <ChevronLink href={actions.secondary.href}>{actions.secondary.label}</ChevronLink>
                )}
              </div>
            )}
          </div>
        </header>

        {figures && (
          <section aria-label="By the numbers" className="px-5 pb-14 sm:px-8 md:pb-20">
            <div className="mx-auto grid max-w-[980px] grid-cols-1 gap-y-10 border-y border-white/[0.08] py-10 sm:grid-cols-[repeat(auto-fit,minmax(220px,1fr))] sm:gap-x-10">
              {figures}
            </div>
          </section>
        )}

        {toc.length > 0 && (
          <nav
            aria-label="On this page"
            className="sticky top-[52px] z-30 border-y border-white/[0.08] bg-black/75 backdrop-blur-xl backdrop-saturate-[1.8]"
          >
            <ul className="mx-auto flex max-w-[980px] items-center gap-2 overflow-x-auto px-5 py-3 [scrollbar-width:none] sm:px-8 [&::-webkit-scrollbar]:hidden">
              {toc.map((entry) => (
                <li key={entry.id} className="shrink-0">
                  <a
                    href={`#${entry.id}`}
                    className={`block rounded-full bg-white/[0.06] px-4 py-2 text-[14px] text-mist-2 transition-colors duration-200 hover:bg-white/[0.12] hover:text-mist ${focusRing}`}
                  >
                    {entry.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        )}

        <div className="prose-apple mx-auto max-w-[780px] px-5 pb-6 pt-12 sm:px-8 md:pt-16">{children}</div>

        {related.length > 0 && <RelatedTiles title={relatedTitle} posts={related} />}

        <ClosingCta {...cta} />

        {share && <ShareLinks path={share.path} title={share.title} />}
      </article>

      <Disclaimer />
    </MarketingShell>
  );
}

/** One jump-bar destination. The first section's heading sits flush with the
 *  top of the column; `scroll-mt` clears the global bar and the jump bar. */
export function GuideSection({ id, title, children }: { id: string; title: ReactNode; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-[124px] [&:first-child>h2]:mt-0">
      <h2>{title}</h2>
      {children}
    </section>
  );
}
