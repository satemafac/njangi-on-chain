import Link from 'next/link';
import { useState } from 'react';
import { Seo } from '../../components/Seo';
import { article, breadcrumbs, definedTerm } from '../../lib/structured-data';
import { MarketingShell } from '../../components/marketing/ArticleLayout';

export default function TontineBlockchainPage() {
  const [activeSection, setActiveSection] = useState('overview');

  return (
    <>
      <Seo
        title="What is a Tontine? African Savings Circles"
        titleAbsolute
        description="In francophone Africa a tontine is a rotating savings circle: members pay in on a shared schedule and each takes the pot in turn. How it works across West and Central Africa."
        path="/learn/tontine-blockchain"
        ogType="article"
        image={{ url: '/og/learn-tontine-blockchain.png', alt: 'What is a tontine?' }}
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
            path: '/learn/tontine-blockchain',
            image: '/og/learn-tontine-blockchain.png',
            datePublished: '2025-06-05',
            dateModified: '2026-08-02',
            section: 'Education',
            keywords: ['tontine', 'West Africa', 'Central Africa', 'rotating savings'],
          }),
          definedTerm({
            name: 'Tontine',
            description:
              'The francophone African name for a rotating savings circle in which members contribute on a shared schedule and each takes the pooled amount in turn.',
            path: '/learn/tontine-blockchain',
            alternateNames: ['Njangi', 'Esusu', 'Chilemba'],
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
              <span className="text-cream font-medium">Tontine Blockchain</span>
            </div>
          </div>
        </nav>

        {/* Hero */}
        <section className="bg-gradient-to-r from-ink-surface to-ink-deep text-cream py-20">
          <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
            <h1 className="text-4xl md:text-5xl font-bold mb-6">
              Tontine Blockchain: Transforming African Community Finance
            </h1>
            <p className="text-xl md:text-2xl mb-8 text-cream-muted">
              Discover how blockchain technology revolutionizes traditional African tontines—community 
              savings circles that have powered grassroots finance across French-speaking Africa for centuries.
            </p>
            <div className="flex flex-col sm:flex-row gap-4">
              <Link 
                href="/create-circle" 
                className="bg-ink-surface text-gold px-8 py-3 rounded-lg font-semibold hover:bg-ink-surface transition-colors text-center"
              >
                Start Your Digital Tontine →
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

        {/* Navigation Tabs */}
        <section className="bg-ink-surface border-b">
          <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
            <div className="flex flex-wrap gap-4">
              {[
                { id: 'overview', label: 'What is Tontine?' },
                { id: 'regional', label: 'Regional Traditions' },
                { id: 'blockchain', label: 'Blockchain Benefits' },
                { id: 'implementation', label: 'Getting Started' }
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
                <h2 className="text-3xl font-bold mb-6 text-cream">What is a Tontine?</h2>
                <p className="text-lg text-sand mb-6">
                  A <strong>tontine</strong> is a traditional rotating savings and credit association prevalent 
                  throughout French-speaking Africa, where community members regularly contribute fixed amounts 
                  to a common fund. Each cycle, one member receives the entire collected amount, continuing 
                  until all participants have received their payout.
                </p>
                
                <div className="grid md:grid-cols-2 gap-8 mb-8">
                  <div className="bg-gold/[0.07] p-6 rounded-lg">
                    <h3 className="text-xl font-semibold text-gold mb-4">Cultural Significance</h3>
                    <ul className="space-y-2 text-gold">
                      <li>• Ubuntu philosophy: Community interdependence</li>
                      <li>• Collective prosperity benefits entire group</li>
                      <li>• Social capital building beyond finance</li>
                      <li>• Cultural preservation in modern contexts</li>
                    </ul>
                  </div>
                  
                  <div className="bg-gold/[0.07] p-6 rounded-lg">
                    <h3 className="text-xl font-semibold text-gold mb-4">Economic Impact</h3>
                    <ul className="space-y-2 text-gold">
                      <li>• Over 100 million Africans participate</li>
                      <li>• $50+ billion mobilized annually</li>
                      <li>• 75% of members are women</li>
                      <li>• 40% of businesses funded through tontines</li>
                    </ul>
                  </div>
                </div>

                <div className="bg-gold/[0.07] border border-gold/45 rounded-lg p-6">
                  <h3 className="text-lg font-semibold text-gold mb-3">Traditional Tontine Process</h3>
                  <div className="grid md:grid-cols-4 gap-4 text-sm text-gold">
                    <div className="text-center">
                      <div className="bg-gold text-cream rounded-full w-8 h-8 flex items-center justify-center mx-auto mb-2 font-bold">1</div>
                      <div className="font-medium">Group Formation</div>
                      <div className="text-xs">Trusted community members join</div>
                    </div>
                    <div className="text-center">
                      <div className="bg-gold text-cream rounded-full w-8 h-8 flex items-center justify-center mx-auto mb-2 font-bold">2</div>
                      <div className="font-medium">Regular Contributions</div>
                      <div className="text-xs">Fixed amounts collected</div>
                    </div>
                    <div className="text-center">
                      <div className="bg-gold text-cream rounded-full w-8 h-8 flex items-center justify-center mx-auto mb-2 font-bold">3</div>
                      <div className="font-medium">Rotating Payouts</div>
                      <div className="text-xs">Members receive full amount</div>
                    </div>
                    <div className="text-center">
                      <div className="bg-gold text-cream rounded-full w-8 h-8 flex items-center justify-center mx-auto mb-2 font-bold">4</div>
                      <div className="font-medium">Cycle Completion</div>
                      <div className="text-xs">Process continues until all paid</div>
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
                <h2 className="text-3xl font-bold mb-6 text-cream">Tontine Traditions Across Francophone Africa</h2>
                
                <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6 mb-8">
                  <div className="border border-ink-border rounded-lg p-4">
                    <h3 className="font-semibold text-lg mb-2 text-gold">West Africa</h3>
                    <ul className="text-sm space-y-1">
                      <li><strong>Senegal</strong> - Tontines & Nawétanes</li>
                      <li><strong>Mali</strong> - Ton & Community Savings</li>
                      <li><strong>Burkina Faso</strong> - Caisses Populaires</li>
                      <li><strong>Côte d&rsquo;Ivoire</strong> - Urban Professional Groups</li>
                    </ul>
                  </div>
                  
                  <div className="border border-ink-border rounded-lg p-4">
                    <h3 className="font-semibold text-lg mb-2 text-gold">Central Africa</h3>
                    <ul className="text-sm space-y-1">
                      <li><strong>Cameroon</strong> - Tontines & Njangis</li>
                      <li><strong>CAR</strong> - Community Solidarity</li>
                      <li><strong>Gabon</strong> - Associations Tournantes</li>
                      <li><strong>Chad</strong> - Cross-border Networks</li>
                    </ul>
                  </div>
                  
                  <div className="border border-ink-border rounded-lg p-4">
                    <h3 className="font-semibold text-lg mb-2 text-gold">Island Nations</h3>
                    <ul className="text-sm space-y-1">
                      <li><strong>Madagascar</strong> - Fihavanana Circles</li>
                      <li><strong>Comoros</strong> - Islamic Tontines</li>
                      <li><strong>Mauritius</strong> - Multi-cultural Groups</li>
                      <li><strong>Seychelles</strong> - Tourism Worker Circles</li>
                    </ul>
                  </div>
                </div>

                <div className="bg-gold/[0.07] p-6 rounded-lg">
                  <h3 className="text-lg font-semibold text-gold mb-3">Regional Specializations</h3>
                  <div className="grid md:grid-cols-2 gap-4 text-sm text-gold">
                    <div>
                      <h4 className="font-medium">Professional Tontines</h4>
                      <ul className="mt-2 space-y-1">
                        <li>• Teacher associations in education sectors</li>
                        <li>• Market trader networks in urban centers</li>
                        <li>• Civil servant groups in government</li>
                        <li>• Transport cooperatives for drivers</li>
                      </ul>
                    </div>
                    <div>
                      <h4 className="font-medium">Gender-Specific Adaptations</h4>
                      <ul className="mt-2 space-y-1">
                        <li>• Women&rsquo;s tontines for household needs</li>
                        <li>• Men&rsquo;s groups for larger investments</li>
                        <li>• Mixed professional neighborhoods</li>
                        <li>• Youth circles for education funding</li>
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
                <h2 className="text-3xl font-bold mb-6 text-cream">Blockchain Technology Revolution</h2>
                
                <div className="grid md:grid-cols-2 gap-8 mb-8">
                  <div>
                    <h3 className="text-xl font-bold mb-4 text-gold">Traditional Challenges</h3>
                    <div className="space-y-3">
                      <div className="flex items-start space-x-3">
                        <div className="w-2 h-2 bg-gold rounded-full mt-2"></div>
                        <div>
                          <h4 className="font-semibold text-cream">Trust Vulnerabilities</h4>
                          <p className="text-sm text-sand">Single treasurer risk, potential fraud</p>
                        </div>
                      </div>
                      <div className="flex items-start space-x-3">
                        <div className="w-2 h-2 bg-gold rounded-full mt-2"></div>
                        <div>
                          <h4 className="font-semibold text-cream">Geographic Constraints</h4>
                          <p className="text-sm text-sand">Physical meetings required, distance barriers</p>
                        </div>
                      </div>
                      <div className="flex items-start space-x-3">
                        <div className="w-2 h-2 bg-gold rounded-full mt-2"></div>
                        <div>
                          <h4 className="font-semibold text-cream">Cash Custody Risk</h4>
                          <p className="text-sm text-sand">One treasurer physically holds everyone&rsquo;s money</p>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div>
                    <h3 className="text-xl font-bold mb-4 text-gold">Blockchain Solutions</h3>
                    <div className="space-y-3">
                      <div className="flex items-start space-x-3">
                        <div className="w-2 h-2 bg-gold rounded-full mt-2"></div>
                        <div>
                          <h4 className="font-semibold text-cream">Trustless Architecture</h4>
                          <p className="text-sm text-sand">Smart contracts eliminate intermediaries</p>
                        </div>
                      </div>
                      <div className="flex items-start space-x-3">
                        <div className="w-2 h-2 bg-gold rounded-full mt-2"></div>
                        <div>
                          <h4 className="font-semibold text-cream">Global Accessibility</h4>
                          <p className="text-sm text-sand">24/7 availability, cross-border participation</p>
                        </div>
                      </div>
                      <div className="flex items-start space-x-3">
                        <div className="w-2 h-2 bg-gold rounded-full mt-2"></div>
                        <div>
                          <h4 className="font-semibold text-cream">Automated Escrow</h4>
                          <p className="text-sm text-sand">Contributions held and released by smart contract, on schedule</p>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="bg-ink-surface p-4 rounded-lg font-mono text-sm overflow-x-auto mb-6">
                  <pre>{`// Smart Contract for African Tontine
struct AfricanTontine {
    members: vector<TontineMember>,
    contribution_amount: u64,
    cultural_fund: Balance<USDC>,
    rotation_position: u64, // whose turn receives the payout
    current_cycle: u64,
    is_active: bool
}

public fun make_monthly_contribution(
    tontine: &mut AfricanTontine,
    payment: Coin<USDC>,
    ctx: &TxContext
) {
    // Verify member and amount
    // Allocate 95% to main fund, 5% to cultural activities
    // Check if all members contributed
    // Process payout when round complete
}`}</pre>
                </div>

                <div className="bg-gold/[0.07] p-6 rounded-lg">
                  <h3 className="text-lg font-semibold text-gold mb-3">Key Blockchain Advantages</h3>
                  <div className="grid md:grid-cols-3 gap-4 text-sm text-gold">
                    <div>
                      <h4 className="font-medium">Enhanced Security</h4>
                      <p>Cryptographic protection and immutable records</p>
                    </div>
                    <div>
                      <h4 className="font-medium">Cultural Preservation</h4>
                      <p>Virtual ceremonies and digital community spaces</p>
                    </div>
                    <div>
                      <h4 className="font-medium">Diaspora Integration</h4>
                      <p>Global participation maintaining cultural connections</p>
                    </div>
                  </div>
                </div>
              </div>
            </section>
          </div>

          <div
            id="implementation"
            role="tabpanel"
            className={activeSection === 'implementation' ? '' : 'hidden'}
          >
            <section className="space-y-8">
              <div className="bg-ink-surface rounded-lg shadow-[0_20px_60px_-30px_rgba(0,0,0,0.85)] p-8">
                <h2 className="text-3xl font-bold mb-6 text-cream">Getting Started with Digital Tontines</h2>
                
                <div className="grid md:grid-cols-2 gap-8 mb-8">
                  <div>
                    <h3 className="text-xl font-bold mb-4">Step-by-Step Process</h3>
                    <div className="space-y-4">
                      <div className="border border-ink-border rounded-lg p-4">
                        <h4 className="font-semibold text-gold mb-2">1. Cultural Registration</h4>
                        <p className="text-sm text-sand">
                          Select your region (Senegal, Mali, Cameroon, etc.) and cultural preferences.
                        </p>
                      </div>
                      <div className="border border-ink-border rounded-lg p-4">
                        <h4 className="font-semibold text-gold mb-2">2. Financial Setup</h4>
                        <p className="text-sm text-sand">
                          Connect your Sui wallet and fund with USDC or local currency equivalent.
                        </p>
                      </div>
                      <div className="border border-ink-border rounded-lg p-4">
                        <h4 className="font-semibold text-gold mb-2">3. Community Matching</h4>
                        <p className="text-sm text-sand">
                          Find tontines based on contribution amount, duration, and cultural background.
                        </p>
                      </div>
                      <div className="border border-ink-border rounded-lg p-4">
                        <h4 className="font-semibold text-gold mb-2">4. Active Participation</h4>
                        <p className="text-sm text-sand">
                          Set up automatic payments and engage with virtual community features.
                        </p>
                      </div>
                    </div>
                  </div>

                  <div>
                    <h3 className="text-xl font-bold mb-4">Platform Features</h3>
                    <div className="bg-ink-deep p-6 rounded-lg space-y-4">
                      <div>
                        <h4 className="font-semibold text-cream">Multi-Currency Support</h4>
                        <p className="text-sm text-sand mt-1">
                          USDC, CFA francs, and other African currencies with automatic conversion.
                        </p>
                      </div>
                      <div>
                        <h4 className="font-semibold text-cream">Cultural Integration</h4>
                        <p className="text-sm text-sand mt-1">
                          Virtual ceremonies, traditional greetings, and community celebrations.
                        </p>
                      </div>
                      <div>
                        <h4 className="font-semibold text-cream">Stablecoin Settlement</h4>
                        <p className="text-sm text-sand mt-1">
                          USD-pegged contributions keep the pot&rsquo;s value steady across borders.
                        </p>
                      </div>
                    </div>

                    <div className="mt-6 space-y-3">
                      <Link 
                        href="/create-circle"
                        className="w-full bg-gold text-cream py-3 px-6 rounded-lg font-semibold hover:bg-gold transition-colors flex items-center justify-center"
                      >
                        Create Your Tontine
                      </Link>
                      <Link 
                        href="/dashboard"
                        className="w-full border border-gold/45 text-gold py-3 px-6 rounded-lg font-semibold hover:bg-gold/[0.07] transition-colors flex items-center justify-center"
                      >
                        Browse Existing Tontines
                      </Link>
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
              
              <Link href="/learn/blockchain-rosca" className="group">
                <div className="border border-ink-border rounded-lg p-4 hover:border-gold/45 hover:shadow-[0_14px_40px_-24px_rgba(0,0,0,0.8)] transition-all">
                  <h3 className="font-semibold text-gold group-hover:text-gold mb-2">
                    Blockchain ROSCA: The Future of Community Savings
                  </h3>
                  <p className="text-sm text-sand">
                    Discover how blockchain technology revolutionizes traditional ROSCAs worldwide.
                  </p>
                </div>
              </Link>
              
              <Link href="/learn/sou-sou-crypto" className="group">
                <div className="border border-ink-border rounded-lg p-4 hover:border-gold/45 hover:shadow-[0_14px_40px_-24px_rgba(0,0,0,0.8)] transition-all">
                  <h3 className="font-semibold text-gold group-hover:text-gold mb-2">
                    Sou Sou Crypto: Caribbean Savings Circles
                  </h3>
                  <p className="text-sm text-sand">
                    Explore how Caribbean and West African susu traditions meet cryptocurrency.
                  </p>
                </div>
              </Link>
            </div>
          </section>

          {/* CTA Section */}
          <section className="bg-gradient-to-r from-ink-surface to-ink-deep rounded-lg text-cream p-8 mt-12 text-center">
            <h2 className="text-2xl font-bold mb-4">Ready to Join the African Finance Revolution?</h2>
            <p className="text-cream-muted mb-6">
              Start your digital tontine journey today and connect with African communities worldwide
              while preserving cultural traditions through transparent, non-custodial coordination.
            </p>
            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <Link 
                href="/create-circle"
                className="bg-ink-surface text-gold px-8 py-3 rounded-lg font-semibold hover:bg-ink-surface transition-colors"
              >
                Start Your Tontine
              </Link>
              <Link 
                href="/dashboard"
                className="border border-gold-deep/55 text-cream px-8 py-3 rounded-lg font-semibold hover:bg-ink-surface hover:text-gold transition-colors"
              >
                Explore Platform
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