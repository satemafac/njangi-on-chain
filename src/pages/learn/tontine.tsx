import { Seo } from '../../components/Seo';
import { article, breadcrumbs, definedTerm } from '../../lib/structured-data';
import { GuideSection, LearnGuide } from '../../components/marketing/LearnGuide';
import { CodeBlock, KeyPoints, ProseAction, SideBySide, Steps } from '../../components/marketing/ProseBlocks';

export default function TontineBlockchainPage() {
  return (
    <>
      <Seo
        title="What is a Tontine? African Savings Circles"
        titleAbsolute
        description="In francophone Africa a tontine is a rotating savings circle: members pay in on a shared schedule and each takes the pot in turn. How it works across West and Central Africa."
        path="/learn/tontine"
        ogType="article"
        image={{ url: '/og/learn-tontine.png', alt: 'What is a tontine?' }}
        article={{
          publishedTime: '2025-06-05T00:00:00.000Z',
          modifiedTime: '2026-08-02T00:00:00.000Z',
          authorName: 'Njangi On-Chain',
          section: 'Education',
          tags: ['tontine', 'west africa', 'central africa', 'rotating savings'],
        }}
        jsonLd={[
          breadcrumbs([
            { name: 'Home', path: '/' },
            { name: 'Learn', path: '/learn' },
            { name: 'What is a Tontine?' },
          ]),
          article({
            headline: 'What is a tontine? Rotating savings circles in francophone Africa',
            description:
              'In francophone Africa a tontine is a rotating savings circle in which members contribute on a shared schedule and each takes the pooled amount in turn.',
            path: '/learn/tontine',
            image: '/og/learn-tontine.png',
            datePublished: '2025-06-05',
            dateModified: '2026-08-02',
            section: 'Education',
            keywords: ['tontine', 'West Africa', 'Central Africa', 'rotating savings'],
          }),
          definedTerm({
            name: 'Tontine',
            description:
              'The francophone African name for a rotating savings circle in which members contribute on a shared schedule and each takes the pooled amount in turn.',
            path: '/learn/tontine',
            alternateNames: ['Njangi', 'Esusu', 'Chilemba'],
            termSetPath: '/learn',
          }),
        ]}
      />

      <LearnGuide
        crumb="Tontine"
        title="What is a Tontine? Rotating Savings Circles in Francophone Africa"
        standfirst={
          <p>
            How the tontine works across West and Central Africa—community savings circles that have
            powered grassroots finance across French-speaking Africa for centuries.
          </p>
        }
        actions={{
          primary: { label: 'Start Your Digital Tontine', href: '/create-circle' },
          secondary: { label: 'Explore Platform', href: '/dashboard' },
        }}
        toc={[
          { id: 'overview', label: 'What is Tontine?' },
          { id: 'regional', label: 'Regional Traditions' },
          { id: 'blockchain', label: 'How It Works Here' },
          { id: 'implementation', label: 'Getting Started' },
        ]}
        related={[
          {
            href: '/learn/what-is-njangi',
            title: 'What is Njangi? Cameroon’s Savings Circle',
            description: 'Cameroon’s savings circle: how it works, and why it has lasted.',
          },
          {
            href: '/learn/rosca',
            title: 'What is a ROSCA? Rotating Savings, Explained',
            description: 'The structure behind njangi, tontine, susu and chit funds.',
          },
          {
            href: '/learn/susu',
            title: 'What is a Susu? Caribbean & West African Circles',
            description: 'Susu, sou-sou and Partner — the same circle under three names.',
          },
        ]}
        cta={{
          title: 'Ready to Join the African Finance Revolution?',
          body: 'Start your digital tontine journey today and connect with African communities worldwide while preserving cultural traditions through transparent, non-custodial coordination.',
          primary: { label: 'Start Your Tontine', href: '/create-circle' },
          secondary: { label: 'Explore Platform', href: '/dashboard' },
        }}
      >
        <GuideSection id="overview" title="What is a Tontine?">
          <p className="lead">
            A <strong>tontine</strong> is a traditional rotating savings and credit association
            prevalent throughout French-speaking Africa, where community members regularly contribute
            fixed amounts to a common fund. Each cycle, one member receives the entire collected
            amount, continuing until all participants have received their payout.
          </p>

          <SideBySide
            columns={[
              {
                title: 'Cultural Significance',
                points: [
                  'Community interdependence',
                  'Collective prosperity benefits entire group',
                  'Social capital building beyond finance',
                  'Cultural preservation in modern contexts',
                ],
              },
              /* This block previously asserted a participant count, an annual sum
                 mobilised, a share of members who are women and a share of
                 businesses funded — four precise-looking figures with no
                 source behind any of them. Tontines are informal by
                 definition and leave no institutional record, so there is
                 no aggregate to cite; the claims below are qualitative and
                 hold without a number. */
              {
                title: 'Why it matters',
                points: [
                  'Reaches people no bank will underwrite',
                  'Turns a small regular income into a usable lump sum',
                  'Often organised and led by women',
                  'A common way to start or restock a small business',
                ],
              },
            ]}
          />

          <h3>Traditional Tontine Process</h3>
          <Steps
            items={[
              { title: 'Group Formation', body: 'Trusted community members join' },
              { title: 'Regular Contributions', body: 'Fixed amounts collected' },
              { title: 'Rotating Payouts', body: 'Members receive full amount' },
              { title: 'Cycle Completion', body: 'Process continues until all paid' },
            ]}
          />
        </GuideSection>

        <GuideSection id="regional" title="Tontine Traditions Across Francophone Africa">
          <h3>West Africa</h3>
          <ul>
            <li><strong>Senegal</strong> - Tontines</li>
            <li><strong>Mali</strong> - Ton & Community Savings</li>
            <li><strong>Burkina Faso</strong> - Tontines</li>
            <li><strong>Côte d&rsquo;Ivoire</strong> - Urban Professional Groups</li>
          </ul>

          <h3>Central Africa</h3>
          <ul>
            <li><strong>Cameroon</strong> - Tontines & Njangis</li>
            <li><strong>CAR</strong> - Community Solidarity</li>
            <li><strong>Gabon</strong> - Associations Tournantes</li>
            <li><strong>Chad</strong> - Cross-border Networks</li>
          </ul>

          <h3>Island Nations</h3>
          <ul>
            <li><strong>Madagascar</strong> - Fihavanana Circles</li>
            <li><strong>Comoros</strong> - Islamic Tontines</li>
            <li><strong>Mauritius</strong> - Multi-cultural Groups</li>
            <li><strong>Seychelles</strong> - Tourism Worker Circles</li>
          </ul>

          <h3>Regional Specializations</h3>
          <SideBySide
            columns={[
              {
                title: 'Professional Tontines',
                points: [
                  'Teacher associations in education sectors',
                  'Market trader networks in urban centers',
                  'Civil servant groups in government',
                  'Transport cooperatives for drivers',
                ],
              },
              {
                title: 'Gender-Specific Adaptations',
                points: [
                  'Women’s tontines for household needs',
                  'Mixed professional neighborhoods',
                  'Youth circles for education funding',
                ],
              },
            ]}
          />
        </GuideSection>

        <GuideSection id="blockchain" title="Rules the group cannot quietly change">
          <h3>Traditional Challenges</h3>
          <KeyPoints
            columns={3}
            items={[
              { title: 'Trust Vulnerabilities', body: 'Single treasurer risk, potential fraud' },
              { title: 'Geographic Constraints', body: 'Physical meetings required, distance barriers' },
              { title: 'Cash Custody Risk', body: 'One treasurer physically holds everyone’s money' },
            ]}
          />

          <h3>What changes</h3>
          <KeyPoints
            columns={3}
            items={[
              { title: 'Trustless Architecture', body: 'No treasurer has to hold the cash' },
              { title: 'Global Accessibility', body: '24/7 availability, cross-border participation' },
              {
                title: 'Automated Escrow',
                body: 'Contributions held in escrow and released on schedule, to the scheduled member only',
              },
            ]}
          />

          <CodeBlock>{`// A simplified sketch of the tontine rules
// Every round gets its own escrow, paid out only to that round's recipient
struct CycleEscrow<phantom T> {
    recipient: address,          // whose turn it is, fixed when the round opens
    members: vector<address>,
    contribution_amount: u64,    // the same exact amount for every member
    contributed: Table<address, bool>,
    balance: Balance<T>,         // the pot
}

public fun contribute<T>(
    escrow: &mut CycleEscrow<T>,
    payment: Coin<T>,
    ctx: &mut TxContext
) {
    // Verify member and amount; one contribution per member per round
    // The full payment goes into the pot; nothing is set aside
}

public fun finalize_to_recipient<T>(
    escrow: &mut CycleEscrow<T>,
    clock: &Clock,
    ctx: &mut TxContext
) {
    // Anyone may call this once the round is fully paid
    // It sends a claim on the entire pot to this round's recipient,
    // and only the recipient can redeem it
}`}</CodeBlock>

          <h3>What that gives the circle</h3>
          <KeyPoints
            columns={3}
            items={[
              { title: 'Enhanced Security', body: 'A shared record that no one member can quietly edit' },
              {
                title: 'Cultural Preservation',
                body: 'The amount, schedule and turn order your group agreed, recorded on-chain where any member can check them',
              },
              { title: 'Diaspora Integration', body: 'Global participation maintaining cultural connections' },
            ]}
          />
        </GuideSection>

        <GuideSection id="implementation" title="Getting Started with Digital Tontines">
          <h3>Step-by-Step Process</h3>
          <Steps
            items={[
              {
                title: 'Financial Setup',
                body: 'Sign in with Google, Facebook or Apple — no seed phrase — and add funds when you are ready.',
              },
              {
                title: 'Invite or Join',
                body: 'Start a tontine and share its invite link, or join one from the link its organiser sends you; the organiser approves each member.',
              },
              {
                title: 'Active Participation',
                body: 'Pay in each round yourself (nothing is taken automatically), and collect the whole pot when your turn comes.',
              },
            ]}
          />

          <h3>Platform Features</h3>
          <KeyPoints
            columns={3}
            items={[
              {
                title: 'Local-Currency Amounts',
                body: 'The organiser can set the amount in Central African CFA francs or another listed currency; the circle settles in USDC or SUI, and the app never holds or converts cash.',
              },
              {
                title: 'Shared Record',
                body: 'Every member can see who has paid this round and whose turn it is.',
              },
              {
                title: 'Stablecoin Settlement',
                body: 'USD-pegged contributions keep the pot’s value steady across borders.',
              },
            ]}
          />

          <ProseAction
            href="/create-circle"
            secondary={{ label: 'View Dashboard', href: '/dashboard' }}
          >
            Create Your Tontine
          </ProseAction>
        </GuideSection>
      </LearnGuide>
    </>
  );
}
