import { Seo } from '../../components/Seo';
import { article, breadcrumbs } from '../../lib/structured-data';
import { BlogPost } from '../../components/marketing/BlogPost';
import { Figures } from '../../components/marketing/ProseBlocks';
import { SourcedStat } from '../../components/marketing/SourcedStat';
import {
  REMITTANCES_AFRICA,
  REMITTANCE_COST_AFRICA,
  REMITTANCE_COST_GLOBAL,
} from '../../content/sourced-facts';

export default function DiasporaRemittancesPost() {
  return (
    <>
      <Seo
        title="Diaspora Remittances and Savings Circles"
        titleAbsolute
        description="Sending $200 to Sub-Saharan Africa costs 7.9% on average. A savings circle does not change that number. What it changes is whether the person sending is a member or only a source of funds."
        path="/blog/african-diaspora-remittances"
        ogType="article"
        image={{
          url: '/og/blog.png',
          alt: 'Diaspora remittances and savings circles',
        }}
        article={{
          publishedTime: '2026-08-28T00:00:00.000Z',
          modifiedTime: '2026-08-28T00:00:00.000Z',
          authorName: 'Njangi On-Chain',
          section: 'Community finance',
          tags: ['diaspora', 'remittances', 'njangi', 'tontine'],
        }}
        jsonLd={[
          breadcrumbs([
            { name: 'Home', path: '/' },
            { name: 'Blog', path: '/blog' },
            { name: 'Diaspora remittances' },
          ]),
          article({
            headline: 'Sending money home is not the same as belonging',
            description:
              'What a rotating savings circle changes about diaspora money — and what it deliberately does not.',
            path: '/blog/african-diaspora-remittances',
            image: '/og/blog.png',
            datePublished: '2026-08-28',
            dateModified: '2026-08-28',
            section: 'Community finance',
            keywords: ['remittances', 'diaspora', 'njangi', 'tontine', 'savings group'],
          }),
        ]}
      />

      <BlogPost
        crumb="Diaspora remittances"
        category="Diaspora"
        meta="10 min read · 28 August 2026"
        title="Sending Money Home Isn’t the Same as Belonging"
        dek={
          <>
            The cost of sending money to Sub-Saharan Africa is a real, measured, stubborn problem.
            A savings circle does not fix it, and anyone telling you otherwise is selling
            something. What a circle changes is quieter, and it is not about the fee.
          </>
        }
        byline="Published 28 August 2026"
        related={[
          {
            href: '/blog/women-led-savings-circles-africa',
            category: 'Social Impact',
            title: 'Women-Led Savings Circles: Who Actually Runs the Money',
            description: 'What the organiser’s role involves, and what it costs her.',
          },
          {
            href: '/blog/traditional-savings-circles-vs-on-chain',
            category: 'Technology',
            title: 'Traditional Savings Circles vs. On-Chain: What Actually Changes',
            description: 'A side-by-side on trust, record-keeping, and who holds the money.',
          },
        ]}
      >
        <p>
          Every month, a great deal of money crosses a border because somebody who left is
          looking after somebody who stayed. It is one of the largest and most reliable financial
          flows in the world, and it is also one of the most expensive to move.
        </p>

        <Figures>
          <SourcedStat fact={REMITTANCES_AFRICA} />
          <SourcedStat fact={REMITTANCE_COST_AFRICA} />
          <SourcedStat fact={REMITTANCE_COST_GLOBAL} />
        </Figures>

        <p>
          Read those two percentages next to each other. Sending money to Sub-Saharan Africa
          costs meaningfully more than sending money almost anywhere else, and it has stayed that
          way through twenty years of companies promising to fix it. The corridor is expensive
          for structural reasons &mdash; thin competition on some routes, cash-out networks that
          have to be paid for, compliance costs spread across small transfers &mdash; and none of
          those reasons is a software problem waiting for a better app.
        </p>

        <h2>What a savings circle does not do</h2>

        <p>
          It is worth being blunt about this early, because the temptation to imply otherwise is
          strong.
        </p>

        <p>
          A rotating savings circle is not a remittance service. It does not move money across a
          border more cheaply than the rail you already use, because it is not a rail. Money
          still has to get in at one end and out at the other using whatever exists locally, and
          those steps carry whatever they carry. We do not settle in cash anywhere, and we take
          nothing out of anyone&rsquo;s contributions or payouts &mdash; which also means there
          is no fee for us to undercut a competitor with.
        </p>

        <p>
          In the home market in particular, getting money out is currently the honest weak point:
          members follow a documented path through an exchange they already use rather than an
          integrated one. We are working on it with licensed partners, and until one is live and
          tested we are not going to describe it as solved.
        </p>

        <blockquote>
          If a savings product tells you it has solved the cost of sending money home, ask which
          licence it holds and who is holding the money in between.
        </blockquote>

        <h2>The part nobody measures</h2>

        <p>
          The 7.9% is measured every quarter by the World Bank. Something else about diaspora
          money is not measured at all, because it is not financial.
        </p>

        <p>
          A remittance is one-directional. You send it, and that is the whole of your role. You
          have no turn coming, no say in what the group does, no record of having been reliable
          for eleven years, and frequently no idea what happened to the money after it landed.
          You are a source of funds. Your aunt, who has never left, is a member.
        </p>

        <p>
          That asymmetry has consequences inside families that have nothing to do with fees. The
          person abroad is asked, repeatedly, and cannot ask back. The people at home are
          receiving, repeatedly, and cannot reciprocate in the currency that matters &mdash;
          which in a savings circle is not money at all, but the standing that comes from having
          taken your turn and honoured it.
        </p>

        <h2>Why the circle stopped at the border</h2>

        <p>
          There is nothing in the idea of a njangi, a tontine or a susu that requires everyone to
          live in the same town. The constraint was always practical.
        </p>

        <p>
          The contributions were cash. The record was a book. Somebody had to physically hold
          both, which meant somebody had to be physically present, which meant the circle&rsquo;s
          edge was however far people could reasonably travel. When a family scattered across
          three countries, the circle did not scatter with it. It stayed where the book was, and
          the relatives who left were moved &mdash; without anyone deciding it &mdash; from the
          column marked members to the column marked senders.
        </p>

        <p>
          Migration split the family. The bookkeeping decided who stayed inside the group.
        </p>

        <h2>What actually changes</h2>

        <p>
          If the record is shared rather than held, and the pot sits in escrow rather than in
          somebody&rsquo;s house, the physical constraint goes away. A circle can include the
          aunt in Douala and the nephew in Maryland on the same terms, because neither of them
          has to be near the book.
        </p>

        <p>
          The change is in role, not in price. The relative abroad stops being the person who is
          asked and becomes a member with a turn in the rotation, a vote if the group needs to
          stop, and a record of every contribution they have made. When their turn comes round,
          the money moves toward them, which for many diaspora members would be a first.
        </p>

        <p>
          Contributions are made in a digital dollar so that everyone is committing the same
          agreed amount regardless of which currency they earn in &mdash; not to make the money
          grow, which it does not, but so that a member in Douala and a member in Maryland are
          plainly paying the same share into the same pot.
        </p>

        <h2>The honest summary</h2>

        <p>
          If your only question is what it costs to move $200 from Maryland to Douala this month,
          a savings circle is not an answer, and the World Bank&rsquo;s number is the one to
          watch.
        </p>

        <p>
          If the question is why the family member who sends the most has the least say in
          anything, that is not a pricing problem and it never was. The remittance moves money.
          The circle moves standing &mdash; and standing was the thing the border took away.
        </p>
      </BlogPost>
    </>
  );
}
