import Link from 'next/link';
import { Seo } from '../../components/Seo';
import { article, breadcrumbs } from '../../lib/structured-data';
import { MarketingShell } from '../../components/marketing/ArticleLayout';
import { SourcedStat } from '../../components/marketing/SourcedStat';
import { SAVINGS_CLUB_PARTICIPATION } from '../../content/sourced-facts';

export default function WomenLedSavingsCirclesPost() {
  return (
    <>
      <Seo
        title="Women-Led Savings Circles"
        titleAbsolute
        description="Across njangis, chamas, stokvels and tontines, the person holding the money is very often a woman. What that role actually involves, what it costs her, and what a shared record changes about it."
        path="/blog/women-led-savings-circles-africa"
        ogType="article"
        image={{
          url: '/og/blog.png',
          alt: 'Women-led savings circles',
        }}
        article={{
          publishedTime: '2026-08-24T00:00:00.000Z',
          modifiedTime: '2026-08-24T00:00:00.000Z',
          authorName: 'Njangi On-Chain',
          section: 'Community finance',
          tags: ['njangi', 'chama', 'stokvel', 'tontine', 'women'],
        }}
        jsonLd={[
          breadcrumbs([
            { name: 'Home', path: '/' },
            { name: 'Blog', path: '/blog' },
            { name: 'Women-led savings circles' },
          ]),
          article({
            headline: 'Women-led savings circles: who actually runs the money',
            description:
              'The organiser of a rotating savings circle is very often a woman. What the role involves, what it costs her, and what changes when the record is shared.',
            path: '/blog/women-led-savings-circles-africa',
            image: '/og/blog.png',
            datePublished: '2026-08-24',
            dateModified: '2026-08-24',
            section: 'Community finance',
            keywords: ['njangi', 'chama', 'stokvel', 'tontine', 'savings group'],
          }),
        ]}
      />

      <MarketingShell>
        {/* Navigation */}
        <nav className="bg-ink-surface border-b">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex items-center space-x-2 py-3 text-sm text-sand">
              <Link href="/" className="hover:text-gold transition-colors">Home</Link>
              <span>/</span>
              <Link href="/blog" className="hover:text-gold transition-colors">Blog</Link>
              <span>/</span>
              <span className="text-cream font-medium">Women-led savings circles</span>
            </div>
          </div>
        </nav>

        <article className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
          <header className="mb-12">
            <div className="flex items-center mb-6">
              <span className="bg-gold/[0.07] text-gold text-sm font-semibold px-3 py-1 rounded-full">
                Social Impact
              </span>
              <span className="text-sand-dim ml-4 text-sm">9 min read &bull; 24 August 2026</span>
            </div>

            <h1 className="text-4xl md:text-5xl font-bold text-cream mb-6 leading-tight">
              Women-Led Savings Circles: Who Actually Runs the Money
            </h1>

            <p className="text-xl text-sand mb-8 leading-relaxed">
              Across njangis, chamas, stokvels and tontines, the person who holds the money is very
              often a woman. The role has a name in every language and a job description in none of
              them. This is what it actually involves &mdash; and what it costs.
            </p>

            <div className="flex items-center space-x-4 border-b border-ink-border pb-8">
              <div className="w-12 h-12 bg-gradient-to-br from-ink-surface to-ink-deep rounded-full flex items-center justify-center text-cream font-semibold text-lg">
                N
              </div>
              <div>
                <div className="font-semibold text-cream">Njangi On-Chain</div>
                <div className="text-sm text-sand">Published 24 August 2026</div>
              </div>
            </div>
          </header>

          <div className="prose prose-lg max-w-none">
            <p className="text-lg text-sand leading-relaxed mb-8">
              Somebody in every savings circle keeps the book. She knows who paid in cash and who
              sent it by phone, who is short this month because of school fees, and whose turn was
              swapped last year and never swapped back. She is rarely called a treasurer. Often she
              is just the person whose house everyone comes to.
            </p>

            <p className="text-sand leading-relaxed mb-8">
              Savings groups are one of the most widely used financial arrangements in the world,
              and they are disproportionately run by women. The organisations that facilitate them
              at scale treat this as the defining feature rather than a detail &mdash; CARE, which has
              helped start savings groups for more than three decades, files the entire programme
              under women&rsquo;s economic justice rather than under microfinance. That placement is a
              judgement about who the model actually serves.
            </p>

            <div className="my-10 rounded-lg border border-ink-border bg-ink-surface p-6">
              <SourcedStat fact={SAVINGS_CLUB_PARTICIPATION} />
              <p className="mt-4 text-sm text-sand-dim">
                This figure is old, and we show its year for that reason: later rounds of the same
                survey report formal and mobile-money saving but stopped publishing an equivalent
                savings-club number. The practice is far better documented than it is measured.
              </p>
            </div>

            <h2 className="text-3xl font-bold text-cream mt-12 mb-6">The job nobody wrote down</h2>

            <p className="text-sand leading-relaxed mb-6">
              Ask what the organiser does and the answer sounds administrative. Watch her for a
              cycle and it is not. The work has four parts, and only the first is bookkeeping.
            </p>

            <p className="text-sand leading-relaxed mb-6">
              <strong className="text-cream">She collects.</strong> Cash arrives in person, in
              different denominations, on different days, sometimes short. Until the pot is handed
              over, it is in her house or on her phone. That is not a metaphor for risk; it is
              risk, and it is hers.
            </p>

            <p className="text-sand leading-relaxed mb-6">
              <strong className="text-cream">She chases.</strong> Every circle has a member who is
              late, and someone has to ask. Asking a cousin, a neighbour or a fellow parishioner for
              money is a social cost paid entirely by the person doing the asking, month after
              month, on behalf of everyone who is glad not to be doing it.
            </p>

            <p className="text-sand leading-relaxed mb-6">
              <strong className="text-cream">She remembers.</strong> The rotation order, the
              swap agreed in March, the member who paid double in June to cover July. In most
              circles this lives in one notebook and one head, and the notebook is the junior
              partner.
            </p>

            <p className="text-sand leading-relaxed mb-8">
              <strong className="text-cream">She arbitrates.</strong> When someone says they paid
              and the book says otherwise, she decides. Not a committee, not a rule &mdash; her, in
              the moment, in front of people she will see at church on Sunday.
            </p>

            <h2 className="text-3xl font-bold text-cream mt-12 mb-6">
              The cost that never appears in the book
            </h2>

            <p className="text-sand leading-relaxed mb-6">
              The risk organisers describe first is almost never theft or robbery. It is
              accusation.
            </p>

            <p className="text-sand leading-relaxed mb-6">
              A circle runs for years on the strength of one person&rsquo;s reputation. A single
              disputed cycle can end it &mdash; not because money went missing, but because there is no
              way to show that it did not. The notebook is hers. The memory is hers. When those two
              disagree with a member&rsquo;s recollection, the honest organiser and the dishonest one
              have exactly the same evidence: none.
            </p>

            <blockquote className="border-l-4 border-gold pl-6 my-10 text-lg text-cream italic">
              The worst part of running a njangi is not holding the money. It is having no way to
              prove what you did with it.
            </blockquote>

            <p className="text-sand leading-relaxed mb-8">
              This is why so many circles quietly dissolve after a bad year, and why the role passes
              to fewer and fewer people. The women best suited to it are often the ones who have
              already been burned by it once.
            </p>

            <h2 className="text-3xl font-bold text-cream mt-12 mb-6">
              What a shared record actually changes
            </h2>

            <p className="text-sand leading-relaxed mb-6">
              Two of those four jobs are bookkeeping problems wearing a social costume, and they are
              the two that a shared record removes.
            </p>

            <p className="text-sand leading-relaxed mb-6">
              If every member can see what was contributed and when, remembering stops being one
              woman&rsquo;s burden and disputes stop being her word against someone else&rsquo;s.
              If the pot sits in escrow that releases to the scheduled member rather than passing
              through her hands, she is no longer holding anyone&rsquo;s cash &mdash; and no longer
              vulnerable to the accusation that she did something with it.
            </p>

            <p className="text-sand leading-relaxed mb-8">
              What is left is the part that was never administrative. Deciding whether to grant
              someone a hardship swap, knowing which member is struggling before they say so,
              holding the group together through a bad month &mdash; none of that is bookkeeping, and
              none of it should be automated. The aim is not to replace the organiser. It is to stop
              charging her personal reputation as the price of a role she is doing for everyone
              else&rsquo;s benefit.
            </p>

            <h2 className="text-3xl font-bold text-cream mt-12 mb-6">What it must not change</h2>

            <p className="text-sand leading-relaxed mb-6">
              There is a version of this that makes things worse, and it is worth naming.
            </p>

            <p className="text-sand leading-relaxed mb-6">
              A system that scores members, ranks them, or reports their behaviour to outsiders
              takes an arrangement built on knowing people and replaces it with an arrangement built
              on judging them. Savings circles work because membership is a social fact &mdash; you
              are in because your aunt vouched for you. Turning that into a rating is not an upgrade;
              it is a different product with different politics, and the organiser loses her
              discretion in the process.
            </p>

            <p className="text-sand leading-relaxed mb-8">
              The same applies to authority. A circle where the software decides and the organiser
              administers has quietly demoted the one person holding it together. The record should
              settle what is factual &mdash; who paid, when, whose turn is next &mdash; and leave
              every question of judgement exactly where it has always been.
            </p>

            <h2 className="text-3xl font-bold text-cream mt-12 mb-6">Twenty years of being reliable</h2>

            <p className="text-sand leading-relaxed mb-6">
              There is one more thing the notebook has never been able to do.
            </p>

            <p className="text-sand leading-relaxed mb-8">
              A woman who has run a circle for two decades has an extraordinary record: hundreds of
              collections, dozens of payouts, and not one of them disputed. It is worth nothing
              outside the room. It cannot be shown to a landlord, a cooperative, or a new circle
              deciding whether to admit her, because it exists only in the memory of people who
              already know her. A shared record is the first version of that history she can take
              with her &mdash; held by her, shown to whoever she chooses, and to nobody else.
            </p>

            <p className="text-sand leading-relaxed mb-8">
              The circle was never the thing that needed fixing. The paperwork was.
            </p>
          </div>

          {/* Related Articles */}
          <section className="mt-16 pt-8 border-t border-ink-border">
            <h3 className="text-2xl font-bold text-cream mb-6">Keep reading</h3>
            <div className="grid md:grid-cols-2 gap-6">
              <Link href="/blog/traditional-savings-circles-vs-on-chain" className="group">
                <div className="border border-ink-border rounded-lg p-4 hover:border-gold/45 hover:shadow-[0_14px_40px_-24px_rgba(0,0,0,0.8)] transition-all">
                  <span className="bg-gold/[0.07] text-gold text-xs font-semibold px-2 py-1 rounded-full">
                    Technology
                  </span>
                  <h4 className="font-semibold text-cream group-hover:text-gold mt-3 mb-2">
                    Traditional Savings Circles vs. On-Chain: What Actually Changes
                  </h4>
                  <p className="text-sm text-sand">
                    A side-by-side on trust, record-keeping, and who holds the money.
                  </p>
                </div>
              </Link>

              <Link href="/learn/what-is-njangi" className="group">
                <div className="border border-ink-border rounded-lg p-4 hover:border-gold/45 hover:shadow-[0_14px_40px_-24px_rgba(0,0,0,0.8)] transition-all">
                  <span className="bg-gold/[0.07] text-gold text-xs font-semibold px-2 py-1 rounded-full">
                    Learn
                  </span>
                  <h4 className="font-semibold text-cream group-hover:text-gold mt-3 mb-2">
                    Njangi Meaning: Cameroon&rsquo;s Savings Circle Explained
                  </h4>
                  <p className="text-sm text-sand">
                    How the rotation works, and why the practice has lasted.
                  </p>
                </div>
              </Link>
            </div>
          </section>

          {/* Author */}
          <section className="mt-12 pt-8 border-t border-ink-border">
            <div className="flex items-start space-x-4">
              <div className="w-16 h-16 bg-gradient-to-br from-ink-surface to-ink-deep rounded-full flex items-center justify-center text-cream font-semibold text-xl">
                N
              </div>
              <div className="flex-1">
                <h4 className="text-lg font-semibold text-cream">Njangi On-Chain</h4>
                <p className="text-sm text-sand mb-3">
                  We build coordination software for rotating savings circles. We write about how
                  these circles work, what changes when the record is shared, and what deliberately
                  does not.
                </p>
                <div className="flex space-x-4 text-sm">
                  <span className="text-sand-dim">Follow:</span>
                  <a href="https://x.com/njangi_on_chain" className="text-gold hover:text-gold">X</a>
                  <a href="https://www.instagram.com/njangionchain" className="text-gold hover:text-gold">Instagram</a>
                </div>
              </div>
            </div>
          </section>
        </article>

        {/* Disclaimer */}
        <footer className="bg-ink-surface mt-16">
          <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
            <p className="text-sm text-sand text-center">
              <strong>Disclaimer:</strong> This content is for educational purposes only and does not constitute financial advice.
              Njangi On-Chain is coordination software for savings circles: it never holds your money, never offers an investment, and never pays a return. Take part only with an amount your group can commit to the schedule.
            </p>
          </div>
        </footer>
      </MarketingShell>
    </>
  );
}
