import Link from 'next/link';
import { Seo } from '../../components/Seo';
import { article, breadcrumbs } from '../../lib/structured-data';
import { MarketingShell } from '../../components/marketing/ArticleLayout';

export default function RegulatorsSavingsCirclesPost() {
  return (
    <>
      <Seo
        title="How Regulators Treat Community Savings Circles"
        titleAbsolute
        description="In most places an informal savings circle sits outside financial regulation entirely. That is usually fine, and it means nobody is coming to help if it goes wrong. What the rules actually say, and where a circle can cross a line."
        path="/blog/how-regulators-treat-savings-circles"
        ogType="article"
        image={{
          url: '/og/blog.png',
          alt: 'How regulators treat community savings circles',
        }}
        article={{
          publishedTime: '2026-08-28T00:00:00.000Z',
          modifiedTime: '2026-08-28T00:00:00.000Z',
          authorName: 'Njangi On-Chain',
          section: 'Community finance',
          tags: ['regulation', 'njangi', 'tontine', 'savings group'],
        }}
        jsonLd={[
          breadcrumbs([
            { name: 'Home', path: '/' },
            { name: 'Blog', path: '/blog' },
            { name: 'How regulators treat savings circles' },
          ]),
          article({
            headline: 'How regulators treat community savings circles',
            description:
              'Informal savings circles usually sit outside financial regulation. What that means in practice, what happened when a company held the money, and where a circle can cross a line.',
            path: '/blog/how-regulators-treat-savings-circles',
            image: '/og/blog.png',
            datePublished: '2026-08-28',
            dateModified: '2026-08-28',
            section: 'Community finance',
            keywords: ['regulation', 'ROSCA', 'njangi', 'tontine', 'savings group'],
          }),
        ]}
      />

      <MarketingShell>
        <nav className="bg-ink-surface border-b">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex items-center space-x-2 py-3 text-sm text-sand">
              <Link href="/" className="hover:text-gold transition-colors">Home</Link>
              <span>/</span>
              <Link href="/blog" className="hover:text-gold transition-colors">Blog</Link>
              <span>/</span>
              <span className="text-cream font-medium">Regulation</span>
            </div>
          </div>
        </nav>

        <article className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
          <header className="mb-12">
            <div className="flex items-center mb-6">
              <span className="bg-gold/[0.07] text-gold text-sm font-semibold px-3 py-1 rounded-full">
                Regulation
              </span>
              <span className="text-sand-dim ml-4 text-sm">11 min read &bull; 28 August 2026</span>
            </div>

            <h1 className="text-4xl md:text-5xl font-bold text-cream mb-6 leading-tight">
              How Regulators Treat Community Savings Circles
            </h1>

            <p className="text-xl text-sand mb-8 leading-relaxed">
              In most places an informal circle among people who know each other sits outside
              financial regulation entirely. That is usually the right answer &mdash; and it also
              means nobody is coming to help if it goes wrong.
            </p>

            <div className="flex items-center space-x-4 border-b border-ink-border pb-8">
              <div className="w-12 h-12 bg-gradient-to-br from-ink-surface to-ink-deep rounded-full flex items-center justify-center text-cream font-semibold text-lg">
                N
              </div>
              <div>
                <div className="font-semibold text-cream">Njangi On-Chain</div>
                <div className="text-sm text-sand">Published 28 August 2026</div>
              </div>
            </div>
          </header>

          <div className="prose prose-lg max-w-none">
            <div className="mb-10 rounded-lg border border-gold/30 bg-gold/[0.05] p-6">
              <p className="text-sm text-cream leading-relaxed">
                <strong>Read this first.</strong> This is general information about how savings
                circles are treated, not legal advice, and not advice about your circle. Rules differ
                by country and often by state or province, they change, and how they apply to you
                depends on facts we do not know. If money matters to the answer, ask a qualified
                lawyer where you live.
              </p>
            </div>

            <p className="text-lg text-sand leading-relaxed mb-8">
              People running a njangi, tontine, susu or chama tend to assume one of two things: that
              the whole arrangement is quietly illegal, or that it is covered by the same rules that
              cover a bank. Both are usually wrong, and the truth sits in an awkward middle that is
              worth understanding before you start one.
            </p>

            <h2 className="text-3xl font-bold text-cream mt-12 mb-6">The short answer</h2>

            <p className="text-sand leading-relaxed mb-6">
              A small circle among people who already know each other, where everyone pays the same
              amount, everyone takes a turn, and nobody takes a cut, is generally lawful and
              generally unregulated. Financial rules are written for firms taking money from the
              public, not for eleven relatives taking turns.
            </p>

            <p className="text-sand leading-relaxed mb-8">
              In the United States, rotating savings arrangements among trusted individuals are
              broadly treated as lawful informal mutual aid; they are also a recognised grey area,
              because a circle that grows large enough or starts behaving commercially can drift
              into territory the rules were written for. In Cameroon the position is starker: the
              tontine is a social institution of enormous practical importance that has no formal
              legal standing, which is precisely why it cannot be used as security or enforced the
              way a registered arrangement can. Microfinance in the region is licensed and
              supervised; the tontine sits outside that perimeter.
            </p>

            <h2 className="text-3xl font-bold text-cream mt-12 mb-6">
              What &ldquo;unregulated&rdquo; actually buys you
            </h2>

            <p className="text-sand leading-relaxed mb-6">
              Being outside the perimeter is mostly good news. No licence, no capital requirement, no
              reporting, no one telling a family how to organise itself.
            </p>

            <p className="text-sand leading-relaxed mb-8">
              It also means every protection you might assume exists does not. There is no
              compensation scheme if the money disappears. There is no ombudsman to complain to. If
              the person holding the pot spends it, your remedy is whatever the ordinary courts give
              you, which in practice means suing a relative &mdash; expensive, slow, and socially
              impossible in exactly the circumstances where you would need it. Nobody is examining
              the books, because there are no books to examine.
            </p>

            <blockquote className="border-l-4 border-gold pl-6 my-10 text-lg text-cream italic">
              Unregulated does not mean unsafe. It means the safety has to come from the
              arrangement itself, because it is not coming from anywhere else.
            </blockquote>

            <h2 className="text-3xl font-bold text-cream mt-12 mb-6">
              What happened when a company held the money
            </h2>

            <p className="text-sand leading-relaxed mb-6">
              The clearest illustration is not from a njangi at all. It is Farepak, a British
              Christmas savings club that collapsed in 2006 holding roughly{' '}
              <strong className="text-cream">£37 million</strong> of customers&rsquo; money. The
              savers were mostly on low incomes and had paid in weekly across the year.
            </p>

            <p className="text-sand leading-relaxed mb-6">
              The money had not been ring-fenced. When the company failed, the people who had paid in
              were, in the UK government&rsquo;s own later words, consumers who{' '}
              <em>&ldquo;do not have any special protections afforded to them&rdquo;</em> &mdash;
              ordinary unsecured creditors, near the back of the queue, recovering very little. They
              had done nothing wrong. They had saved diligently for a year with a company that
              advertised itself as a savings club.
            </p>

            <p className="text-sand leading-relaxed mb-8">
              What makes Farepak worth studying is the fix that followed. Parliament did not decide
              that savings clubs should be licensed like banks. It concluded that the money should be
              held in trust &mdash; separated from the operator, so that the operator failing does
              not take the savers down with it. The UK has since gone further: schemes marketed as
              savings are now required to protect customers&rsquo; funds through trusts, insurance or
              bonds.
            </p>

            <p className="text-sand leading-relaxed mb-8">
              That is the regulatory lesson of the last twenty years, and it is narrower than people
              expect. The question regulators kept arriving at was not <em>is this scheme
              licensed?</em> It was <em>who is holding the money, and what happens to it when they
              have a bad year?</em>
            </p>

            <h2 className="text-3xl font-bold text-cream mt-12 mb-6">Where a circle can cross a line</h2>

            <p className="text-sand leading-relaxed mb-6">
              A circle stops looking like eleven relatives taking turns, and starts looking like a
              financial business, at fairly predictable moments. None of these is automatically
              unlawful; each is a point where it stops being obvious that no rules apply.
            </p>

            <ul className="list-disc pl-6 space-y-3 text-sand mb-8">
              <li>
                <strong className="text-cream">Somebody takes a cut.</strong> The moment an organiser
                is paid out of the pot rather than thanked, the arrangement has a commercial operator
                in it.
              </li>
              <li>
                <strong className="text-cream">Strangers are recruited.</strong> A circle among
                people who vouch for each other is different from one advertised to the public.
                Soliciting money from people you do not know is the single biggest step across.
              </li>
              <li>
                <strong className="text-cream">A profit is promised.</strong> If members are told
                they will get back more than they put in, the arrangement is being described as an
                investment, whatever it is called.
              </li>
              <li>
                <strong className="text-cream">Money is collected for a third party.</strong>{' '}
                Pooling for someone outside the group, particularly publicly, can engage
                charitable-solicitation rules in some places.
              </li>
              <li>
                <strong className="text-cream">One person moves money for others.</strong> Holding
                and forwarding other people&rsquo;s funds, especially across borders, is the activity
                money-transmission rules exist to catch.
              </li>
              <li>
                <strong className="text-cream">It gets big.</strong> Scale alone changes how an
                arrangement is read, even when nothing else has changed.
              </li>
            </ul>

            <h2 className="text-3xl font-bold text-cream mt-12 mb-6">
              A practical checklist for organisers
            </h2>

            <p className="text-sand leading-relaxed mb-6">
              None of this is legal advice, and none of it substitutes for asking locally. It is the
              set of habits that keeps a circle looking like what it actually is.
            </p>

            <ol className="list-decimal pl-6 space-y-3 text-sand mb-8">
              <li>
                <strong className="text-cream">Write the rules down before anyone pays in.</strong>{' '}
                Amount, schedule, rotation order, what happens if someone is late, what happens if
                someone leaves. Agreed in advance, it is a rule; agreed afterwards, it is a dispute.
              </li>
              <li>
                <strong className="text-cream">Keep a record every member can see.</strong> The
                organiser&rsquo;s private notebook is the single most common point of failure, and it
                fails hardest for the organiser herself, who has no way to prove she was honest.
              </li>
              <li>
                <strong className="text-cream">Do not take a cut.</strong> Not a fee, not a
                percentage, not the first turn as compensation.
              </li>
              <li>
                <strong className="text-cream">Do not recruit strangers.</strong> Keep membership to
                people the group can actually vouch for.
              </li>
              <li>
                <strong className="text-cream">Do not promise anyone a profit.</strong> A circle
                moves money between members on a schedule. It does not grow it, and saying otherwise
                changes what the arrangement is.
              </li>
              <li>
                <strong className="text-cream">Think about who holds the pot between hands.</strong>{' '}
                This is the Farepak question, and it applies to a family circle exactly as it applied
                to a company: if the money sits with one party, everyone else is relying on that
                party&rsquo;s good year.
              </li>
            </ol>

            <h2 className="text-3xl font-bold text-cream mt-12 mb-6">Two things we are not going to tell you</h2>

            <p className="text-sand leading-relaxed mb-6">
              <strong className="text-cream">Whether your circle is legal.</strong> We do not know
              where you live, how big your group is, or how it is run, and a confident answer from a
              software company is worth nothing when it turns out to be wrong.
            </p>

            <p className="text-sand leading-relaxed mb-8">
              <strong className="text-cream">Our own regulatory position.</strong> It would be easy to
              end an article like this by declaring which rules do and do not apply to us. Companies
              do it constantly. We are not going to, because that is a question for qualified counsel
              and not a marketing claim &mdash; and a self-certified regulatory posture is worth
              exactly as much as the certifier&rsquo;s incentive to be right about it. What we can
              describe is structural rather than legal: each cycle&rsquo;s contributions sit in
              escrow that releases to the scheduled member, and no operator function can move them.
              That is a fact about the code, checkable by anyone, and it is a different kind of claim
              from an opinion about the law.
            </p>

            <p className="text-sand leading-relaxed mb-8">
              Which is really the theme of the whole subject. The savings circle has outlasted most
              of the institutions that tried to replace it, and it did so without a licence. What it
              has never had is a way for members to see, without trusting anyone&rsquo;s word, that
              the money is where it is supposed to be. That gap is not a regulatory problem. It is a
              record-keeping one.
            </p>
          </div>

          {/* Sources */}
          <section className="mt-12 pt-8 border-t border-ink-border">
            <h3 className="text-lg font-semibold text-cream mb-4">Sources</h3>
            <ul className="space-y-2 text-sm text-sand">
              <li>
                UK Government response to the Law Commission report on consumer prepayments on
                retailer insolvency &mdash; Farepak figures and the position of prepaying consumers
                on insolvency.{' '}
                <a
                  href="https://www.gov.uk/government/publications/consumer-prepayments-on-retailer-insolvency-government-response-to-the-law-commission-report/law-commission-report-on-consumer-prepayments-on-retailer-insolvency-government-response"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-gold underline-offset-4 hover:underline"
                >
                  gov.uk
                </a>
              </li>
              <li>
                House of Commons Treasury Committee, Thirteenth Report of Session 2006&ndash;07, on
                Farepak and the protection of savings-club customers.{' '}
                <a
                  href="https://publications.parliament.uk/pa/cm200607/cmselect/cmtreasy/504/50407.htm"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-gold underline-offset-4 hover:underline"
                >
                  parliament.uk
                </a>
              </li>
            </ul>
          </section>

          {/* Related */}
          <section className="mt-12 pt-8 border-t border-ink-border">
            <h3 className="text-2xl font-bold text-cream mb-6">Keep reading</h3>
            <div className="grid md:grid-cols-2 gap-6">
              <Link href="/blog/women-led-savings-circles-africa" className="group">
                <div className="border border-ink-border rounded-lg p-4 hover:border-gold/45 hover:shadow-[0_14px_40px_-24px_rgba(0,0,0,0.8)] transition-all">
                  <span className="bg-gold/[0.07] text-gold text-xs font-semibold px-2 py-1 rounded-full">
                    Social Impact
                  </span>
                  <h4 className="font-semibold text-cream group-hover:text-gold mt-3 mb-2">
                    Women-Led Savings Circles: Who Actually Runs the Money
                  </h4>
                  <p className="text-sm text-sand">
                    What the organiser&rsquo;s role involves, and what it costs her.
                  </p>
                </div>
              </Link>

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
