// /learn/chit-fund — pillar page.
//
// Promoted from the glossary rather than created alongside it, so the URL is
// unchanged and there is no second page competing for the same term. The entry
// stays in src/content/rosca-terms.ts with hasPillarPage: true, which keeps it
// in the DefinedTermSet and keeps other terms' `related` references resolving,
// while getStaticPaths skips it so /learn/[term] does not also build it.
//
// Why chit fund got the promotion: it is the highest-volume rotating-savings
// term the site has any claim to, it reaches India plus the Gulf corridor where
// Search Console already shows UAE impressions, and it is the one tradition
// with a genuinely different mechanism — the monthly auction — which gives it
// enough distinct substance to carry a long page honestly.
//
// Everything renders. No tabs. The four older pillars hid three quarters of
// their body behind useState and shipped ~110 words to crawlers; that is not a
// pattern to repeat.

import Link from 'next/link';

import { ArticleLayout, cardClass, chipClass } from '@/components/marketing/ArticleLayout';
import { Seo } from '@/components/Seo';
import { relatedLink, termBySlug } from '@/content/rosca-terms';
import { article, breadcrumbs, definedTerm, faqPage } from '@/lib/structured-data';

const TERM = termBySlug('chit-fund')!;

const PATH = '/learn/chit-fund';

