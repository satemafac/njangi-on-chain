import Link from 'next/link';
import { useState } from 'react';
import { Seo } from '../../components/Seo';
import { article, breadcrumbs, definedTerm } from '../../lib/structured-data';
import { MarketingShell } from '../../components/marketing/ArticleLayout';
import { SourcedStat, PlainStat } from '../../components/marketing/SourcedStat';
import { REMITTANCES_LAC, REMITTANCE_COST_GLOBAL } from '../../content/sourced-facts';

export default function SouSouCryptoPage() {
  const [activeSection, setActiveSection] = useState('overview');

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

      <MarketingShell>
        {/* Navigation */}
        <nav className="bg-ink-surface border-b">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex items-center space-x-2 py-3 text-sm text-sand">
              <Link href="/" className="hover:text-gold transition-colors">Home</Link>
              <span>/</span>
              <Link href="/learn" className="hover:text-gold transition-colors">Learn</Link>
              <span>/</span>
              <span className="text-cream font-medium">Sou Sou Crypto</span>
            </div>
          </div>
        </nav>

        {/* Hero */}
        <section className="bg-gradient-to-r from-ink-surface to-ink-deep text-cream py-20">
          <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
            <h1 className="text-4xl md:text-5xl font-bold mb-6">
              What is a Susu? Caribbean and West African Savings Circles
            </h1>
            <p className="text-xl md:text-2xl mb-8 text-cream-muted">
              Explore how traditional Caribbean <strong>Sou Sou</strong>, Jamaican <strong>Partner</strong>, and 
              West African <strong>Susu</strong> savings circles are being transformed through cryptocurrency 
              and smart contract technology, connecting diaspora communities worldwide.
            </p>
            <div className="flex flex-col sm:flex-row gap-4">
              <Link 
                href="/create-circle" 
                className="bg-ink-surface text-gold px-8 py-3 rounded-lg font-semibold hover:bg-ink-surface transition-colors text-center"
              >
                Start Your Digital Sou Sou →
              </Link>
              <Link 
                href="/dashboard" 
                className="border border-gold-deep/55 text-cream px-8 py-3 rounded-lg font-semibold hover:bg-ink-surface hover:text-gold transition-colors text-center"
              >
                Explore Platform
              </Link>
            </div>
          </div>
        </section>

        {/* Sourced figures only. The block this replaced asserted a diaspora
            population, a share of circles led by women, and a Caribbean
            remittance total, none of them sourced. The regional total below is
            for Latin America and the Caribbean together, which is how the World
            Bank reports it — deliberately not narrowed to the Caribbean alone,
            since that would invent a breakdown the source does not give. */}
        <section className="bg-ink-surface border-b border-ink-border">
          <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-8">
              <SourcedStat fact={REMITTANCES_LAC} />
              <SourcedStat fact={REMITTANCE_COST_GLOBAL} />
              <PlainStat
                value="One tradition"
                label="Susu, sou-sou and Partner name the same practice across the Caribbean and West Africa"
              />
            </div>
          </div>
        </section>

        {/* Navigation Tabs */}
        <section className="bg-ink-surface border-b">
          <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
            <div className="flex flex-wrap gap-4">
              {[
                { id: 'overview', label: 'What is Sou Sou?' },
                { id: 'regional', label: 'Regional Variations' },
                { id: 'blockchain', label: 'Crypto Integration' },
                { id: 'diaspora', label: 'Diaspora Communities' }
              ].map((tab) => (
                <button 
                  key={tab.id}
                  onClick={() => setActiveSection(tab.id)}
                  className={`px-4 py-2 rounded-lg transition-colors ${
                    activeSection === tab.id 
                      ? 'bg-gold/[0.07] text-gold' 
                      : 'hover:bg-ink-surface'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>
        </section>

        {/* Main Content */}
        <main className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
          <div
            id="overview"
            role="tabpanel"
            className={activeSection === 'overview' ? '' : 'hidden'}
          >
            <section className="space-y-8">
              <div className="bg-ink-surface rounded-lg shadow-[0_20px_60px_-30px_rgba(0,0,0,0.85)] p-8">
                <h2 className="text-3xl font-bold mb-6 text-cream">What is Sou Sou?</h2>
                <p className="text-lg text-sand mb-6">
                  <strong>Sou Sou</strong> (also spelled &ldquo;Susu&rdquo;) is a Caribbean and West African 
                  community savings practice where trusted groups of people contribute fixed amounts regularly 
                  to a collective fund. Members take turns receiving the full amount, creating a rotating 
                  credit system that enables access to larger sums without traditional banking.
                </p>
                
                <div className="grid md:grid-cols-2 gap-8 mb-8">
                  <div className="bg-gold/[0.07] p-6 rounded-lg">
                    <h3 className="text-xl font-semibold text-gold mb-4">Cultural Heritage</h3>
                    <ul className="space-y-2 text-gold">
                      <li>• Brought to Caribbean by enslaved Africans</li>
                      <li>• Maintained through oral tradition</li>
                      <li>• Cornerstone of community resilience</li>
                      <li>• Informal financial institution for generations</li>
                      <li>• Gender-inclusive economic empowerment</li>
                    </ul>
                  </div>
                  
                  <div className="bg-gold/[0.07] p-6 rounded-lg">
                    <h3 className="text-xl font-semibold text-gold mb-4">Modern Importance</h3>
                    <ul className="space-y-2 text-gold">
                      <li>• Bridge for unbanked populations</li>
                      <li>• Connects diaspora to homeland</li>
                      <li>• Enables microenterprise development</li>
                      <li>• Emergency financial support network</li>
                      <li>• Preserves cultural identity abroad</li>
                    </ul>
                  </div>
                </div>

                <div className="bg-gold/[0.07] border border-gold/45 rounded-lg p-6">
                  <h3 className="text-lg font-semibold text-gold mb-3">Traditional Sou Sou Structure</h3>
                  <div className="grid md:grid-cols-4 gap-4 text-sm text-gold">
                    <div className="text-center">
                      <div className="bg-gold text-cream rounded-full w-8 h-8 flex items-center justify-center mx-auto mb-2 font-bold">1</div>
                      <div className="font-medium">Community Formation</div>
                      <div className="text-xs">Trusted friends and family join</div>
                    </div>
                    <div className="text-center">
                      <div className="bg-gold text-cream rounded-full w-8 h-8 flex items-center justify-center mx-auto mb-2 font-bold">2</div>
                      <div className="font-medium">Regular Contributions</div>
                      <div className="text-xs">Weekly or monthly fixed amounts</div>
                    </div>
                    <div className="text-center">
                      <div className="bg-gold text-cream rounded-full w-8 h-8 flex items-center justify-center mx-auto mb-2 font-bold">3</div>
                      <div className="font-medium">Rotating &ldquo;Hand&rdquo;</div>
                      <div className="text-xs">Members receive full amount in turn</div>
                    </div>
                    <div className="text-center">
                      <div className="bg-gold text-cream rounded-full w-8 h-8 flex items-center justify-center mx-auto mb-2 font-bold">4</div>
                      <div className="font-medium">Cycle Renewal</div>
                      <div className="text-xs">Process repeats until all members served</div>
                    </div>
                  </div>
                </div>
              </div>
            </section>
          </div>

          <div
            id="regional"
            role="tabpanel"
            className={activeSection === 'regional' ? '' : 'hidden'}
          >
            <section className="space-y-8">
              <div className="bg-ink-surface rounded-lg shadow-[0_20px_60px_-30px_rgba(0,0,0,0.85)] p-8">
                <h2 className="text-3xl font-bold mb-6 text-cream">Regional Variations Across the Caribbean & West Africa</h2>
                
                <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6 mb-8">
                  <div className="border border-ink-border rounded-lg p-4">
                    <h3 className="font-semibold text-lg mb-2 text-gold">Greater Antilles</h3>
                    <ul className="text-sm space-y-1">
                      <li><strong>Jamaica</strong> - Partner/Pardner</li>
                      <li><strong>Haiti</strong> - Sol/Association</li>
                      <li><strong>Dominican Republic</strong> - San/Caja</li>
                      <li><strong>Puerto Rico</strong> - Vaca</li>
                      <li><strong>Cuba</strong> - Vaca (Historical)</li>
                    </ul>
                  </div>
                  
                  <div className="border border-ink-border rounded-lg p-4">
                    <h3 className="font-semibold text-lg mb-2 text-gold">Lesser Antilles</h3>
                    <ul className="text-sm space-y-1">
                      <li><strong>Trinidad & Tobago</strong> - Sou Sou</li>
                      <li><strong>Barbados</strong> - Meeting Turn</li>
                      <li><strong>Grenada</strong> - Box Money</li>
                      <li><strong>St. Lucia</strong> - Cooperative</li>
                      <li><strong>Dominica</strong> - Sou Sou Circle</li>
                    </ul>
                  </div>
                  
                  <div className="border border-ink-border rounded-lg p-4">
                    <h3 className="font-semibold text-lg mb-2 text-gold">West Africa Origins</h3>
                    <ul className="text-sm space-y-1">
                      <li><strong>Ghana</strong> - Susu</li>
                      <li><strong>Sierra Leone</strong> - Osusu</li>
                      <li><strong>Nigeria</strong> - Esusu (Yoruba)</li>
                      <li><strong>Gambia</strong> - Osusu</li>
                      <li><strong>Liberia</strong> - Susu (Kru)</li>
                    </ul>
                  </div>
                </div>

                <div className="bg-gold/[0.07] p-6 rounded-lg mb-6">
                  <h3 className="text-lg font-semibold text-gold mb-3">Unique Caribbean Adaptations</h3>
                  <div className="grid md:grid-cols-2 gap-4 text-sm text-gold">
                    <div>
                      <h4 className="font-medium">Social Elements</h4>
                      <ul className="mt-2 space-y-1">
                        <li>• Monthly &ldquo;cook-up&rdquo; celebration meals</li>
                        <li>• Integration with church communities</li>
                        <li>• Seasonal agricultural timing</li>
                        <li>• Hurricane emergency protocols</li>
                      </ul>
                    </div>
                    <div>
                      <h4 className="font-medium">Economic Features</h4>
                      <ul className="mt-2 space-y-1">
                        <li>• Tourism worker seasonal adaptations</li>
                        <li>• Remittance integration for families</li>
                        <li>• Small business funding networks</li>
                        <li>• Education expense sharing</li>
                      </ul>
                    </div>
                  </div>
                </div>

                <div className="bg-gold/[0.07] p-6 rounded-lg">
                  <h3 className="text-lg font-semibold text-gold mb-3">Modern Challenges & Adaptations</h3>
                  <div className="grid md:grid-cols-2 gap-4 text-sm text-gold">
                    <div>
                      <h4 className="font-medium text-gold">Traditional Challenges</h4>
                      <ul className="mt-2 space-y-1">
                        <li>• Geographic dispersion of families</li>
                        <li>• Currency exchange complications</li>
                        <li>• Trust issues with new members</li>
                        <li>• Limited emergency protections</li>
                      </ul>
                    </div>
                    <div>
                      <h4 className="font-medium text-gold">Digital Solutions</h4>
                      <ul className="mt-2 space-y-1">
                        <li>• Virtual meetings and ceremonies</li>
                        <li>• Multi-currency support</li>
                        <li>• Smart contract automation</li>
                        <li>• Insurance and security features</li>
                      </ul>
                    </div>
                  </div>
                </div>
              </div>
            </section>
          </div>

          <div
            id="blockchain"
            role="tabpanel"
            className={activeSection === 'blockchain' ? '' : 'hidden'}
          >
            <section className="space-y-8">
              <div className="bg-ink-surface rounded-lg shadow-[0_20px_60px_-30px_rgba(0,0,0,0.85)] p-8">
                <h2 className="text-3xl font-bold mb-6 text-cream">Cryptocurrency Integration & Smart Contracts</h2>
                
                <div className="mb-8">
                  <h3 className="text-2xl font-bold mb-4">Smart Contract Implementation</h3>
                  <div className="bg-ink-surface p-4 rounded-lg font-mono text-sm overflow-x-auto">
                    <pre>{`// Caribbean Sou Sou Smart Contract
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
}`}</pre>
                  </div>
                </div>

                <div className="grid md:grid-cols-2 gap-8 mb-8">
                  <div>
                    <h3 className="text-xl font-bold mb-4 text-gold">Traditional Limitations</h3>
                    <div className="space-y-3">
                      <div className="flex items-start space-x-3">
                        <div className="w-2 h-2 bg-gold rounded-full mt-2"></div>
                        <div>
                          <h4 className="font-semibold text-cream">Geographic Barriers</h4>
                          <p className="text-sm text-sand">Physical meetings, local-only membership</p>
                        </div>
                      </div>
                      <div className="flex items-start space-x-3">
                        <div className="w-2 h-2 bg-gold rounded-full mt-2"></div>
                        <div>
                          <h4 className="font-semibold text-cream">Currency Exchange</h4>
                          <p className="text-sm text-sand">Complex remittance fees and delays</p>
                        </div>
                      </div>
                      <div className="flex items-start space-x-3">
                        <div className="w-2 h-2 bg-gold rounded-full mt-2"></div>
                        <div>
                          <h4 className="font-semibold text-cream">Trust Dependencies</h4>
                          <p className="text-sm text-sand">Single coordinator risk, fraud potential</p>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div>
                    <h3 className="text-xl font-bold mb-4 text-gold">Blockchain Advantages</h3>
                    <div className="space-y-3">
                      <div className="flex items-start space-x-3">
                        <div className="w-2 h-2 bg-gold rounded-full mt-2"></div>
                        <div>
                          <h4 className="font-semibold text-cream">Global Accessibility</h4>
                          <p className="text-sm text-sand">24/7 participation from anywhere</p>
                        </div>
                      </div>
                      <div className="flex items-start space-x-3">
                        <div className="w-2 h-2 bg-gold rounded-full mt-2"></div>
                        <div>
                          <h4 className="font-semibold text-cream">Instant Settlements</h4>
                          <p className="text-sm text-sand">Immediate transfers, minimal fees</p>
                        </div>
                      </div>
                      <div className="flex items-start space-x-3">
                        <div className="w-2 h-2 bg-gold rounded-full mt-2"></div>
                        <div>
                          <h4 className="font-semibold text-cream">Automated Trust</h4>
                          <p className="text-sm text-sand">Smart contracts ensure fairness</p>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="bg-gold/[0.07] p-6 rounded-lg">
                  <h3 className="text-lg font-semibold text-gold mb-3">Blockchain Features for Caribbean Communities</h3>
                  <div className="grid md:grid-cols-3 gap-4 text-sm text-gold">
                    <div>
                      <h4 className="font-medium">Multi-Currency Support</h4>
                      <p>USDC, Caribbean dollars, and cryptocurrencies</p>
                    </div>
                    <div>
                      <h4 className="font-medium">Virtual Ceremonies</h4>
                      <p>Online cultural celebrations and community meetings</p>
                    </div>
                    <div>
                      <h4 className="font-medium">Automated Escrow</h4>
                      <p>Smart contracts hold and release the pot on schedule</p>
                    </div>
                  </div>
                </div>
              </div>
            </section>
          </div>

          <div
            id="diaspora"
            role="tabpanel"
            className={activeSection === 'diaspora' ? '' : 'hidden'}
          >
            <section className="space-y-8">
              <div className="bg-ink-surface rounded-lg shadow-[0_20px_60px_-30px_rgba(0,0,0,0.85)] p-8">
                <h2 className="text-3xl font-bold mb-6 text-cream">Connecting Caribbean Diaspora Communities</h2>
                
                <div className="grid md:grid-cols-2 gap-8 mb-8">
                  <div>
                    <h3 className="text-xl font-bold mb-4">Global Caribbean Diaspora</h3>
                    <div className="space-y-4">
                      <div className="border border-ink-border rounded-lg p-4">
                        <h4 className="font-semibold text-gold mb-2">North America</h4>
                        <ul className="text-sm text-sand space-y-1">
                          <li>• Long-established communities in New York, Florida and California</li>
                          <li>• Toronto and Montreal in Canada</li>
                          <li>• Dense remittance corridors back to the islands</li>
                        </ul>
                      </div>
                      <div className="border border-ink-border rounded-lg p-4">
                        <h4 className="font-semibold text-gold mb-2">United Kingdom</h4>
                        <ul className="text-sm text-sand space-y-1">
                          <li>• Caribbean-heritage communities since the Windrush generation</li>
                          <li>• Established community institutions</li>
                          <li>• Pardna kept going alongside formal banking</li>
                        </ul>
                      </div>
                      <div className="border border-ink-border rounded-lg p-4">
                        <h4 className="font-semibold text-gold mb-2">Other Regions</h4>
                        <ul className="text-sm text-sand space-y-1">
                          <li>• Netherlands (Surinamese communities)</li>
                          <li>• France (Martinique/Guadeloupe diaspora)</li>
                          <li>• Other Caribbean islands (migration)</li>
                        </ul>
                      </div>
                    </div>
                  </div>

                  <div>
                    <h3 className="text-xl font-bold mb-4">Digital Platform Benefits</h3>
                    <div className="bg-ink-deep p-6 rounded-lg space-y-4">
                      <div>
                        <h4 className="font-semibold text-cream">Cultural Connection</h4>
                        <p className="text-sm text-sand mt-1">
                          Virtual meetups preserving Caribbean traditions and language, 
                          enabling cultural transmission to new generations.
                        </p>
                      </div>
                      <div>
                        <h4 className="font-semibold text-cream">Economic Empowerment</h4>
                        <p className="text-sm text-sand mt-1">
                          Pooled savings for education, business investment, property 
                          purchase, and family support across borders.
                        </p>
                      </div>
                      <div>
                        <h4 className="font-semibold text-cream">Emergency Support</h4>
                        <p className="text-sm text-sand mt-1">
                          Rapid response fund for natural disasters, family emergencies, 
                          and unexpected financial hardships.
                        </p>
                      </div>
                    </div>

                    <div className="mt-6 space-y-3">
                      <Link 
                        href="/create-circle"
                        className="w-full bg-gold text-cream py-3 px-6 rounded-lg font-semibold hover:bg-gold transition-colors flex items-center justify-center"
                      >
                        Join Diaspora Network
                      </Link>
                      <Link 
                        href="/dashboard"
                        className="w-full border border-gold/45 text-gold py-3 px-6 rounded-lg font-semibold hover:bg-gold/[0.07] transition-colors flex items-center justify-center"
                      >
                        Find Your Community
                      </Link>
                    </div>
                  </div>
                </div>

                <div className="bg-gold/[0.07] p-6 rounded-lg">
                  <h3 className="text-lg font-semibold text-gold mb-3">Success Stories & Use Cases</h3>
                  <div className="grid md:grid-cols-2 gap-4 text-sm text-gold">
                    <div>
                      <h4 className="font-medium">Family Support</h4>
                      <ul className="mt-2 space-y-1">
                        <li>• Grandparents&rsquo; medical expenses</li>
                        <li>• Children&rsquo;s university tuition</li>
                        <li>• Hurricane reconstruction funds</li>
                        <li>• Wedding and celebration costs</li>
                      </ul>
                    </div>
                    <div>
                      <h4 className="font-medium">Business Development</h4>
                      <ul className="mt-2 space-y-1">
                        <li>• Caribbean restaurant startups</li>
                        <li>• Tourism and hospitality ventures</li>
                        <li>• Import/export businesses</li>
                        <li>• Real estate investments</li>
                      </ul>
                    </div>
                  </div>
                </div>
              </div>
            </section>
          </div>

          {/* Related Content Links */}
          <section className="bg-ink-surface rounded-lg shadow-[0_20px_60px_-30px_rgba(0,0,0,0.85)] p-8 mt-12">
            <h2 className="text-2xl font-bold mb-6 text-cream">Related Content</h2>
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
              <Link href="/learn/what-is-njangi" className="group">
                <div className="border border-ink-border rounded-lg p-4 hover:border-gold/45 hover:shadow-[0_14px_40px_-24px_rgba(0,0,0,0.8)] transition-all">
                  <h3 className="font-semibold text-gold group-hover:text-gold mb-2">
                    What is Njangi? Cameroon&rsquo;s Savings Circle
                  </h3>
                  <p className="text-sm text-sand">
                    Learn about Cameroon&rsquo;s traditional Njangi system and its blockchain transformation.
                  </p>
                </div>
              </Link>
              
              <Link href="/learn/rosca" className="group">
                <div className="border border-ink-border rounded-lg p-4 hover:border-gold/45 hover:shadow-[0_14px_40px_-24px_rgba(0,0,0,0.8)] transition-all">
                  <h3 className="font-semibold text-gold group-hover:text-gold mb-2">
                    Blockchain ROSCA: The Future of Community Savings
                  </h3>
                  <p className="text-sm text-sand">
                    Discover how blockchain technology revolutionizes traditional ROSCAs worldwide.
                  </p>
                </div>
              </Link>
              
              <Link href="/learn/tontine" className="group">
                <div className="border border-ink-border rounded-lg p-4 hover:border-gold/45 hover:shadow-[0_14px_40px_-24px_rgba(0,0,0,0.8)] transition-all">
                  <h3 className="font-semibold text-gold group-hover:text-gold mb-2">
                    Tontine Blockchain: African Finance Revolution
                  </h3>
                  <p className="text-sm text-sand">
                    Explore how French African tontine traditions meet modern blockchain technology.
                  </p>
                </div>
              </Link>
            </div>
          </section>

          {/* CTA Section */}
          <section className="bg-gradient-to-r from-ink-surface to-ink-deep rounded-lg text-cream p-8 mt-12 text-center">
            <h2 className="text-2xl font-bold mb-4">Ready to Join the Caribbean Savings Revolution?</h2>
            <p className="text-cream-muted mb-6">
              Connect with Caribbean and West African diaspora communities worldwide through 
              secure, transparent digital Sou Sou circles powered by blockchain technology.
            </p>
            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <Link 
                href="/create-circle"
                className="bg-ink-surface text-gold px-8 py-3 rounded-lg font-semibold hover:bg-ink-surface transition-colors"
              >
                Start Your Sou Sou
              </Link>
              <Link 
                href="/dashboard"
                className="border border-gold-deep/55 text-cream px-8 py-3 rounded-lg font-semibold hover:bg-ink-surface hover:text-gold transition-colors"
              >
                Find Your Circle
              </Link>
            </div>
          </section>
        </main>

        {/* Footer */}
        <footer className="bg-ink-surface mt-16">
          <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
            <p className="text-sm text-sand text-center">
              <strong>Disclaimer:</strong> This content is for educational purposes only and does not constitute financial advice. 
              Cryptocurrency investments carry risks. Always consult with qualified financial advisors before making investment decisions.
            </p>
          </div>
        </footer>
      </MarketingShell>
    </>
  );
} 