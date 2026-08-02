// /learn/chama — pillar page.
//
// Promoted from the glossary (hasPillarPage: true in src/content/rosca-terms.ts),
// so the URL is unchanged and there is no second page competing for the term.
// See src/pages/learn/chit-fund.tsx for the full reasoning on the pattern.
//
// Why chama: Search Console already shows Kenya sending impressions with nothing
// but a glossary entry to land on, and the chama is the one tradition on the
// list that routinely outgrows the rotating pot — which gives it something to
// say that the others do not.
//
// Everything renders. No tabs.

import Link from 'next/link';

import { ArticleLayout, cardClass, chipClass } from '@/components/marketing/ArticleLayout';
import { Seo } from '@/components/Seo';
import { relatedLink, termBySlug } from '@/content/rosca-terms';
import { article, breadcrumbs, definedTerm, faqPage } from '@/lib/structured-data';

const TERM = termBySlug('chama')!;
const PATH = '/learn/chama';

const FAQS = [
  {
    question: 'What is a chama in Kenya?',
    answer:
      'A chama is a savings group. Members meet on a fixed schedule, contribute an agreed amount, and one member takes the pooled sum each time until everyone has had a turn — the rotating form is often called a merry-go-round. Many chamas also run a second pool that is lent out to members rather than paid round, and a good number eventually buy assets together as a group.',
  },
  {
    question: 'What does chama mean?',
    answer:
      'Chama is Swahili for a group, body or association. It is the same word used for a political party or any organised body; in the financial sense it means the savings group specifically.',
  },
  {
    question: 'What is table banking?',
    answer:
      'Table banking is the lending side of a chama. Money is literally stacked on the table at the meeting and lent to members there and then, repaid over the following meetings with a charge the group sets for itself. It runs alongside the rotating pot rather than replacing it, and it is what lets a chama serve a member who needs money at a moment that is not their turn.',
  },
  {
    question: 'Do chamas need to be registered?',
    answer:
      'Not to exist. Many run on trust and a minute book with no legal status at all. A chama that wants to hold a bank account, sign a contract or own property in the group\'s name registers with the state — commonly as a self-help group, sometimes as a co-operative or a limited company, depending on how far it has grown.',
  },
  {
    question: 'How is a chama different from a merry-go-round?',
    answer:
      'The merry-go-round is the rotating pot specifically — everyone pays in, one person takes it, repeat. Chama is the broader word for the group itself, which may be running a merry-go-round, a lending pool, a shared purchase, or all three at once.',
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

export default function ChamaPage() {
  return (
    <>
      <Seo
        title="What is a Chama? Kenya's Savings Groups Explained"
        titleAbsolute
        description="A chama is a Kenyan savings group: members contribute on a schedule and take the pooled amount in turn. Many also lend to members and buy assets together."
        path={PATH}
        ogType="article"
        image={{ url: '/og/learn-chama.png', alt: 'What is a chama?' }}
        article={{
          publishedTime: '2026-08-02T00:00:00.000Z',
          modifiedTime: '2026-08-02T00:00:00.000Z',
          authorName: 'Njangi On-Chain',
          section: 'Education',
          tags: ['chama', 'kenya', 'merry-go-round', 'table banking', 'rosca'],
        }}
        jsonLd={[
          breadcrumbs([
            { name: 'Home', path: '/' },
            { name: 'Learn', path: '/learn' },
            { name: 'What is a Chama?' },
          ]),
          article({
            headline: "What is a chama? Kenya's savings groups explained",
            description: TERM.shortDefinition,
            path: PATH,
            image: '/og/learn-chama.png',
            datePublished: TERM.published,
            dateModified: TERM.modified,
            section: 'Education',
            keywords: ['chama', 'Kenya', 'merry-go-round', 'table banking', 'ROSCA'],
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
        eyebrow="Rotating savings · Kenya"
        title="What is a chama?"
        standfirst={
          <p>
            A chama is a Kenyan savings group — and the one tradition on this list that routinely
            outgrows the rotating pot it started with. Plenty of chamas that began by passing a
            small sum around now own land together.
          </p>
        }
        breadcrumbs={[
          { label: 'Home', href: '/' },
          { label: 'Learn', href: '/learn' },
          { label: 'Chama' },
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
            <strong>Chama</strong> is Swahili for a group or association — the same word you would
            use for a political party. In the financial sense it means a savings group: people who
            meet on a fixed schedule, contribute an agreed amount, and pass the pooled sum to one
            member each time until everyone has had a turn.
          </p>
          <p>
            That rotating part is often called a <strong>merry-go-round</strong> in Kenyan English,
            which is as plain a description as you could ask for. It is the same structure as a{' '}
            <Link href="/learn/what-is-njangi" className="text-gold-hi underline underline-offset-4 hover:text-gold">
              njangi
            </Link>{' '}
            or a{' '}
            <Link href="/learn/stokvel" className="text-gold-hi underline underline-offset-4 hover:text-gold">
              stokvel
            </Link>
            . What makes a chama a chama is what tends to happen next.
          </p>
        </Section>

        <Section id="meeting" title="The meeting is the institution">
          <p>
            A chama meets, and the meeting is not decoration around the money — it is where the
            money changes hands, where the record is read aloud, and where decisions get made. Miss
            enough meetings and you are not really in the chama, whatever your contributions say.
          </p>
          <p>
            Many chamas are made up entirely of women, and for a great many members the chama is
            simply where financial life happens: it is the group that knows what you earn, what you
            owe, and what you are saving towards. Officials — a chairlady, a treasurer, a secretary
            — are elected, and the minute book is a real document.
          </p>
        </Section>

        <Section id="table-banking" title="Table banking, and why it matters">
          <p>
            A rotating pot has one hard limitation: it can only help you on your turn. If your turn
            is in month nine and the roof goes in month two, the structure has nothing for you.
          </p>
          <p>
            Table banking is the Kenyan answer. Alongside the rotating pot, the group builds a
            second fund that is <em>not</em> paid round. At the meeting that money is stacked on
            the table and lent to whoever needs it, repaid over the following meetings with a
            charge the group sets for itself. The two run at the same time: the merry-go-round
            keeps everyone contributing, and the lending pool handles the timing problem the
            rotation cannot.
          </p>
          <div className={`${cardClass} mt-6 px-6 py-6 sm:px-8`}>
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.2em] text-gold">
              Where this differs from what we build
            </h3>
            <p className="mt-3 text-base leading-7 text-cream-muted">{TERM.regulatoryNote}</p>
          </div>
        </Section>

        <Section id="growth" title="What chamas become">
          <p>
            The chama is the tradition most likely to stop being a savings circle and start being
            something else. A group that begins by passing a modest sum around often ends up buying
            a plot of land together, acquiring equipment, or running a business as a group — with
            the rotation continuing underneath as the mechanism that keeps everyone paying in.
          </p>
          <p>
            That trajectory is why chamas are a recognised economic force in Kenya rather than a
            private arrangement between friends. Banks market group accounts at them. It sits
            inside the wider culture of <em>harambee</em> — pulling together — that runs through
            Kenyan public life, where funding something collectively that no individual could fund
            alone is an ordinary expectation rather than a novelty.
          </p>
          <p>
            A chama that wants to hold a bank account, sign a contract or own property in the
            group&rsquo;s name registers with the state, commonly as a self-help group. Plenty never
            register and run on trust and the minute book indefinitely.
          </p>
        </Section>

        <Section id="diaspora" title="Chamas abroad">
          <p>
            Kenyan communities in the United Kingdom, the United States and the Gulf run chamas
            widely, very often pooling towards a house or a business back home. Diaspora chamas
            tend to carry larger amounts than local ones, which raises the stakes on record-keeping
            considerably — and they are frequently the vehicle through which a group of people in
            three countries buys one piece of land in a fourth.
          </p>
          <p>
            Related groups run across East Africa under their own names: kikoba in Tanzania, and
            the village savings groups found throughout Uganda and Rwanda, all sharing the same
            rotate-and-lend structure.
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
