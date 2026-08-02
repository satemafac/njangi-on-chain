// /learn/esusu — pillar page.
//
// Promoted from the glossary (hasPillarPage: true in src/content/rosca-terms.ts),
// so the URL is unchanged. See src/pages/learn/chit-fund.tsx for the reasoning
// on the pattern.
//
// Why esusu: it reaches the Nigerian diaspora in the US, UK and EU, which is the
// closest of the untapped terms to the approved corridors in
// docs/compliance-roadmap-cex-dex-non-kyc.md §D. It also carries the one piece of
// history that ties this whole glossary together — esusu is the probable
// ancestor of the Caribbean susu and Jamaican pardna, so the three pages
// reinforce each other rather than competing.
//
// Everything renders. No tabs.

import Link from 'next/link';

import { ArticleLayout, cardClass, chipClass } from '@/components/marketing/ArticleLayout';
import { Seo } from '@/components/Seo';
import { relatedLink, termBySlug } from '@/content/rosca-terms';
import { article, breadcrumbs, definedTerm, faqPage } from '@/lib/structured-data';

const TERM = termBySlug('esusu')!;
const PATH = '/learn/esusu';

const FAQS = [
  {
    question: 'What is esusu?',
    answer:
      'Esusu is a Yoruba rotating savings circle. A group agrees an amount and a schedule, everyone contributes the same sum each round, and one member takes the whole pool until every member has had a turn. It is one of the oldest rotating savings practices with a continuously documented history.',
  },
  {
    question: 'Is esusu the same as susu?',
    answer:
      'They are the same institution, and almost certainly the same word. Esusu is West African and Yoruba; susu, sou-sou and the Jamaican pardna are its Caribbean descendants, carried across the Atlantic by enslaved West Africans. The mechanics survived the crossing intact and the name shifted with the language.',
  },
  {
    question: 'What is the difference between esusu and ajo?',
    answer:
      'Esusu rotates: everyone contributes and each member takes the whole pool in turn. Ajo, in its collector form, does not — a collector visits daily, takes what you can spare, and returns your own money at the end of the period minus a fee. One gives you everyone\'s money now; the other gives you your own money back later. In practice Yoruba speakers use "ajo" for both, so context decides.',
  },
  {
    question: 'What is the olori esusu?',
    answer:
      'The head of the group. They collect the contributions, keep the record, and carry responsibility if a member falls short. It is a position of standing rather than an administrative chore, and it is not given to someone the group does not already trust with their reputation.',
  },
  {
    question: 'Is esusu legal in Nigeria?',
    answer:
      'Esusu is an informal arrangement between people who know each other and is not a licensed financial activity. It is not regulated as a bank or a lender because it is neither — nobody takes anyone else\'s money, and nobody is charged for borrowing. Members contribute and receive their turn.',
  },
];

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="mt-14 scroll-mt-24 first:mt-0">
      <h2 className="text-2xl font-semibold tracking-[-0.01em] text-cream sm:text-[1.75rem]">
        {title}
      </h2>
      <div className="mt-4 space-y-4 text-base leading-8 text-sand sm:text-lg">{children}</div>
    </section>
  );
}

