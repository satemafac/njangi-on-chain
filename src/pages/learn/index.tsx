import Link from 'next/link';
import { Seo } from '../../components/Seo';
import { breadcrumbs, definedTermSet } from '../../lib/structured-data';
import { ROSCA_TERMS } from '../../content/rosca-terms';
import { MarketingShell } from '../../components/marketing/ArticleLayout';
import { SourcedStat, PlainStat } from '../../components/marketing/SourcedStat';
import { REMITTANCES_AFRICA, REMITTANCE_COST_AFRICA, SAVINGS_CLUB_PARTICIPATION } from '../../content/sourced-facts';

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
      readTime: "5 min read",
      color: "green"
    },
    {
      title: "What is a ROSCA?",
      subtitle: "The structure behind all of them",
      description: "Rotating savings and credit association — the economists' name for what njangi, tontine, susu and chit funds all are.",
      href: "/learn/rosca",
      tag: "Fundamentals",
      readTime: "7 min read",
      color: "blue"
    },
    {
      title: "What is a Tontine?",
      subtitle: "Francophone Africa",
      description: "How tontines run across West and Central Africa, and why the word means something different in French financial history.",
      href: "/learn/tontine",
      tag: "Regional Focus",
      readTime: "9 min read",
      color: "purple"
    },
    {
      title: "What is a Susu?",
      subtitle: "The Caribbean and West Africa",
      description: "Susu, sou-sou and Partner — one practice carried across the Atlantic, and still running on both sides of it.",
      href: "/learn/susu",
      tag: "Cultural Traditions",
      readTime: "8 min read",
      color: "orange"
    }
  ];

  const getColorClasses = (color: string) => {
    const colors = {
      green: {
        border: "border-gold/45",
        bg: "bg-gold/[0.07]",
        text: "text-gold",
        hover: "hover:border-gold/45"
      },
      blue: {
        border: "border-gold/45",
        bg: "bg-gold/[0.07]",
        text: "text-gold",
        hover: "hover:border-gold/45"
      },
      purple: {
        border: "border-gold/45",
        bg: "bg-gold/[0.07]",
        text: "text-gold",
        hover: "hover:border-gold/45"
      },
      orange: {
        border: "border-gold/45",
        bg: "bg-gold/[0.07]",
        text: "text-gold",
        hover: "hover:border-gold/45"
      }
    };
    return colors[color as keyof typeof colors] || colors.blue;
  };

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

      <MarketingShell>
        {/* Navigation Breadcrumb */}
        <nav className="bg-ink-surface border-b">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex items-center space-x-2 py-3 text-sm text-sand">
              <Link href="/" className="hover:text-gold transition-colors">Home</Link>
              <span>/</span>
              <span className="text-cream font-medium">Learn</span>
            </div>
          </div>
        </nav>

        {/* Hero Section */}
        <section className="relative bg-gradient-to-r from-ink-surface to-ink-deep text-cream py-20">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="text-center">
              <h1 className="text-4xl md:text-6xl font-bold mb-6">
                Learn About Blockchain Savings Circles
              </h1>
              <p className="text-xl md:text-2xl mb-8 text-cream-muted max-w-4xl mx-auto">
                Discover how traditional savings circles from around the world are being revolutionized 
                by blockchain technology, smart contracts, and decentralized finance.
              </p>
              <div className="flex flex-col sm:flex-row gap-4 justify-center">
                <Link 
                  href="/create-circle" 
                  className="bg-ink-surface text-gold px-8 py-3 rounded-lg font-semibold hover:bg-ink-surface transition-colors"
                >
                  Start Learning by Doing →
                </Link>
                <Link 
                  href="#articles" 
                  className="border border-gold-deep/55 text-cream px-8 py-3 rounded-lg font-semibold hover:bg-ink-surface hover:text-gold transition-colors"
                >
                  Browse Articles
                </Link>
              </div>
            </div>
          </div>
        </section>

        {/* Figures carry their source. The block this replaced showed four big
            round numbers — a global participant count, an annual volume, and a
            country count that exceeded the number of countries that exist —
            with nothing behind any of them. */}
        <section className="bg-ink-surface border-b border-ink-border">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-8">
              <SourcedStat fact={REMITTANCES_AFRICA} />
              <SourcedStat fact={REMITTANCE_COST_AFRICA} />
              <SourcedStat fact={SAVINGS_CLUB_PARTICIPATION} />
              <PlainStat
                value="Self-custodied"
                label="No operator function can move member funds — the contract has no admin path to a circle's balance"
              />
            </div>
          </div>
        </section>

        {/* Main Learning Articles */}
        <section id="articles" className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-bold text-cream mb-4">Educational Articles</h2>
            <p className="text-lg text-sand max-w-3xl mx-auto">
              Start with the fundamentals and progress through regional variations to understand 
              how blockchain technology transforms traditional community finance.
            </p>
          </div>

          <div className="grid md:grid-cols-2 gap-8">
            {articles.map((article, index) => {
              const colorClasses = getColorClasses(article.color);
              return (
                <Link key={index} href={article.href} className="group">
                  <article className={`border ${colorClasses.border} ${colorClasses.hover} rounded-lg overflow-hidden shadow-[0_20px_60px_-30px_rgba(0,0,0,0.85)] hover:shadow-xl transition-all duration-300`}>
                    <div className={`${colorClasses.bg} p-4`}>
                      <div className="flex items-center justify-between mb-2">
                        <span className={`text-xs font-semibold ${colorClasses.text} bg-ink-surface px-2 py-1 rounded`}>
                          {article.tag}
                        </span>
                        <span className="text-xs text-sand-dim">{article.readTime}</span>
                      </div>
                    </div>
                    
                    <div className="p-6">
                      <h3 className="text-xl font-bold text-cream mb-2 group-hover:text-gold transition-colors">
                        {article.title}
                      </h3>
                      <h4 className={`text-lg font-semibold ${colorClasses.text} mb-3`}>
                        {article.subtitle}
                      </h4>
                      <p className="text-sand text-sm leading-relaxed">
                        {article.description}
                      </p>
                      
                      <div className="mt-4 flex items-center text-sm text-gold group-hover:text-gold">
                        Read Article
                        <svg className="ml-2 w-4 h-4 group-hover:translate-x-1 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                        </svg>
                      </div>
                    </div>
                  </article>
                </Link>
              );
            })}
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
        <section id="glossary" className="bg-ink-deep border-t border-ink-border">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
            <div className="mb-10">
              <h2 className="text-3xl font-bold text-cream mb-4">
                One tradition, many names
              </h2>
              <p className="text-lg text-sand max-w-3xl">
                The same rotating savings circle runs on every inhabited continent under a
                different name. Each entry covers where it comes from, how the turn order gets
                decided, and what makes that version distinct.
              </p>
            </div>

            <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {ROSCA_TERMS.map((term) => (
                <li key={term.slug}>
                  <Link
                    href={`/learn/${term.slug}`}
                    className="group flex h-full flex-col rounded-2xl border border-ink-border bg-ink-surface/70 p-5 transition-colors duration-200 hover:border-gold/45"
                  >
                    <span className="flex items-baseline justify-between gap-3">
                      <span className="text-lg font-semibold text-cream group-hover:text-gold-hi">
                        {term.term}
                      </span>
                      <span className="shrink-0 text-[11px] font-semibold uppercase tracking-[0.18em] text-gold">
                        {term.region.split(',')[0]}
                      </span>
                    </span>
                    <span className="mt-2 text-sm leading-6 text-sand">
                      {term.shortDefinition}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* Learning Path */}
        <section className="bg-ink-surface">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
            <div className="text-center mb-12">
              <h2 className="text-3xl font-bold text-cream mb-4">Recommended Learning Path</h2>
              <p className="text-lg text-sand">
                Follow this sequence to build a comprehensive understanding of blockchain savings circles.
              </p>
            </div>

            <div className="relative">
              {/* Learning path line */}
              <div className="hidden md:block absolute left-1/2 transform -translate-x-1/2 w-1 bg-gradient-to-b from-ink-surface via-ink-surface via-ink-surface to-ink-deep h-full"></div>
              
              <div className="space-y-12">
                {articles.map((article, index) => {
                  const colorClasses = getColorClasses(article.color);
                  const isEven = index % 2 === 0;
                  
                  return (
                    <div key={index} className={`flex items-center ${isEven ? 'md:flex-row' : 'md:flex-row-reverse'}`}>
                      <div className={`flex-1 ${isEven ? 'md:pr-8' : 'md:pl-8'}`}>
                        <div className={`bg-ink-surface border ${colorClasses.border} rounded-lg p-6 shadow-[0_20px_60px_-30px_rgba(0,0,0,0.85)]`}>
                          <div className="flex items-center mb-3">
                            <div className={`w-8 h-8 ${colorClasses.bg} ${colorClasses.text} rounded-full flex items-center justify-center font-bold text-sm mr-3`}>
                              {index + 1}
                            </div>
                            <span className={`text-xs font-semibold ${colorClasses.text} bg-ink-surface px-2 py-1 rounded`}>
                              {article.tag}
                            </span>
                          </div>
                          <h3 className="text-xl font-bold text-cream mb-2">{article.title}</h3>
                          <p className="text-sand text-sm mb-4">{article.description}</p>
                          <Link 
                            href={article.href}
                            className={`inline-flex items-center text-sm font-semibold ${colorClasses.text} hover:underline`}
                          >
                            Start Reading
                            <svg className="ml-1 w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                            </svg>
                          </Link>
                        </div>
                      </div>
                      
                      {/* Center dot - only visible on larger screens */}
                      <div className="hidden md:flex w-4 h-4 bg-ink-surface border-4 border-gold/45 rounded-full relative z-10"></div>
                      
                      <div className="flex-1"></div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </section>

        {/* Topics Overview */}
        <section className="bg-ink-deep">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
            <div className="text-center mb-12">
              <h2 className="text-3xl font-bold text-cream mb-4">Topics Covered</h2>
              <p className="text-lg text-sand">
                Comprehensive coverage of traditional and blockchain-powered savings systems.
              </p>
            </div>

            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-8">
              <div className="bg-ink-surface rounded-lg p-6 shadow-[0_20px_60px_-30px_rgba(0,0,0,0.85)]">
                <h3 className="text-lg font-semibold text-cream mb-3">Traditional Systems</h3>
                <ul className="space-y-2 text-sm text-sand">
                  <li>• Historical origins and cultural significance</li>
                  <li>• How rotating savings circles work</li>
                  <li>• Regional variations worldwide</li>
                  <li>• Common challenges and limitations</li>
                </ul>
              </div>

              <div className="bg-ink-surface rounded-lg p-6 shadow-[0_20px_60px_-30px_rgba(0,0,0,0.85)]">
                <h3 className="text-lg font-semibold text-cream mb-3">Blockchain Technology</h3>
                <ul className="space-y-2 text-sm text-sand">
                  <li>• Smart contract automation</li>
                  <li>• Cryptographic security benefits</li>
                  <li>• Transparent and immutable records</li>
                  <li>• Global accessibility features</li>
                </ul>
              </div>

              <div className="bg-ink-surface rounded-lg p-6 shadow-[0_20px_60px_-30px_rgba(0,0,0,0.85)]">
                <h3 className="text-lg font-semibold text-cream mb-3">Partner-led Fiat Ramps</h3>
                <ul className="space-y-2 text-sm text-sand">
                  <li>• Coinbase, MoonPay, Transak on/off-ramps</li>
                  <li>• Multi-currency support (USD, EUR, XAF, NGN, KES…)</li>
                  <li>• KYC and AML handled by licensed partners</li>
                  <li>• Geo-aware provider selection</li>
                </ul>
              </div>
            </div>
          </div>
        </section>

        {/* CTA Section */}
        <section className="bg-gradient-to-r from-ink-surface to-ink-deep text-cream">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-16 text-center">
            <h2 className="text-3xl font-bold mb-4">Ready to Apply What You&rsquo;ve Learned?</h2>
            <p className="text-xl text-cream-muted mb-8 max-w-3xl mx-auto">
              Join thousands of people worldwide who are using blockchain technology to enhance
              their traditional savings circles with non-custodial security and full transparency.
            </p>
            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <Link 
                href="/create-circle"
                className="bg-ink-surface text-gold px-8 py-3 rounded-lg font-semibold hover:bg-ink-surface transition-colors"
              >
                Create Your Circle
              </Link>
              <Link 
                href="/dashboard"
                className="border border-gold-deep/55 text-cream px-8 py-3 rounded-lg font-semibold hover:bg-ink-surface hover:text-gold transition-colors"
              >
                Browse Existing Circles
              </Link>
            </div>
          </div>
        </section>

        {/* Footer */}
        <footer className="bg-ink-surface">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
            <p className="text-sm text-sand text-center">
              <strong>Educational Disclaimer:</strong> This content is for educational purposes only and does not constitute financial advice. 
              Always consult with qualified financial advisors before making investment decisions.
            </p>
          </div>
        </footer>
      </MarketingShell>
    </>
  );
} 