import Link from 'next/link';
import { Check } from 'lucide-react';
import { Seo } from '../../components/Seo';
import { breadcrumbs, definedTermSet } from '../../lib/structured-data';
import { ROSCA_TERMS } from '../../content/rosca-terms';
import { Breadcrumbs, MarketingShell } from '../../components/marketing/ArticleLayout';
import { SourcedStat, PlainStat } from '../../components/marketing/SourcedStat';
import { REMITTANCES_AFRICA, REMITTANCE_COST_AFRICA, SAVINGS_CLUB_PARTICIPATION } from '../../content/sourced-facts';
import { ChevronLink, focusRing, goldButtonClass } from '../../components/landing/ui';

const TOPICS = [
  {
    title: 'Traditional Systems',
    points: [
      'Historical origins and cultural significance',
      'How rotating savings circles work',
      'Regional variations worldwide',
      'Common challenges and limitations',
    ],
  },
  {
    title: 'What Makes One Safer',
    points: [
      'Nobody holds the pot \u2014 not even us',
      'Every contribution visible to every member',
      'Members can vote to stop a circle',
      'No seed phrase, no token to buy first',
    ],
  },
  {
    title: 'Partner-led Fiat Ramps',
    points: [
      'Coinbase, MoonPay and Transak on-ramps',
      'Multi-currency support (USD, EUR, XAF, NGN, KES\u2026)',
      'KYC and AML handled by licensed partners',
      'Geo-aware provider selection',
    ],
  },
];

