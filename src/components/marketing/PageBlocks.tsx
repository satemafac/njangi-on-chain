// PageBlocks — the closing sections shared by the long-form layouts
// (BlogPost, LearnGuide): related-reading tiles, the closing call to action,
// share links, and the educational disclaimer. One definition each so the
// blog and the guides cannot drift apart.

import Link from 'next/link';
import type { ReactNode } from 'react';

import { SITE_URL } from '../../lib/structured-data';
import { ChevronLink, focusRing, goldButtonClass } from '../landing/ui';

/** Keeps the brand's hyphenated name on one line in headings. Browsers break
 *  after a hyphen, and a balanced headline will happily set "On-" at the end
 *  of one line and "Chain" at the start of the next. */
export function keepBrand(text: string): ReactNode {
  const parts = text.split(/(On-Chain)/);
  return parts.length === 1
    ? text
    : parts.map((part, i) =>
        part === 'On-Chain' ? (
          <span key={i} className="whitespace-nowrap">
            {part}
          </span>
        ) : (
          part
        )
      );
}

export type RelatedPost = {
  href: string;
  category?: string;
  title: string;
  description: string;
};

export function RelatedTiles({
  title,
  posts,
  id = 'related',
}: {
  title: string;
  posts: RelatedPost[];
  id?: string;
}) {
  return (
    <section aria-labelledby={id} className="mx-auto max-w-[1100px] px-5 pb-8 pt-16 sm:px-8 md:pt-24">
      <h2 id={id} className="type-headline text-mist">
        {title}
      </h2>
      <div className={`mt-8 grid gap-4 md:gap-5 ${posts.length > 2 ? 'md:grid-cols-3' : 'md:grid-cols-2'}`}>
        {posts.map((post) => (
          <Link
            key={`${post.href}-${post.title}`}
            href={post.href}
            className={`group flex flex-col rounded-[28px] bg-ink-surface p-7 transition-colors duration-200 hover:bg-[#1b1b1e] sm:p-8 ${focusRing}`}
          >
            {post.category && <span className="mb-4 text-[13px] font-semibold text-gold">{post.category}</span>}
            <span className="text-[21px] font-semibold leading-snug tracking-[0.011em] text-mist">
              {keepBrand(post.title)}
            </span>
            <span className="type-caption mt-2 flex-1 text-mist-3">{post.description}</span>
            <span className="mt-6 inline-flex items-center gap-0.5 text-[15px] text-gold">
              Read
              <span aria-hidden className="transition-transform duration-200 group-hover:translate-x-0.5 rtl:rotate-180">
                ›
              </span>
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}

export type ClosingCtaProps = {
  title: string;
  body: string;
  primary: { label: string; href: string };
  secondary: { label: string; href: string };
};

export function ClosingCta({ title, body, primary, secondary }: ClosingCtaProps) {
  return (
    <section className="px-5 pt-20 sm:px-8 md:pt-28">
      <div className="relative mx-auto max-w-[1100px] overflow-hidden rounded-[32px] bg-ink-surface px-7 py-14 text-center sm:px-12 md:py-20">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 -top-40 mx-auto h-80 max-w-[720px] rounded-full"
          style={{ background: 'radial-gradient(closest-side, rgba(232,176,75,0.16), transparent)' }}
        />
        <h2 className="type-section relative mx-auto max-w-[18ch] text-balance text-mist">{title}</h2>
        <p className="type-intro relative mx-auto mt-5 max-w-[38rem] text-balance text-mist-2">{body}</p>
        <div className="relative mt-10 flex flex-col items-center justify-center gap-5 sm:flex-row sm:gap-8">
          <Link href={primary.href} className={goldButtonClass}>
            {primary.label}
          </Link>
          <ChevronLink href={secondary.href}>{secondary.label}</ChevronLink>
        </div>
      </div>
    </section>
  );
}

/** Share intents for the page's canonical URL. These were `href="#"` —
 *  four links that went nowhere. */
export function ShareLinks({ path, title }: { path: string; title: string }) {
  const url = `${SITE_URL}${path}`;
  const enc = encodeURIComponent;
  const targets = [
    { label: 'X', href: `https://x.com/intent/tweet?url=${enc(url)}&text=${enc(title)}` },
    { label: 'Facebook', href: `https://www.facebook.com/sharer/sharer.php?u=${enc(url)}` },
    { label: 'LinkedIn', href: `https://www.linkedin.com/sharing/share-offsite/?url=${enc(url)}` },
    { label: 'WhatsApp', href: `https://wa.me/?text=${enc(`${title} ${url}`)}` },
  ];
  return (
    <section aria-label="Share" className="px-5 pt-14 text-center sm:px-8">
      <p className="type-caption text-mist-3">Share this article:</p>
      <ul className="mt-3 flex flex-wrap justify-center gap-x-6 gap-y-2">
        {targets.map((target) => (
          <li key={target.label}>
            <a
              href={target.href}
              target="_blank"
              rel="noopener noreferrer"
              className={`rounded text-[15px] text-gold underline-offset-4 hover:underline ${focusRing}`}
            >
              {target.label}
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function Disclaimer({ label = 'Disclaimer:', children }: { label?: string; children?: ReactNode }) {
  return (
    <aside className="px-5 pb-16 pt-20 sm:px-8">
      <p className="type-fine mx-auto max-w-[44rem] text-center text-mist-3">
        <strong className="font-semibold text-mist-2">{label}</strong>{' '}
        {children ?? (
          <>
            This content is for educational purposes only and does not constitute financial advice.
            Njangi On-Chain is coordination software for savings circles: it never holds your money,
            never offers an investment, and never pays a return. Take part only with an amount your
            group can commit to the schedule.
          </>
        )}
      </p>
    </aside>
  );
}
