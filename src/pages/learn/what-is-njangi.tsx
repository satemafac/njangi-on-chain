import Link from 'next/link';
import { Seo } from '../../components/Seo';
import { article, breadcrumbs, definedTerm } from '../../lib/structured-data';
import { GuideSection, LearnGuide } from '../../components/marketing/LearnGuide';
import {
  Callout,
  Definition,
  Definitions,
  KeyPoints,
  ProseAction,
  SideBySide,
  Steps,
  TermGrid,
} from '../../components/marketing/ProseBlocks';

export default function WhatIsNjangiPage() {
  return (
    <>
      {/* Tuned to the queries this page actually receives. "njangi meaning" is
          229 impressions at 1.7% CTR and "njangi in english" is 36 with zero
          clicks, so the title leads with "meaning" and the description answers
          the question outright rather than describing the article. "njangui" is
          in the description because it is a 47-impression query with no clicks,
          and Google bolds matched terms in the snippet. */}
      <Seo
        title="Njangi Meaning: Cameroon's Savings Circle Explained"
        titleAbsolute
        description="Njangi (n-JAHN-gee), also spelled njangui, is Cameroon's rotating savings circle — in English, a savings club or ROSCA. Each member takes the pot in turn."
        path="/learn/what-is-njangi"
        ogType="article"
        image={{ url: '/og/learn-what-is-njangi.png', alt: 'What is a njangi?' }}
        article={{
          publishedTime: '2025-06-05T00:00:00.000Z',
          modifiedTime: '2026-08-02T00:00:00.000Z',
          authorName: 'Njangi On-Chain',
          section: 'Education',
          tags: ['njangi', 'cameroon', 'rosca', 'rotating savings'],
        }}
        jsonLd={[
          breadcrumbs([
            { name: 'Home', path: '/' },
            { name: 'Learn', path: '/learn' },
            { name: 'What is a Njangi?' },
          ]),
          article({
            headline: "What is a Njangi? Cameroon's rotating savings circle, explained",
            description:
              'Njangi is a Cameroon-originated rotating savings circle in which members contribute a fixed amount on a shared schedule and each receives the pooled amount in turn.',
            path: '/learn/what-is-njangi',
            image: '/og/learn-what-is-njangi.png',
            datePublished: '2025-06-05',
            dateModified: '2026-08-02',
            section: 'Education',
            keywords: ['njangi', 'Cameroon', 'ROSCA', 'rotating savings'],
          }),
          definedTerm({
            name: 'Njangi',
            description:
              'A Cameroon-originated rotating savings circle in which members contribute a fixed amount on a shared schedule and each receives the pooled amount in turn.',
            path: '/learn/what-is-njangi',
            alternateNames: ['Njangui', 'Tontine', 'Esusu'],
            termSetPath: '/learn',
          }),
        ]}
      />

      <LearnGuide
        crumb="What is Njangi"
        title="What is Njangi? Understanding Cameroon’s Revolutionary Savings Circle"
        standfirst={
          <p>
            <strong>Njangi</strong> (pronounced &ldquo;n-JAHN-gee&rdquo;) is a Cameroon-originated
            rotating savings and credit association where community members pool money regularly and
            take turns receiving lump sum payouts. Now revolutionized through a shared record nobody
            can quietly edit, Njangi carries centuries of practice into a form that travels.
          </p>
        }
        actions={{
          primary: { label: 'Start Your Digital Njangi Today', href: '/create-circle' },
          secondary: { label: 'View Dashboard', href: '/dashboard' },
        }}
        toc={[
          { id: 'definition', label: 'What is Njangi?' },
          { id: 'history', label: 'Historical Origins' },
          { id: 'how-it-works', label: 'How It Works' },
          { id: 'getting-started', label: 'Getting Started' },
        ]}
        related={[
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
          {
            href: '/learn/susu',
            title: 'What is a Susu? Caribbean & West African Circles',
            description: 'Susu, sou-sou and Partner — the same circle under three names.',
          },
        ]}
        cta={{
          title: 'Ready to Join the Future of Community Savings?',
          body: 'Start your digital Njangi journey today and connect with trusted communities worldwide with non-custodial coordination and partner-led on/off ramps.',
          primary: { label: 'Start Your Circle', href: '/create-circle' },
          secondary: { label: 'View Dashboard', href: '/dashboard' },
        }}
        share={{ path: '/learn/what-is-njangi', title: "Njangi Meaning: Cameroon's Savings Circle Explained" }}
      >
        <GuideSection id="definition" title="What is Njangi?">
          <p className="lead">
            <strong>Njangi</strong> (pronounced &ldquo;n-JAHN-gee&rdquo;) is a Cameroon-originated
            rotating savings and credit association where a group of trusted individuals contribute
            fixed amounts regularly to a common pool. Each cycle, one member receives the entire
            collected amount, continuing until everyone has received their turn.
          </p>

          {/* Answers the queries that bring people here and then lose
              them. Search Console, 3 months: "njangui" 47 impressions /
              0 clicks, "njangi in english" 36 / 0, "njangui meaning"
              12 / 0 — and "njangi meaning" 229 impressions at 1.7% CTR.
              Before this block the page contained the string "njangui"
              only inside its schema markup, and never used the words
              "pronunciation" or "in English" at all. People were asking a
              question the page never answered in words. */}
          <Definitions>
            <Definition term="Njangi meaning">
              A group savings arrangement in which everyone pays the same amount on the same
              schedule, and each member in turn takes the whole pot. Nobody lends and nobody borrows
              — you get back what you put in, just sooner or later than the others.
            </Definition>
            <Definition term="Njangi in English">
              There is no single English word for it. The closest everyday translation is
              &ldquo;savings circle&rdquo; or &ldquo;savings club&rdquo;; economists call the
              structure a{' '}
              <Link href="/learn/rosca">rotating savings and credit association (ROSCA)</Link>. British
              and American English borrowed no term for it because the practice arrived with the
              communities that already had their own names for it.
            </Definition>
            <Definition term="Pronunciation and spelling">
              Said <strong>n-JAHN-gee</strong>, with the stress on the middle syllable. It is also
              written <strong>njangui</strong>, and occasionally <strong>njange</strong> or{' '}
              <strong>jangi</strong> — all the same word, spelled as different people heard it. In
              francophone parts of Cameroon the same practice is usually called a{' '}
              <Link href="/learn/tontine">tontine</Link>.
            </Definition>
            <Definition term="Where the word comes from">
              Njangi belongs to the Grassfields of the North West and South West regions of Cameroon
              and travelled with Cameroonian English. The practice itself is far older and far wider
              than the word: the{' '}
              <Link href="/learn#glossary">same arrangement runs on every inhabited continent</Link>{' '}
              under names like esusu, susu, chama, stokvel, tanda and chit fund.
            </Definition>
          </Definitions>

          {/* The two figures that used to sit here — a global participant
              count and a share of Cameroonian adults — had no source
              behind them. Unsourced statistics are a liability on a page
              about money, and Google's helpful-content guidance treats
              unverifiable claims as a quality signal against the site.
              Replaced with statements that hold without a number. Where a
              real figure is worth quoting, add it to
              src/content/sourced-facts.ts and render it through
              SourcedStat, which cannot show a number without its
              citation. */}
          <Callout tone="gold" title="Why it endures">
            <ul>
              <li>
                The same rotating structure appears independently on every inhabited continent, under
                dozens of local names
              </li>
              <li>It needs no bank, no credit history, and no paperwork — only a group that knows each other</li>
              <li>
                Economists group these arrangements under the label <strong>ROSCA</strong>: rotating
                savings and credit association
              </li>
            </ul>
          </Callout>

          <h3>Key Characteristics of Njangi</h3>
          <KeyPoints
            items={[
              { title: 'Community-based', body: 'Built on existing social relationships and trust' },
              { title: 'No interest charges', body: 'Members help each other without additional fees' },
              { title: 'Rotating payouts', body: 'Fair distribution ensuring everyone benefits' },
              { title: 'Cultural significance', body: 'Strengthens community bonds and social capital' },
            ]}
          />
        </GuideSection>

        <GuideSection id="history" title="Historical Origins & Cultural Significance">
          <h3>Ancient Roots in West Africa</h3>
          <p>
            Njangi traces its origins to ancient West African financial traditions, with similar
            systems documented for <strong>over 1,000 years</strong>. The practice emerged from the
            fundamental human need for financial cooperation and community support, particularly in
            agricultural societies where seasonal cash flows required collective savings strategies.
          </p>

          <Callout tone="gold" title="Cultural Rituals and Practices">
            <p>Traditional Njangi meetings involve more than financial transactions:</p>
            <ul>
              <li>
                <strong>Greetings and ceremonies</strong>: Members exchange traditional greetings and
                share kola nuts
              </li>
              <li>
                <strong>Community updates</strong>: Meetings serve as social gatherings for news and
                support
              </li>
              <li>
                <strong>Collective decision-making</strong>: Group consensus guides important decisions
              </li>
              <li>
                <strong>Celebration rituals</strong>: Payout recipients often treat the group to food
                or drinks
              </li>
            </ul>
          </Callout>

          <h3>Evolution Across Africa</h3>
          <p>From Cameroon, similar systems spread throughout Africa under different names:</p>
          <TermGrid
            items={[
              { title: 'Djanggis', body: 'Alternate Cameroon term' },
              { title: 'Tontines', body: 'French-speaking Africa' },
              { title: 'Susus', body: 'Ghana, Sierra Leone' },
              { title: 'Stokvels', body: 'South Africa' },
            ]}
          />
        </GuideSection>

        <GuideSection id="how-it-works" title="How Njangi works: the notebook and the alternative">
          <h3>Traditional Njangi Process</h3>
          <Steps
            items={[
              { title: 'Group Formation', body: '8-20 trusted community members agree to participate' },
              { title: 'Setting Terms', body: 'Fixed contribution amount and meeting schedule' },
              { title: 'Regular Meetings', body: 'Members gather to contribute and receive payouts' },
              { title: 'Rotation Completion', body: 'Process continues until all members receive payouts' },
            ]}
          />

          <h3>What changes here</h3>
          <Callout tone="gold" title="Rules that hold">
            <ul>
              <li>Contribution tracking happens automatically on-chain</li>
              <li>Payout distribution follows predetermined rules</li>
              <li>No treasurer holds the pooled cash</li>
              <li>Complete transaction history immutably recorded</li>
            </ul>
          </Callout>

          <h3>Traditional Challenges Solved</h3>
          <KeyPoints
            columns={3}
            items={[
              { title: 'Trust vulnerabilities', body: 'Rules enforced by contract, not by one person' },
              { title: 'Geographic constraints', body: 'Global accessibility' },
              { title: 'Record-keeping issues', body: 'A record no one can quietly edit' },
            ]}
          />
        </GuideSection>

        <GuideSection id="getting-started" title="Getting Started with Digital Njangi">
          <h3>Step-by-Step Onboarding</h3>
          <Steps
            items={[
              {
                title: 'Sign In',
                body: 'Sign in with Google, Facebook or Apple. No seed phrase to write down and no token to buy first.',
              },
              {
                title: 'Join or Start a Circle',
                body: 'Join from the invite link an organiser shares, or start your own. Members are people your group already knows — we do not score anyone.',
              },
              {
                title: 'Active Participation',
                body: 'Pay in each round yourself (nothing is taken automatically), and collect the whole pot when your turn comes.',
              },
            ]}
          />

          <h3>Requirements</h3>
          <SideBySide
            columns={[
              {
                title: 'Technical',
                points: [
                  'A web browser on a phone or computer',
                  'A Google, Facebook or Apple account to sign in',
                  'No identity documents — we do not ask for your ID',
                ],
              },
              {
                title: 'Financial',
                points: [
                  'Security deposit (at least half of one contribution)',
                  'Monthly contribution amount',
                  'Small amount of SUI tokens for fees',
                  'Emergency fund for penalties',
                ],
              },
            ]}
          />

          <ProseAction href="/create-circle">Start Your Digital Njangi Journey</ProseAction>
        </GuideSection>
      </LearnGuide>
    </>
  );
}
