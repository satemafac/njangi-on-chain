// /learn/[term] — one page per rotating savings tradition.
//
// Content lives in src/content/rosca-terms.ts; this file is presentation only.
// Statically generated with fallback: false, so every term is a real prebuilt
// page and an unknown slug 404s rather than rendering an empty shell.
//
// The 14 slugs deliberately exclude njangi, ROSCA, tontine and susu, which
// already have long-form pages under /learn. Adding them here as well would
// split the ranking signal for the site's four best keywords across two URLs.

import type { GetStaticPaths, GetStaticProps } from 'next';
import Link from 'next/link';

import { ArticleLayout, cardClass, chipClass } from '@/components/marketing/ArticleLayout';
import { Seo } from '@/components/Seo';
import { ROSCA_TERMS, relatedLink, termBySlug, type RoscaTerm } from '@/content/rosca-terms';
import { article, breadcrumbs, definedTerm } from '@/lib/structured-data';

interface TermPageProps {
  term: RoscaTerm;
}

export const getStaticPaths: GetStaticPaths = async () => ({
  // Terms with a hand-built pillar page are skipped: a static file under
  // src/pages/learn/ already wins over this dynamic route, so generating both
  // would just build a page that can never be served.
  paths: ROSCA_TERMS.filter((term) => !term.hasPillarPage).map((term) => ({
    params: { term: term.slug },
  })),
  fallback: false,
});

export const getStaticProps: GetStaticProps<TermPageProps> = async ({ params }) => {
  const term = termBySlug(String(params?.term));
  if (!term) return { notFound: true };
  return { props: { term } };
};

function Section({ title, paragraphs }: { title: string; paragraphs: string[] }) {
  return (
    <section className="mt-12 first:mt-0">
      <h2 className="text-2xl font-semibold tracking-[-0.01em] text-cream sm:text-[1.7rem]">
        {title}
      </h2>
      {paragraphs.map((paragraph) => (
        <p key={paragraph.slice(0, 48)} className="mt-4 text-base leading-8 text-sand sm:text-lg">
          {paragraph}
        </p>
      ))}
    </section>
  );
}

function FactRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 border-t border-ink-inner py-4 sm:flex-row sm:gap-6">
      <dt className="w-full shrink-0 text-[11px] font-semibold uppercase tracking-[0.22em] text-gold sm:w-52 sm:pt-1">
        {label}
      </dt>
      <dd className="text-base leading-7 text-sand">{value}</dd>
    </div>
  );
}

export default function TermPage({ term }: TermPageProps) {
  const path = `/learn/${term.slug}` as const;
  const headline = `What is a ${term.term.toLowerCase()}? ${term.region.split(',')[0]}'s rotating savings circle`;

  return (
    <>
      <Seo
        title={`What is a ${term.term}? ${term.region.split(',')[0]}`}
        titleAbsolute
        description={term.shortDefinition}
        path={path}
        ogType="article"
        image={{ url: '/og/learn.png', alt: `What is a ${term.term}?` }}
        article={{
          publishedTime: `${term.published}T00:00:00.000Z`,
          modifiedTime: `${term.modified}T00:00:00.000Z`,
          authorName: 'Njangi On-Chain',
          section: 'Education',
          tags: [term.term.toLowerCase(), ...term.alsoKnownAs.map((n) => n.toLowerCase())],
        }}
        jsonLd={[
          breadcrumbs([
            { name: 'Home', path: '/' },
            { name: 'Learn', path: '/learn' },
            { name: term.term },
          ]),
          article({
            headline,
            description: term.shortDefinition,
            path,
            image: '/og/learn.png',
            datePublished: term.published,
            dateModified: term.modified,
            section: 'Education',
            keywords: [term.term, ...term.alsoKnownAs],
          }),
          // The high-value node on these pages: alternateName is the
          // machine-readable statement that all these cultural names denote
          // one practice. No rich result comes of it — the value is entity
          // disambiguation.
          definedTerm({
            name: term.term,
            description: term.shortDefinition,
            path,
            alternateNames: term.alsoKnownAs,
            termSetPath: '/learn',
          }),
        ]}
      />

      <ArticleLayout
        eyebrow={`Rotating savings · ${term.region.split(',')[0]}`}
        title={`What is a ${term.term.toLowerCase()}?`}
        standfirst={<p>{term.shortDefinition}</p>}
        breadcrumbs={[
          { label: 'Home', href: '/' },
          { label: 'Learn', href: '/learn' },
          { label: term.term },
        ]}
        meta={
          <div className="flex flex-wrap gap-2">
            {term.pronunciation && <span className={chipClass}>Said “{term.pronunciation}”</span>}
            {term.alsoKnownAs.slice(0, 4).map((name) => (
              <span key={name} className={chipClass}>
                {name}
              </span>
            ))}
          </div>
        }
      >
        <dl className={`${cardClass} px-6 py-2 sm:px-8`}>
          <FactRow label="Where" value={term.region} />
          <FactRow label="Where the word comes from" value={term.etymology} />
          <FactRow label="Typical size" value={term.typicalSize} />
          <FactRow label="How often" value={term.typicalCycle} />
          <FactRow label="Who goes first" value={term.orderingRule} />
        </dl>

        <Section title="Where it comes from" paragraphs={term.origin} />
        <Section title="How it runs" paragraphs={term.howItRuns} />
        <Section title={`What makes a ${term.term.toLowerCase()} different`} paragraphs={term.distinctive} />
        <Section title="Abroad" paragraphs={term.diaspora} />

        {term.regulatoryNote && (
          <aside className="mt-12 rounded-2xl border border-gold-deep/40 bg-gold/[0.06] px-6 py-6 sm:px-8">
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.22em] text-gold">
              Worth being precise about
            </h2>
            <p className="mt-3 text-base leading-7 text-cream-muted">{term.regulatoryNote}</p>
          </aside>
        )}

        <section className="mt-14 border-t border-ink-border pt-10">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.32em] text-gold">
            The same idea, elsewhere
          </h2>
          <ul className="mt-5 flex flex-wrap gap-3">
            {term.related.map((ref) => {
              const link = relatedLink(ref);
              return (
                <li key={ref}>
                  <Link href={link.href} className={`${chipClass} hover:border-gold hover:text-gold-hi`}>
                    {link.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      </ArticleLayout>
    </>
  );
}