export default function LearnIndexPage() {
  // Card copy follows the page it links to. The slug migration updated these
  // hrefs but left the display text on the old product-first framing — cards
  // reading "Blockchain ROSCA" and "Sou Sou Crypto" pointing at pages titled
  // "What is a ROSCA?" and "What is a Susu?". A card that promises something
  // different from its destination is a bounce, and the anchor text is itself a
  // ranking signal for the target page.
  //
  // NOTE: unlike the glossary grid below, this array is hand-maintained. It has
  // exactly one entry per pillar page under src/pages/learn/. Adding an entry
  // here without the page existing produces an internal link to a 404.
  const articles = [
    {
      title: "What is a Njangi?",
      subtitle: "Cameroon's rotating savings circle",
      description: "Where the word comes from, how a njangi actually runs, and what it means in English.",
      href: "/learn/what-is-njangi",
      tag: "Fundamentals",
      readTime: "5 min read"
    },
    {
      title: "What is a ROSCA?",
      subtitle: "The structure behind all of them",
      description: "Rotating savings and credit association — the economists' name for what njangi, tontine, susu and chit funds all are.",
      href: "/learn/rosca",
      tag: "Fundamentals",
      readTime: "7 min read",
    },
    {
      title: "What is a Tontine?",
      subtitle: "Francophone Africa",
      description: "How tontines run across West and Central Africa, and why the word means something different in French financial history.",
      href: "/learn/tontine",
      tag: "Regional Focus",
      readTime: "9 min read",
    },
    {
      title: "What is a Susu?",
      subtitle: "The Caribbean and West Africa",
      description: "Susu, sou-sou and Partner — one practice carried across the Atlantic, and still running on both sides of it.",
      href: "/learn/susu",
      tag: "Cultural Traditions",
      readTime: "8 min read",
    },
    {
      title: "What is a Chit Fund?",
      subtitle: "India, and the only one decided by auction",
      description: "Every other rotating circle fixes the turn order once. A chit fund re-decides it every month by bidding — worked through with numbers.",
      href: "/learn/chit-fund",
      tag: "Fundamentals",
      readTime: "9 min read",
    },
    {
      title: "What is a Chama?",
      subtitle: "Kenya, and what happens after the pot",
      description: "The one tradition that routinely outgrows its own rotation — table banking, group-owned land, and the meeting that holds it together.",
      href: "/learn/chama",
      tag: "Regional Focus",
      readTime: "8 min read",
    },
    {
      title: "What is Esusu?",
      subtitle: "Nigeria, and the word that crossed the Atlantic",
      description: "The Yoruba original, and the probable ancestor of the Caribbean susu and Jamaican pardna — an institution that survived the Middle Passage intact.",
      href: "/learn/esusu",
      tag: "Cultural Traditions",
      readTime: "8 min read",
    }
  ];

  return (
    <>
      <Seo
        title="Rotating Savings Circles Around the World"
        titleAbsolute
        description="Njangi, tontine, susu, esusu, chit fund, stokvel, chama, tanda — one rotating savings tradition under many names. How each one works, and where it comes from."
        path="/learn"
        image={{ url: '/og/learn.png', alt: 'Njangi On-Chain — rotating savings circles, explained' }}
        jsonLd={[
          breadcrumbs([{ name: 'Home', path: '/' }, { name: 'Learn' }]),
          // Each glossary page declares itself a DefinedTerm inDefinedTermSet
          // "/learn". Until now nothing at /learn actually defined that set, so
          // every one of those references dangled. This closes the graph and
          // states, machine-readably, that these cultural names denote one
          // practice — which is the whole entity argument this site rests on.
          definedTermSet(
            '/learn',
            ROSCA_TERMS.map((term) => ({
              name: term.term,
              description: term.shortDefinition,
              path: `/learn/${term.slug}`,
              alternateNames: term.alsoKnownAs,
            }))
          ),
        ]}
      />

      <MarketingShell legacy={false}>
        {/* ================= HERO ================= */}
        <header className="relative overflow-hidden">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(900px_460px_at_50%_-12%,rgba(232,176,75,0.10),transparent_64%)]"
          />
          <div className="relative mx-auto max-w-[1100px] px-5 pb-16 pt-8 text-center sm:px-8 md:pb-24 md:pt-12">
            <Breadcrumbs
              className="flex justify-center"
              items={[{ label: 'Home', href: '/' }, { label: 'Learn' }]}
            />
            <h1 className="type-hero mx-auto mt-12 max-w-[14ch] text-balance text-mist">
              One tradition, many names.
            </h1>
            <p className="type-intro mx-auto mt-6 max-w-[44rem] text-balance text-mist-2">
              Njangi, tontine, susu, chama, stokvel &mdash; the same practice, wherever it is found.
              How it works, where it comes from, and how to run one where nobody has to hold the
              money.
            </p>
            <div className="mt-10 flex flex-col items-center justify-center gap-5 sm:flex-row sm:gap-8">
              <Link href="/create-circle" className={goldButtonClass}>
                Start Learning by Doing
              </Link>
              <ChevronLink href="#articles">Browse Articles</ChevronLink>
            </div>
          </div>
        </header>

        {/* Figures carry their source. The block this replaced showed four big
            round numbers — a global participant count, an annual volume, and a
            country count that exceeded the number of countries that exist —
            with nothing behind any of them. */}
        <section aria-label="Savings circles, by the numbers" className="px-5 pb-24 sm:px-8 md:pb-32">
          <div className="mx-auto grid max-w-[1100px] grid-cols-1 gap-y-12 border-y border-white/[0.08] py-12 sm:grid-cols-2 sm:gap-x-10 lg:grid-cols-4">
            <SourcedStat fact={REMITTANCES_AFRICA} />
            <SourcedStat fact={REMITTANCE_COST_AFRICA} />
            <SourcedStat fact={SAVINGS_CLUB_PARTICIPATION} />
            <PlainStat
              value="Self-custodied"
              label="No operator function can move member funds — the contract has no admin path to a circle's balance"
            />
          </div>
        </section>

        {/* ================= ARTICLES ================= */}
        <section id="articles" className="scroll-mt-[72px] px-5 pb-24 sm:px-8 md:pb-32">
          <div className="mx-auto max-w-[1100px]">
            <div className="mx-auto max-w-[44rem] text-center">
              <h2 className="type-section text-balance text-mist">Educational Articles</h2>
              <p className="type-intro mt-5 text-balance text-mist-2">
                Start with the fundamentals and work through the regional variations &mdash; how
                these circles work, and what changes when the rules cannot be quietly rewritten.
              </p>
            </div>

            <div className="mt-14 grid gap-4 md:grid-cols-2 md:gap-5">
              {articles.map((article) => (
                <Link
                  key={article.href}
                  href={article.href}
                  className={`group flex flex-col rounded-[28px] bg-ink-surface p-7 transition-colors duration-200 hover:bg-[#1b1b1e] sm:p-9 ${focusRing}`}
                >
                  <span className="flex items-center justify-between gap-4">
                    <span className="text-[13px] font-semibold text-gold">{article.tag}</span>
                    <span className="text-[13px] text-mist-3">{article.readTime}</span>
                  </span>
                  <h3 className="type-tile mt-5 text-mist">{article.title}</h3>
                  <p className="mt-2 text-[17px] font-medium tracking-[-0.022em] text-mist-2">
                    {article.subtitle}
                  </p>
                  <p className="type-body mt-3 flex-1 text-mist-3">{article.description}</p>
                  <span className="mt-7 inline-flex items-center gap-0.5 text-[15px] text-gold">
                    Read Article
                    <span aria-hidden className="transition-transform duration-200 group-hover:translate-x-0.5 rtl:rotate-180">
                      ›
                    </span>
                  </span>
                </Link>
              ))}
            </div>
          </div>
        </section>

        {/* The glossary, linked from the hub.
            This matters more than it looks. Search Console shows 50 URLs stuck
            at "Discovered – currently not indexed" with Last crawled: N/A —
            Google found them in the old sitemap, declined to fetch a single
            one, and throttled the site. Every one of those was reachable ONLY
            from the sitemap. Shipping 14 more sitemap-only URLs would repeat
            exactly that. Internal links from an already-indexed page are how
            crawl priority is actually allocated, and /learn is indexed. */}
        <section id="glossary" className="scroll-mt-[72px] px-5 pb-24 sm:px-8 md:pb-32">
          <div className="mx-auto max-w-[1100px]">
            <div className="max-w-[44rem]">
              <h2 className="type-section text-balance text-mist">One tradition, many names</h2>
              <p className="type-intro mt-5 text-mist-2">
                The same rotating savings circle runs on every inhabited continent under a
                different name. Each entry covers where it comes from, how the turn order gets
                decided, and what makes that version distinct.
              </p>
            </div>

            <ul className="mt-12 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {ROSCA_TERMS.filter((term) => !term.hasPillarPage).map((term) => (
                <li key={term.slug}>
                  <Link
                    href={`/learn/${term.slug}`}
                    className={`group flex h-full flex-col rounded-[22px] bg-ink-surface p-6 transition-colors duration-200 hover:bg-[#1b1b1e] ${focusRing}`}
                  >
                    <span className="flex items-baseline justify-between gap-3">
                      <span className="text-[19px] font-semibold tracking-[0.012em] text-mist">
                        {term.term}
                      </span>
                      <span className="shrink-0 text-[12px] font-medium text-gold">
                        {term.region.split(',')[0]}
                      </span>
                    </span>
                    <span className="type-caption mt-2 text-mist-3">{term.shortDefinition}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* ================= LEARNING PATH ================= */}
        <section className="px-5 pb-24 sm:px-8 md:pb-32">
          <div className="mx-auto max-w-[860px]">
            <div className="text-center">
              <h2 className="type-section text-balance text-mist">Recommended Learning Path</h2>
              <p className="type-intro mx-auto mt-5 max-w-[40rem] text-balance text-mist-2">
                Follow this sequence to build a complete picture of how rotating savings circles
                work.
              </p>
            </div>

            <ol className="mt-14 border-b border-white/[0.1]">
              {articles.map((article, index) => (
                <li key={article.href} className="border-t border-white/[0.1]">
                  <Link
                    href={article.href}
                    className={`group flex items-start gap-6 rounded-lg py-7 sm:gap-10 ${focusRing}`}
                  >
                    <span className="w-10 shrink-0 text-[28px] font-semibold leading-none tracking-[-0.01em] text-gold tabular-nums sm:w-14 sm:text-[40px]">
                      {String(index + 1).padStart(2, '0')}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-medium text-mist-3">{article.tag}</span>
                      <span className="mt-1 block text-[21px] font-semibold tracking-[0.011em] text-mist">
                        {article.title}
                      </span>
                      <span className="type-caption mt-2 block text-mist-3">{article.description}</span>
                      <span className="mt-3 inline-flex items-center gap-0.5 text-[15px] text-gold">
                        Start Reading
                        <span aria-hidden className="transition-transform duration-200 group-hover:translate-x-0.5 rtl:rotate-180">
                          ›
                        </span>
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* ================= TOPICS ================= */}
        <section className="px-5 pb-24 sm:px-8 md:pb-32">
          <div className="mx-auto max-w-[1100px]">
            <div className="text-center">
              <h2 className="type-section text-balance text-mist">Topics Covered</h2>
              <p className="type-intro mx-auto mt-5 max-w-[40rem] text-balance text-mist-2">
                How these circles work, where they come from, and what makes one safer to run.
              </p>
            </div>

            <div className="mt-14 grid gap-4 md:grid-cols-3 md:gap-5">
              {TOPICS.map((topic) => (
                <div key={topic.title} className="rounded-[28px] bg-ink-surface p-7 sm:p-9">
                  <h3 className="text-[21px] font-semibold tracking-[0.011em] text-mist">{topic.title}</h3>
                  <ul className="mt-5 space-y-3">
                    {topic.points.map((point) => (
                      <li key={point} className="type-caption flex items-start gap-2.5 text-mist-2">
                        <Check aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-gold" strokeWidth={2.2} />
                        <span>{point}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ================= CTA ================= */}
        <section className="px-5 pb-24 sm:px-8 md:pb-32">
          <div className="relative mx-auto max-w-[1100px] overflow-hidden rounded-[32px] bg-ink-surface px-7 py-16 text-center sm:px-12 md:py-24">
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 -top-40 mx-auto h-80 max-w-[720px] rounded-full"
              style={{ background: 'radial-gradient(closest-side, rgba(232,176,75,0.16), transparent)' }}
            />
            <h2 className="type-section relative mx-auto max-w-[18ch] text-balance text-mist">
              Ready to Apply What You&rsquo;ve Learned?
            </h2>
            <p className="type-intro relative mx-auto mt-5 max-w-[40rem] text-balance text-mist-2">
              Run the circle your family already trusts &mdash; with a pot that nobody, including
              us, can move, and a record every member can check for themselves.
            </p>
            <div className="relative mt-10 flex flex-col items-center justify-center gap-5 sm:flex-row sm:gap-8">
              <Link href="/create-circle" className={goldButtonClass}>
                Create Your Circle
              </Link>
              <ChevronLink href="/dashboard">View Dashboard</ChevronLink>
            </div>
          </div>
        </section>

        {/* ================= DISCLAIMER ================= */}
        <aside className="px-5 pb-16 sm:px-8">
          <p className="type-fine mx-auto max-w-[44rem] text-center text-mist-3">
            <strong className="font-semibold text-mist-2">Educational Disclaimer:</strong> This
            content is for educational purposes only and does not constitute financial advice.
            Njangi On-Chain is coordination software for savings circles: it never holds your money,
            never offers an investment, and never pays a return. Take part only with an amount your
            group can commit to the schedule.
          </p>
        </aside>
      </MarketingShell>
    </>
  );
} 