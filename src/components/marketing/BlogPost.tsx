// BlogPost — the reading layout for /blog/* articles.
//
// Modelled on Apple Newsroom: a quiet header (breadcrumbs, category and
// date, a large headline, the dek, a byline), then a single reading column
// at ~70 characters. Article bodies are plain semantic HTML — p, h2, h3,
// ul/ol, blockquote, strong, em, a — styled by `.prose-apple` in
// globals.css, so a post is written as prose rather than as utility classes.
// The few structured blocks a post needs (a row of cited figures, a callout)
// live in ProseBlocks; the closing sections in PageBlocks.

import type { ReactNode } from 'react';

import { Breadcrumbs, MarketingShell } from './ArticleLayout';
import {
  ClosingCta,
  Disclaimer,
  RelatedTiles,
  keepBrand,
  type ClosingCtaProps,
  type RelatedPost,
} from './PageBlocks';
import { focusRing } from '../landing/ui';

export type { RelatedPost };

export interface BlogPostProps {
  /** Current-page label for the breadcrumb trail (Home › Blog › this). */
  crumb: string;
  category: string;
  /** e.g. "10 min read · 28 August 2026" */
  meta: string;
  title: string;
  dek: ReactNode;
  /** e.g. "Published 28 August 2026" */
  byline: string;
  children: ReactNode;
  sources?: ReactNode;
  related: RelatedPost[];
  relatedTitle?: string;
  cta?: ClosingCtaProps;
}

function Monogram({ size }: { size: 'sm' | 'lg' }) {
  return (
    <span
      aria-hidden
      className={`flex shrink-0 items-center justify-center rounded-full bg-white/[0.08] font-semibold text-mist ${
        size === 'lg' ? 'h-14 w-14 text-[20px]' : 'h-10 w-10 text-[15px]'
      }`}
    >
      N
    </span>
  );
}

export function BlogPost({
  crumb,
  category,
  meta,
  title,
  dek,
  byline,
  children,
  sources,
  related,
  relatedTitle = 'Keep reading',
  cta,
}: BlogPostProps) {
  return (
    <MarketingShell legacy={false}>
      <article>
        <header className="relative overflow-hidden">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(900px_420px_at_70%_-14%,rgba(232,176,75,0.09),transparent_64%)]"
          />
          <div className="relative mx-auto max-w-[780px] px-5 pb-10 pt-8 sm:px-8 md:pt-12">
            <Breadcrumbs
              items={[{ label: 'Home', href: '/' }, { label: 'Blog', href: '/blog' }, { label: crumb }]}
            />
            <p className="mt-10 text-[14px] text-mist-3">
              <span className="font-semibold text-gold">{category}</span>
              <span aria-hidden className="mx-2 text-mist-4">
                ·
              </span>
              {meta}
            </p>
            <h1 className="type-section mt-4 text-balance text-mist">{keepBrand(title)}</h1>
            <div className="type-intro mt-6 text-mist-2">{dek}</div>
            <div className="mt-9 flex items-center gap-3 border-b border-white/[0.1] pb-9">
              <Monogram size="sm" />
              <div>
                <p className="text-[15px] font-semibold tracking-[-0.01em] text-mist">Njangi On-Chain</p>
                <p className="text-[13px] text-mist-3">{byline}</p>
              </div>
            </div>
          </div>
        </header>

        <div className="prose-apple mx-auto max-w-[780px] px-5 pb-6 pt-4 sm:px-8">{children}</div>

        {sources && (
          <section aria-labelledby="sources" className="mx-auto max-w-[780px] px-5 sm:px-8">
            <div className="border-t border-white/[0.1] pt-8">
              <h2 id="sources" className="text-[17px] font-semibold tracking-[-0.01em] text-mist">
                Sources
              </h2>
              <div className="type-caption mt-4 text-mist-3 [&_a]:text-gold [&_a]:underline-offset-4 hover:[&_a]:underline [&_li]:mt-3">
                {sources}
              </div>
            </div>
          </section>
        )}

        <RelatedTiles id="keep-reading" title={relatedTitle} posts={related} />

        {/* About the author */}
        <section className="mx-auto max-w-[780px] px-5 pt-12 sm:px-8">
          <div className="flex items-start gap-4 border-t border-white/[0.1] pt-10">
            <Monogram size="lg" />
            <div className="min-w-0">
              <h2 className="text-[19px] font-semibold tracking-[0.012em] text-mist">Njangi On-Chain</h2>
              <p className="type-body mt-2 text-mist-2">
                We build coordination software for rotating savings circles. We write about how
                these circles work, what changes when the record is shared, and what deliberately
                does not.
              </p>
              <p className="type-caption mt-3 flex items-center gap-4 text-mist-3">
                <span>Follow:</span>
                <a
                  href="https://x.com/njangi_on_chain"
                  className={`rounded text-gold underline-offset-4 hover:underline ${focusRing}`}
                >
                  X
                </a>
                <a
                  href="https://www.instagram.com/njangionchain"
                  className={`rounded text-gold underline-offset-4 hover:underline ${focusRing}`}
                >
                  Instagram
                </a>
              </p>
            </div>
          </div>
        </section>

        {cta && <ClosingCta {...cta} />}
      </article>

      <Disclaimer />
    </MarketingShell>
  );
}
