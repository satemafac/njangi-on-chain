import { Seo } from '../../components/Seo';
import { article, breadcrumbs } from '../../lib/structured-data';
import { GuideSection, LearnGuide } from '../../components/marketing/LearnGuide';
import { CodeBlock, KeyPoints, ProseAction, SideBySide, Steps } from '../../components/marketing/ProseBlocks';
import { SourcedStat, PlainStat } from '../../components/marketing/SourcedStat';
import { REMITTANCE_COST_AFRICA, SAVINGS_CLUB_PARTICIPATION } from '../../content/sourced-facts';

export default function BlockchainRoscaPage() {
  return (
    <>
      <Seo
        title="What is a ROSCA? Rotating Savings, Explained"
        titleAbsolute
        description="A ROSCA — rotating savings and credit association — is the structure behind njangi, tontine, susu, chit funds and tanda. How the model works, and where it appears."
        path="/learn/rosca"
        ogType="article"
        image={{ url: '/og/learn-rosca.png', alt: 'What is a ROSCA?' }}
        article={{
          publishedTime: '2025-06-05T00:00:00.000Z',
          modifiedTime: '2026-08-02T00:00:00.000Z',
          authorName: 'Njangi On-Chain',
          section: 'Education',
          tags: ['rosca', 'rotating savings', 'community finance'],
        }}
        jsonLd={[
          breadcrumbs([
            { name: 'Home', path: '/' },
            { name: 'Learn', path: '/learn' },
            { name: 'What is a ROSCA?' },
          ]),
          article({
            headline: 'What is a ROSCA? Rotating savings and credit associations, explained',
            description:
              'The rotating savings and credit association is the structure behind njangi, tontine, susu, chit funds and tanda.',
            path: '/learn/rosca',
            image: '/og/learn-rosca.png',
            datePublished: '2025-06-05',
            dateModified: '2026-08-02',
            section: 'Education',
            keywords: ['ROSCA', 'rotating savings', 'community finance'],
          }),
        ]}
      />

      <LearnGuide
        crumb="ROSCA"
        title="What is a ROSCA? Rotating Savings and Credit Associations Explained"
        standfirst={
          <p>
            The <strong>rotating savings and credit association</strong> is one of the oldest ways
            people save together: everyone pays in on a schedule, and each member takes the whole pot
            in turn. Here is how the model works, where it appears, and how to run one where nobody
            has to hold the money.
          </p>
        }
        actions={{
          primary: { label: 'Start a circle', href: '/create-circle' },
          secondary: { label: 'Explore Platform', href: '/dashboard' },
        }}
        figures={
          <>
            {/* Every figure links to its source. The previous block asserted a
                global participant count, a country count and an annual ROSCA
                volume, none of them sourced. Nobody measures global ROSCA volume —
                the whole point of a ROSCA is that it leaves no institutional
                record — so there is no honest number to replace it with. */}
            <SourcedStat fact={SAVINGS_CLUB_PARTICIPATION} />
            <SourcedStat fact={REMITTANCE_COST_AFRICA} />
            <PlainStat
              value="Every cycle"
              label="Contributions, payout order and approvals stay visible to the whole circle for the life of the circle"
            />
          </>
        }
        toc={[
          { id: 'overview', label: 'ROSCA Overview' },
          { id: 'global', label: 'Global Systems' },
          { id: 'blockchain', label: 'How It Works Here' },
          { id: 'implementation', label: 'Implementation' },
        ]}
        related={[
          {
            href: '/learn/what-is-njangi',
            title: 'What is Njangi? Cameroon’s Savings Circle',
            description: 'Cameroon’s savings circle: how it works, and why it has lasted.',
          },
          {
            href: '/learn/tontine',
            title: 'What is a Tontine? African Savings Circles',
            description: 'The rotating savings circle across West and Central Africa.',
          },
          {
            href: '/learn/susu',
            title: 'What is a Susu? Caribbean & West African Circles',
            description: 'Susu, sou-sou and Partner — the same circle under three names.',
          },
        ]}
        cta={{
          title: 'Run the circle your family already trusts',
          body: 'The same rotation, the same people — with a pot that nobody, including us, can move, and a record every member can check for themselves.',
          primary: { label: 'Start Your Circle', href: '/create-circle' },
          secondary: { label: 'Explore Platform', href: '/dashboard' },
        }}
      >
        <GuideSection id="overview" title="What are ROSCAs?">
          <p className="lead">
            <strong>Rotating Savings and Credit Associations (ROSCAs)</strong> are informal financial
            cooperatives where groups of individuals contribute fixed amounts regularly to a common
            fund. Members take turns receiving the entire pooled amount, creating a rotating credit
            system that provides access to larger sums of money without traditional banking
            requirements.
          </p>

          <SideBySide
            columns={[
              {
                title: 'Core Characteristics',
                points: [
                  'Fixed, regular contributions from all members',
                  'Rotating payout system ensuring fair distribution',
                  'Trust-based community membership',
                  'No interest charges or traditional banking requirements',
                  'Social and financial support network',
                ],
              },
              {
                title: 'Global Impact',
                points: [
                  'Found independently on every inhabited continent',
                  'Works without a bank, a credit history or paperwork',
                  'A common source of working capital for market traders',
                  'Frequently organised and led by women',
                  'Carried abroad intact by diaspora communities',
                ],
              },
            ]}
          />

          <h3>How Traditional ROSCAs Work</h3>
          <Steps
            items={[
              { title: 'Group Formation', body: '8-20 trusted members agree to participate' },
              { title: 'Regular Contributions', body: 'Fixed amounts collected weekly/monthly' },
              { title: 'Rotating Payouts', body: 'Members take turns receiving full amount' },
              { title: 'Cycle Completion', body: 'Process continues until all receive payouts' },
            ]}
          />
        </GuideSection>

        <GuideSection id="global" title="ROSCAs Around the World">
          <h3>Africa</h3>
          <ul>
            <li><strong>Njangi</strong> - Cameroon</li>
            <li><strong>Tontines</strong> - French Africa</li>
            <li><strong>Susu</strong> - Ghana, Sierra Leone</li>
            <li><strong>Stokvels</strong> - South Africa</li>
            <li><strong>Chit Funds</strong> - Kenya</li>
          </ul>

          <h3>Asia</h3>
          <ul>
            <li><strong>Chit Funds</strong> - India</li>
            <li><strong>Hui</strong> - China</li>
            <li><strong>Kye</strong> - Korea</li>
            <li><strong>Paluwagan</strong> - Philippines</li>
            <li><strong>Arisan</strong> - Indonesia</li>
          </ul>

          <h3>Americas</h3>
          <ul>
            <li><strong>Sou Sou</strong> - Caribbean</li>
            <li><strong>Tandas</strong> - Mexico</li>
            <li><strong>Susus</strong> - Guyana</li>
            <li><strong>Juntas</strong> - Colombia</li>
            <li><strong>Partners</strong> - Jamaica</li>
          </ul>

          <h3>Common Challenges Across All Systems</h3>
          <SideBySide
            columns={[
              {
                title: 'Trust and Security Issues',
                points: [
                  'Member default risks',
                  'Organizer fraud potential',
                  'Cash handling vulnerabilities',
                  'Limited legal recourse',
                ],
              },
              {
                title: 'Operational Limitations',
                points: [
                  'Geographic constraints',
                  'Manual record keeping',
                  'Cash sits with one treasurer',
                  'Limited scalability',
                ],
              },
            ]}
          />
        </GuideSection>

        <GuideSection id="blockchain" title="Rules the group cannot quietly change">
          <h3>The rules, written down</h3>
          <CodeBlock>{`// A simplified sketch of the circle rules
struct ROSCACircle {
    members: vector<address>,
    contribution_amount: u64,
    current_round: u64,
    payout_recipient: address,
    contributions_this_round: Table<address, bool>,
    security_deposits: Table<address, u64>
}

public fun make_contribution(
    circle: &mut ROSCACircle,
    payment: Coin<USDC>,
    ctx: &TxContext
) {
    // Verify contribution amount and member status
    // Record contribution automatically
    // Trigger payout when round complete
    // Advance the rotation to the next member
}`}</CodeBlock>

          <h3>Traditional ROSCA Problems</h3>
          <KeyPoints
            columns={3}
            items={[
              { title: 'Trust Vulnerabilities', body: 'Single points of failure, fraud risks' },
              { title: 'Geographic Limitations', body: 'Physical meetings, local membership only' },
              { title: 'Treasurer Risk', body: 'One person physically holds the pooled cash' },
            ]}
          />

          <h3>What changes</h3>
          <KeyPoints
            columns={3}
            items={[
              { title: 'Nobody holds the pot', body: 'No operator function can move a circle’s money' },
              { title: 'Global Accessibility', body: '24/7 availability, cross-border participation' },
              {
                title: 'Automated Escrow',
                body: 'Contributions held in escrow and released on schedule, to the scheduled member only',
              },
            ]}
          />

          <h3>What that gives the circle</h3>
          <KeyPoints
            columns={3}
            items={[
              {
                title: 'Transparency',
                body: 'Every contribution and payout sits on a public record any member can check',
              },
              {
                title: 'Automation',
                body: 'Contribution tracking and payout order run from contract rules, not memory',
              },
              { title: 'Scalability', body: 'No size limits, global membership possible' },
            ]}
          />
        </GuideSection>

        <GuideSection id="implementation" title="Getting started">
          <h3>Platform Features</h3>
          <KeyPoints
            columns={3}
            items={[
              {
                title: 'Multi-Cultural Support',
                body: 'Supporting traditional ROSCA formats from around the world with culturally appropriate features and ceremonies.',
              },
              {
                title: 'Stablecoin Settlement',
                body: 'Contribute in USD-pegged stablecoins so the pot’s value stays predictable across borders.',
              },
              {
                title: 'Global Accessibility',
                body: 'Cross-border participation enabling diaspora communities to maintain connections with home countries.',
              },
            ]}
          />

          <h3>Quick Start Guide</h3>
          <ol>
            <li>Sign in with Google, Facebook or Apple &mdash; no seed phrase</li>
            <li>Agree the contribution amount, member count and rotation order</li>
            <li>Browse available circles or create your own</li>
            <li>Post your security deposit and pay in each cycle</li>
          </ol>

          <ProseAction
            href="/create-circle"
            secondary={{ label: 'Browse Existing Circles', href: '/dashboard' }}
          >
            Create Your Circle
          </ProseAction>
        </GuideSection>
      </LearnGuide>
    </>
  );
}
