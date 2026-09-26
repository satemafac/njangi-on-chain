import { Seo } from '../../components/Seo';
import { article, breadcrumbs, definedTerm } from '../../lib/structured-data';
import { GuideSection, LearnGuide } from '../../components/marketing/LearnGuide';
import { CodeBlock, KeyPoints, ProseAction, SideBySide, Steps } from '../../components/marketing/ProseBlocks';
import { SourcedStat, PlainStat } from '../../components/marketing/SourcedStat';
import { REMITTANCES_LAC, REMITTANCE_COST_GLOBAL } from '../../content/sourced-facts';

export default function SouSouCryptoPage() {
  return (
    <>
      <Seo
        title="What is a Susu? Caribbean & West African Circles"
        titleAbsolute
        description="Susu, sou-sou and Partner are the Caribbean and West African names for a rotating savings circle: everyone pays in, and each member takes the pot in turn."
        path="/learn/susu"
        ogType="article"
        image={{ url: '/og/learn-susu.png', alt: 'What is a susu?' }}
        article={{
          publishedTime: '2025-06-05T00:00:00.000Z',
          modifiedTime: '2026-08-02T00:00:00.000Z',
          authorName: 'Njangi On-Chain',
          section: 'Education',
          tags: ['susu', 'sou-sou', 'caribbean', 'west africa'],
        }}
        jsonLd={[
          breadcrumbs([
            { name: 'Home', path: '/' },
            { name: 'Learn', path: '/learn' },
            { name: 'What is a Susu?' },
          ]),
          article({
            headline: 'What is a susu? Caribbean and West African rotating savings circles',
            description:
              'Susu, sou-sou and Partner are Caribbean and West African names for a rotating savings circle in which members contribute on a shared schedule and take the pot in turn.',
            path: '/learn/susu',
            image: '/og/learn-susu.png',
            datePublished: '2025-06-05',
            dateModified: '2026-08-02',
            section: 'Education',
            keywords: ['susu', 'sou-sou', 'Partner', 'Caribbean', 'West Africa'],
          }),
          definedTerm({
            name: 'Susu',
            description:
              'The Caribbean and West African name for a rotating savings circle in which members contribute on a shared schedule and each takes the pooled amount in turn.',
            path: '/learn/susu',
            alternateNames: ['Sou-sou', 'Sou Sou', 'Partner', 'Pardna', 'Esusu'],
            termSetPath: '/learn',
          }),
        ]}
      />

      <LearnGuide
        crumb="Susu"
        title="What is a Susu? Caribbean and West African Savings Circles"
        standfirst={
          <p>
            Explore how traditional Caribbean <strong>Sou Sou</strong>, Jamaican <strong>Partner</strong>, and{' '}
            <strong>Susu</strong>, sou-sou and Partner are the Caribbean and West African names for one
            practice: everyone pays in, and each member takes the pot in turn.
          </p>
        }
        actions={{
          primary: { label: 'Start Your Digital Sou Sou', href: '/create-circle' },
          secondary: { label: 'Explore Platform', href: '/dashboard' },
        }}
        figures={
          <>
            {/* Sourced figures only. The block this replaced asserted a diaspora
                population, a share of circles led by women, and a Caribbean
                remittance total, none of them sourced. The regional total below is
                for Latin America and the Caribbean together, which is how the World
                Bank reports it — deliberately not narrowed to the Caribbean alone,
                since that would invent a breakdown the source does not give. */}
            <SourcedStat fact={REMITTANCES_LAC} />
            <SourcedStat fact={REMITTANCE_COST_GLOBAL} />
            <PlainStat
              value="One tradition"
              label="Susu, sou-sou and Partner name the same practice across the Caribbean and West Africa"
            />
          </>
        }
        toc={[
          { id: 'overview', label: 'What is Sou Sou?' },
          { id: 'regional', label: 'Regional Variations' },
          { id: 'blockchain', label: 'How It Works Here' },
          { id: 'diaspora', label: 'Diaspora Communities' },
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
            href: '/learn/tontine',
            title: 'What is a Tontine? African Savings Circles',
            description: 'The rotating savings circle across West and Central Africa.',
          },
        ]}
        cta={{
          title: 'Ready to Join the Caribbean Savings Revolution?',
          body: 'Connect with Caribbean and West African diaspora communities worldwide through sou sou circles where nobody holds the pot and every member can check the record.',
          primary: { label: 'Start Your Sou Sou', href: '/create-circle' },
          secondary: { label: 'Find Your Circle', href: '/dashboard' },
        }}
      >
        <GuideSection id="overview" title="What is Sou Sou?">
          <p className="lead">
            <strong>Sou Sou</strong> (also spelled &ldquo;Susu&rdquo;) is a Caribbean and West African
            community savings practice where trusted groups of people contribute fixed amounts regularly
            to a collective fund. Members take turns receiving the full amount, creating a rotating
            credit system that enables access to larger sums without traditional banking.
          </p>

          <SideBySide
            columns={[
              {
                title: 'Cultural Heritage',
                points: [
                  'Brought to Caribbean by enslaved Africans',
                  'Maintained through oral tradition',
                  'Cornerstone of community resilience',
                  'Informal financial institution for generations',
                  'Gender-inclusive economic empowerment',
                ],
              },
              {
                title: 'Modern Importance',
                points: [
                  'Bridge for unbanked populations',
                  'Connects diaspora to homeland',
                  'Enables microenterprise development',
                  'Emergency financial support network',
                  'Preserves cultural identity abroad',
                ],
              },
            ]}
          />

          <h3>Traditional Sou Sou Structure</h3>
          <Steps
            items={[
              { title: 'Community Formation', body: 'Trusted friends and family join' },
              { title: 'Regular Contributions', body: 'Weekly or monthly fixed amounts' },
              { title: 'Rotating “Hand”', body: 'Members receive full amount in turn' },
              { title: 'Cycle Renewal', body: 'Process repeats until all members served' },
            ]}
          />
        </GuideSection>

        <GuideSection id="regional" title="Regional Variations Across the Caribbean & West Africa">
          <SideBySide
            columns={[
              {
                title: 'Greater Antilles',
                points: [
                  <><strong>Jamaica</strong> - Partner/Pardner</>,
                  <><strong>Haiti</strong> - Sol/Association</>,
                  <><strong>Dominican Republic</strong> - San/Caja</>,
                  <><strong>Puerto Rico</strong> - Vaca</>,
                  <><strong>Cuba</strong> - Vaca (Historical)</>,
                ],
              },
              {
                title: 'Lesser Antilles',
                points: [
                  <><strong>Trinidad & Tobago</strong> - Sou Sou</>,
                  <><strong>Barbados</strong> - Meeting Turn</>,
                  <><strong>Grenada</strong> - Box Money</>,
                  <><strong>St. Lucia</strong> - Cooperative</>,
                  <><strong>Dominica</strong> - Sou Sou Circle</>,
                ],
              },
              {
                title: 'West Africa Origins',
                points: [
                  <><strong>Ghana</strong> - Susu</>,
                  <><strong>Sierra Leone</strong> - Osusu</>,
                  <><strong>Nigeria</strong> - Esusu (Yoruba)</>,
                  <><strong>Gambia</strong> - Osusu</>,
                  <><strong>Liberia</strong> - Susu (Kru)</>,
                ],
              },
            ]}
          />

          <h3>Unique Caribbean Adaptations</h3>
          <SideBySide
            columns={[
              {
                title: 'Social Elements',
                points: [
                  'Monthly “cook-up” celebration meals',
                  'Integration with church communities',
                  'Seasonal agricultural timing',
                  'Hurricane emergency protocols',
                ],
              },
              {
                title: 'Economic Features',
                points: [
                  'Tourism worker seasonal adaptations',
                  'Remittance integration for families',
                  'Small business funding networks',
                  'Education expense sharing',
                ],
              },
            ]}
          />

          <h3>Modern Challenges & Adaptations</h3>
          <SideBySide
            columns={[
              {
                title: 'Traditional Challenges',
                points: [
                  'Geographic dispersion of families',
                  'Currency exchange complications',
                  'Trust issues with new members',
                  'Limited emergency protections',
                ],
              },
              {
                title: 'Digital Solutions',
                points: [
                  'Virtual meetings and ceremonies',
                  'Multi-currency support',
                  'The rotation runs to the agreed schedule, not to memory',
                  'Insurance and security features',
                ],
              },
            ]}
          />
        </GuideSection>

        <GuideSection id="blockchain" title="Rules the group cannot quietly change">
          <h3>The rules, written down</h3>
          <CodeBlock>{`// A simplified sketch of the sou sou rules
struct SouSouCircle {
    members: vector<SouSouMember>,
    contribution_amount: Balance<USDC>,
    cultural_activities_fund: Balance<USDC>,
    emergency_reserve: Balance<USDC>,
    current_hand: u64,
    meeting_schedule: u64, // Weekly = 1, Monthly = 4
    diaspora_features: bool
}

public fun make_contribution(
    circle: &mut SouSouCircle,
    payment: Coin<USDC>,
    ctx: &TxContext
) {
    // Verify member status and contribution amount
    // Allocate 90% to main fund, 5% cultural, 5% emergency
    // Check if all members contributed for this round
    // Trigger payout to current "hand" recipient
    // Schedule next cycle and cultural activities
}`}</CodeBlock>

          <h3>Traditional Limitations</h3>
          <KeyPoints
            columns={3}
            items={[
              { title: 'Geographic Barriers', body: 'Physical meetings, local-only membership' },
              { title: 'Currency Exchange', body: 'Complex remittance fees and delays' },
              { title: 'Trust Dependencies', body: 'Single coordinator risk, fraud potential' },
            ]}
          />

          <h3>What changes</h3>
          <KeyPoints
            columns={3}
            items={[
              { title: 'Global Accessibility', body: '24/7 participation from anywhere' },
              { title: 'Instant Settlements', body: 'Immediate transfers, minimal fees' },
              { title: 'Automated Trust', body: 'Contract rules apply equally to every member' },
            ]}
          />

          <h3>Built for circles spread across countries</h3>
          <KeyPoints
            columns={3}
            items={[
              { title: 'Multi-Currency Support', body: 'Digital dollars, so the pot holds its value across borders' },
              { title: 'Virtual Ceremonies', body: 'Online cultural celebrations and community meetings' },
              {
                title: 'Automated Escrow',
                body: 'The pot is held in escrow and released on schedule, to the scheduled member only',
              },
            ]}
          />
        </GuideSection>

        <GuideSection id="diaspora" title="Connecting Caribbean Diaspora Communities">
          <h3>Global Caribbean Diaspora</h3>
          <SideBySide
            columns={[
              {
                title: 'North America',
                points: [
                  'Long-established communities in New York, Florida and California',
                  'Toronto and Montreal in Canada',
                  'Dense remittance corridors back to the islands',
                ],
              },
              {
                title: 'United Kingdom',
                points: [
                  'Caribbean-heritage communities since the Windrush generation',
                  'Established community institutions',
                  'Pardna kept going alongside formal banking',
                ],
              },
              {
                title: 'Other Regions',
                points: [
                  'Netherlands (Surinamese communities)',
                  'France (Martinique/Guadeloupe diaspora)',
                  'Other Caribbean islands (migration)',
                ],
              },
            ]}
          />

          <h3>Digital Platform Benefits</h3>
          <KeyPoints
            columns={3}
            items={[
              {
                title: 'Cultural Connection',
                body: 'Virtual meetups preserving Caribbean traditions and language, enabling cultural transmission to new generations.',
              },
              {
                title: 'Economic Empowerment',
                body: 'Pooled savings for education, business investment, property purchase, and family support across borders.',
              },
              {
                title: 'Emergency Support',
                body: 'Rapid response fund for natural disasters, family emergencies, and unexpected financial hardships.',
              },
            ]}
          />

          <ProseAction href="/create-circle" secondary={{ label: 'Find Your Community', href: '/dashboard' }}>
            Join Diaspora Network
          </ProseAction>

          <h3>Success Stories & Use Cases</h3>
          <SideBySide
            columns={[
              {
                title: 'Family Support',
                points: [
                  'Grandparents’ medical expenses',
                  'Children’s university tuition',
                  'Hurricane reconstruction funds',
                  'Wedding and celebration costs',
                ],
              },
              {
                title: 'Business Development',
                points: [
                  'Caribbean restaurant startups',
                  'Tourism and hospitality ventures',
                  'Import/export businesses',
                  'Real estate investments',
                ],
              },
            ]}
          />
        </GuideSection>
      </LearnGuide>
    </>
  );
}