export default function EsusuPage() {
  return (
    <>
      <Seo
        title="What is Esusu? The Yoruba Savings Circle"
        titleAbsolute
        description="Esusu is a Yoruba rotating savings circle and the probable ancestor of the Caribbean susu: everyone contributes on a schedule, each member takes the pool in turn."
        path={PATH}
        ogType="article"
        image={{ url: '/og/learn-esusu.png', alt: 'What is esusu?' }}
        article={{
          publishedTime: '2026-08-02T00:00:00.000Z',
          modifiedTime: '2026-08-02T00:00:00.000Z',
          authorName: 'Njangi On-Chain',
          section: 'Education',
          tags: ['esusu', 'isusu', 'yoruba', 'nigeria', 'rosca'],
        }}
        jsonLd={[
          breadcrumbs([
            { name: 'Home', path: '/' },
            { name: 'Learn', path: '/learn' },
            { name: 'What is Esusu?' },
          ]),
          article({
            headline: 'What is esusu? The Yoruba savings circle, and where it travelled',
            description: TERM.shortDefinition,
            path: PATH,
            image: '/og/learn-esusu.png',
            datePublished: TERM.published,
            dateModified: TERM.modified,
            section: 'Education',
            keywords: ['esusu', 'isusu', 'Yoruba', 'Nigeria', 'susu', 'ROSCA'],
          }),
          definedTerm({
            name: TERM.term,
            description: TERM.shortDefinition,
            path: PATH,
            alternateNames: TERM.alsoKnownAs,
            termSetPath: '/learn',
          }),
          faqPage(FAQS),
        ]}
      />

      <ArticleLayout
        eyebrow="Rotating savings · Nigeria"
        title="What is esusu?"
        standfirst={
          <p>
            Esusu is a Yoruba rotating savings circle, and one of the oldest with a continuously
            documented history. It is also the reason a savings circle in Kingston and a savings
            circle in Lagos are called almost the same thing.
          </p>
        }
        breadcrumbs={[
          { label: 'Home', href: '/' },
          { label: 'Learn', href: '/learn' },
          { label: 'Esusu' },
        ]}
        meta={
          <div className="flex flex-wrap gap-2">
            <span className={chipClass}>Said &ldquo;{TERM.pronunciation}&rdquo;</span>
            {TERM.alsoKnownAs.map((name) => (
              <span key={name} className={chipClass}>
                {name}
              </span>
            ))}
          </div>
        }
      >
        <Section id="definition" title="The short answer">
          <p>
            A group agrees an amount and a rhythm — weekly or monthly. Everyone contributes the
            same sum each round, and one member takes the entire pool. The cycle runs until every
            member has had a turn, at which point the group usually starts again with the same
            people.
          </p>
          <p>
            Order is normally settled at the outset, by drawing lots or by seniority within the
            group. A head — the <strong>olori esusu</strong> in Yoruba — collects, keeps the
            record, and is responsible if a member falls short.
          </p>
        </Section>

        <Section id="atlantic" title="The word that crossed the Atlantic">
          <p>
            Esusu matters as much for where it went as for how it works. Anthropologists studying
            it among the Yoruba in the twentieth century found an institution already fully formed
            — not a practice in development, but one long settled.
          </p>
          <p>
            Enslaved West Africans carried it across the Atlantic, and it survived. It runs in the
            Caribbean today as{' '}
            <Link href="/learn/susu" className="text-gold-hi underline underline-offset-4 hover:text-gold">
              susu and sou-sou
            </Link>
            , and in Jamaica as{' '}
            <Link href="/learn/pardna" className="text-gold-hi underline underline-offset-4 hover:text-gold">
              pardna
            </Link>
            . The mechanics are unchanged; the name shifted with the language.
          </p>
          <div className={`${cardClass} mt-6 px-6 py-6 sm:px-8`}>
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.2em] text-gold">
              Why that is worth stating plainly
            </h3>
            <p className="mt-3 text-base leading-7 text-cream-muted">
              Esusu is one of the clearest cases of a functioning economic institution surviving
              the Middle Passage intact. People arrived with nothing, and rebuilt a working
              financial system out of memory and trust because the structure travelled in their
              heads. Tracing esusu to susu to pardna connects West African, Caribbean and Black
              American savings practice into a single continuous tradition rather than a set of
              coincidental local customs.
            </p>
          </div>
        </Section>

        <Section id="market" title="Esusu in the market">
          <p>
            In Nigeria the practice is tightly bound to market traders. An esusu among traders
            working the same market lets a member restock in bulk at a scale their daily takings
            would never reach on their own, with contributions collected on the spot where everyone
            already sees each other every day.
          </p>
          <p>
            That setting is also what makes it work. Enforcement is not a legal question; it is the
            fact that you will be standing three stalls from everyone you owe, tomorrow morning.
          </p>
          <p>
            The Igbo variant, <strong>isusu</strong>, runs identically. Across northern Nigeria the
            Hausa <strong>adashi</strong> fills the same role. And{' '}
            <Link href="/learn/ajo" className="text-gold-hi underline underline-offset-4 hover:text-gold">
              ajo
            </Link>{' '}
            sits alongside esusu in the same markets — often confused with it, though in its
            collector form it is a different arrangement entirely.
          </p>
        </Section>

        <Section id="diaspora" title="Esusu abroad">
          <p>
            Nigerian communities in the United Kingdom, the United States and Canada run esusu
            widely — to raise a house deposit, cover school fees, or send a lump sum home. Groups
            are frequently drawn from a single hometown association, so the social ties abroad are
            as strong as the ones at home, sometimes stronger.
          </p>
          <p>
            The strain is the familiar one. A group whose enforcement mechanism was seeing each
            other daily in a market now spans three time zones, and the record of who has paid
            lives with one person.
          </p>
        </Section>

        <Section id="faq" title="Questions people ask">
          <dl className={`${cardClass} px-6 sm:px-8`}>
            {FAQS.map((faq, index) => (
              <div
                key={faq.question}
                className={index === 0 ? 'py-6' : 'border-t border-ink-inner py-6'}
              >
                <dt className="text-lg font-semibold text-cream">{faq.question}</dt>
                <dd className="mt-3 text-base leading-7 text-sand">{faq.answer}</dd>
              </div>
            ))}
          </dl>
        </Section>

        <section className="mt-14 border-t border-ink-border pt-10">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.32em] text-gold">
            The same idea, elsewhere
          </h2>
          <ul className="mt-5 flex flex-wrap gap-3">
            {TERM.related.map((ref) => {
              const link = relatedLink(ref);
              return (
                <li key={ref}>
                  <Link
                    href={link.href}
                    className={`${chipClass} hover:border-gold hover:text-gold-hi`}
                  >
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