/** The questions people actually type after "chit fund". */
const FAQS = [
  {
    question: 'Is a chit fund legal?',
    answer:
      'In India, yes, and it is specifically regulated. Registered chit funds operate under the Chit Funds Act, 1982, and are licensed and supervised by state governments, which cap the organiser\'s commission and require the foreman to lodge security. Alongside the registered sector sits a very large informal one — workplace and neighbourhood chits run on trust — which is outside that framework. The distinction matters: the protections of the Act apply to registered chits only.',
  },
  {
    question: 'What is the difference between a chit fund and a ROSCA?',
    answer:
      'A chit fund is a ROSCA. Rotating savings and credit association is the general term economists use for the whole family; chit fund is what the Indian version is called. What makes the chit fund distinctive within that family is the auction: most rotating circles fix the turn order once, while a chit fund re-decides it every month by bidding.',
  },
  {
    question: 'How does chit fund bidding work?',
    answer:
      'Each month, members who want the pool early state the discount they will accept — they take less than the full amount. Whoever offers to take the least wins that month\'s pool, and the sum they gave up is divided among the other members after the organiser\'s commission. A member with an urgent need can move to the front of the queue by accepting less; a member who can wait is compensated out of other people\'s discounts.',
  },
  {
    question: 'What does the foreman do?',
    answer:
      'The foreman is the organiser of a registered chit. They assemble the group, run the monthly auction, collect contributions, distribute the pool, and are legally required to lodge security with the state registrar. In exchange they take a commission on each pool, capped by the Act at five per cent.',
  },
  {
    question: 'Is a chit fund the same as a chitty or a kuri?',
    answer:
      'Yes. Chitty is the usual word in Kerala, kuri is used in Malayalam-speaking areas, and chit or chit scheme appears in official and company names. They describe the same arrangement.',
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

export default function ChitFundPage() {
  return (
    <>
      <Seo
        title="What is a Chit Fund? How Chit Funds Actually Work"
        titleAbsolute
        description="A chit fund is India's rotating savings circle, and the only one decided by monthly auction: members bid a discount for early access, and the discount is shared out."
        path={PATH}
        ogType="article"
        image={{ url: '/og/learn-chit-fund.png', alt: 'What is a chit fund?' }}
        article={{
          publishedTime: '2026-08-02T00:00:00.000Z',
          modifiedTime: '2026-08-02T00:00:00.000Z',
          authorName: 'Njangi On-Chain',
          section: 'Education',
          tags: ['chit fund', 'chitty', 'kuri', 'india', 'rosca'],
        }}
        jsonLd={[
          breadcrumbs([
            { name: 'Home', path: '/' },
            { name: 'Learn', path: '/learn' },
            { name: 'What is a Chit Fund?' },
          ]),
          article({
            headline: 'What is a chit fund? How chit funds actually work',
            description: TERM.shortDefinition,
            path: PATH,
            image: '/og/learn-chit-fund.png',
            datePublished: TERM.published,
            dateModified: TERM.modified,
            section: 'Education',
            keywords: ['chit fund', 'chitty', 'kuri', 'India', 'ROSCA', 'rotating savings'],
          }),
          definedTerm({
            name: TERM.term,
            description: TERM.shortDefinition,
            path: PATH,
            alternateNames: TERM.alsoKnownAs,
            termSetPath: '/learn',
          }),
          // Marked up for entity and passage understanding, and for Bing, which
          // still renders FAQ results. Google restricted FAQ rich results to
          // government and health sites in Aug 2023 — do not expect accordions
          // in a Google result from this.
          faqPage(FAQS),
        ]}
      />

      <ArticleLayout
        eyebrow="Rotating savings · India"
        title="What is a chit fund?"
        standfirst={
          <p>
            A chit fund is India&rsquo;s rotating savings circle — and the only one in the family
            that decides whose turn it is by auction. Everyone pays the same amount each month, and
            each month the members bid for who takes the pool.
          </p>
        }
        breadcrumbs={[
          { label: 'Home', href: '/' },
          { label: 'Learn', href: '/learn' },
          { label: 'Chit fund' },
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
            Twenty people agree to pay ₹5,000 a month for twenty months. Each month the twenty
            contributions are pooled, and one member takes the pool. After twenty months everyone
            has taken a turn, and everyone has paid in roughly what they took out. That is a chit
            fund, and it is the same shape as a{' '}
            <Link href="/learn/what-is-njangi" className="text-gold-hi underline underline-offset-4 hover:text-gold">
              njangi
            </Link>
            , a{' '}
            <Link href="/learn/tontine" className="text-gold-hi underline underline-offset-4 hover:text-gold">
              tontine
            </Link>{' '}
            or a{' '}
            <Link href="/learn/susu" className="text-gold-hi underline underline-offset-4 hover:text-gold">
              susu
            </Link>
            .
          </p>
          <p>
            What makes it a chit fund rather than any of those is the next sentence: nobody is
            assigned a month. The group decides, every month, by auction.
          </p>
        </Section>

        <Section id="auction" title="The auction, with numbers">
          <p>
            Say it is month three of that twenty-member chit. The pool on the table is ₹100,000 —
            twenty members at ₹5,000 each. Three people want it this month: one is restocking a
            shop before a festival, one has a hospital bill, one simply would not mind having it.
          </p>
          <p>
            They bid by saying what they are willing to <em>give up</em>. The shopkeeper offers to
            take ₹85,000 instead of ₹100,000. The person with the hospital bill offers to take
            ₹82,000. Nobody goes lower. The hospital bill wins the pool at ₹82,000.
          </p>
          <p>
            The ₹18,000 they gave up does not vanish. The foreman takes their commission — capped
            by law at five per cent of the pool, so ₹5,000 — and the remaining ₹13,000 is divided
            among the other nineteen members, who each get about ₹684 back. In practice that is
            deducted from what they owe next month, so their next contribution is smaller.
          </p>
          <div className={`${cardClass} mt-6 px-6 py-6 sm:px-8`}>
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.2em] text-gold">
              What the auction actually does
            </h3>
            <p className="mt-3 text-base leading-7 text-cream-muted">
              It prices urgency, out loud. In every other tradition on this list, a member who needs
              the money early has to ask the group and hope — a social negotiation with no
              mechanism behind it. A chit fund turns that into a number the whole group can see, and
              compensates the people who wait out of the pocket of the person who could not.
            </p>
          </div>
          <p>
            Members who have already taken their turn keep contributing the full amount and can no
            longer bid. That is what stops someone taking an early pool cheaply and then coasting.
          </p>
        </Section>

        <Section id="registered" title="Registered chits and informal ones">
          <p>
            Two quite different things go by the name. A <strong>registered chit fund</strong> is
            run by a licensed company under the Chit Funds Act, 1982. There is a written agreement,
            the group is filed with a state registrar, the foreman must lodge security, and their
            commission is capped. Kerala&rsquo;s state-owned operator is among the largest in the
            country, which is unusual — a government running the local ROSCA.
          </p>
          <p>
            An <strong>informal chit</strong> is a dozen colleagues in an office, or traders in one
            market, running the same arrangement on trust with no paperwork and often no auction at
            all — just a draw. This sector is far larger than the registered one and is much closer
            to how a{' '}
            <Link href="/learn/committee" className="text-gold-hi underline underline-offset-4 hover:text-gold">
              committee
            </Link>{' '}
            in Pakistan or a{' '}
            <Link href="/learn/paluwagan" className="text-gold-hi underline underline-offset-4 hover:text-gold">
              paluwagan
            </Link>{' '}
            in the Philippines works.
          </p>
          <p>
            The distinction is worth holding onto, because the protections people associate with
            chit funds — the registrar, the capped commission, the lodged security — apply to the
            registered sector only.
          </p>
        </Section>

        <Section id="history" title="Where it comes from">
          <p>
            The name comes from <em>chitthi</em>, a written slip. Members once drew slips from a pot
            to settle whose turn had come, and the lottery form still exists. The shift from drawing
            lots to bidding is what turned a common practice into something distinctly Indian, and
            it spread the chit through the south — Kerala, Tamil Nadu, Andhra Pradesh, Karnataka.
          </p>
          <p>
            India began regulating chits more than a century before the 1982 Act, which is why the
            chit fund is among the best-documented rotating savings traditions anywhere. Most of the
            others on this list left no institutional record at all, which is precisely why nobody
            can tell you how large the global practice is.
          </p>
        </Section>

        <Section id="diaspora" title="Chits abroad">
          <p>
            Indian communities carry chits to the Gulf, Singapore, Malaysia, the United Kingdom,
            the United States and Canada — usually in the simpler lottery form rather than the full
            auction. Among Gulf workers they are a common way to turn a steady monthly wage into an
            occasional lump sum worth sending home.
          </p>
          <p>
            That is also where the arrangement strains hardest. Members sit in three or four
            countries on different pay cycles, contributions arrive through remittance services with
            their own fees and delays, and the person holding the money is holding it somewhere most
            of the group cannot see. The schedule and the record are the first things to break, long
            before anyone&rsquo;s intentions do.
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

        <aside className="mt-14 rounded-2xl border border-gold-deep/40 bg-gold/[0.06] px-6 py-6 sm:px-8">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.22em] text-gold">
            Worth being precise about
          </h2>
          <p className="mt-3 text-base leading-7 text-cream-muted">{TERM.regulatoryNote}</p>
        </aside>

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
