import Link from 'next/link';
import { useState } from 'react';
import { Seo } from '../../components/Seo';
import { article, breadcrumbs } from '../../lib/structured-data';
import { MarketingShell } from '../../components/marketing/ArticleLayout';
import { SourcedStat, PlainStat } from '../../components/marketing/SourcedStat';
import { REMITTANCE_COST_AFRICA, SAVINGS_CLUB_PARTICIPATION } from '../../content/sourced-facts';

export default function BlockchainRoscaPage() {
  const [activeTab, setActiveTab] = useState('overview');

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

      <MarketingShell>
        {/* Navigation Breadcrumb */}
        <nav className="bg-ink-surface border-b">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex items-center space-x-2 py-3 text-sm text-sand">
              <Link href="/" className="hover:text-gold transition-colors">Home</Link>
              <span>/</span>
              <Link href="/learn" className="hover:text-gold transition-colors">Learn</Link>
              <span>/</span>
              <span className="text-cream font-medium">Blockchain ROSCA</span>
            </div>
          </div>
        </nav>

        {/* Hero Section */}
        <section className="relative bg-gradient-to-r from-ink-surface to-ink-deep text-cream py-20">
          <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
            <h1 className="text-4xl md:text-5xl font-bold mb-6">
              What is a ROSCA? Rotating Savings and Credit Associations Explained
            </h1>
            <p className="text-xl md:text-2xl mb-8 text-cream-muted">
              Transforming traditional <strong>Rotating Savings and Credit Associations (ROSCAs)</strong> through 
              blockchain technology, smart contracts, and decentralized finance. Experience the security and 
              transparency of community savings reimagined for the digital age.
            </p>
            <div className="flex flex-col sm:flex-row gap-4">
              <Link 
                href="/create-circle" 
                className="bg-ink-surface text-gold px-8 py-3 rounded-lg font-semibold hover:bg-ink-surface transition-colors text-center"
              >
                Start Your Digital ROSCA →
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

        {/* Every figure links to its source. The previous block asserted a
            global participant count, a country count and an annual ROSCA
            volume, none of them sourced. Nobody measures global ROSCA volume —
            the whole point of a ROSCA is that it leaves no institutional
            record — so there is no honest number to replace it with. */}
        <section className="bg-ink-surface border-b border-ink-border">
          <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-8">
              <SourcedStat fact={SAVINGS_CLUB_PARTICIPATION} />
              <SourcedStat fact={REMITTANCE_COST_AFRICA} />
              <PlainStat
                value="Every cycle"
                label="Contributions, payout order and approvals stay visible to the whole circle for the life of the circle"
              />
            </div>
          </div>
        </section>

        {/* Main Navigation */}
        <section className="bg-ink-surface border-b">
          <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
            <div className="flex flex-wrap gap-4">
              <button 
                onClick={() => setActiveTab('overview')}
                className={`px-4 py-2 rounded-lg transition-colors ${activeTab === 'overview' ? 'bg-gold/[0.07] text-gold' : 'hover:bg-ink-surface'}`}
              >
                ROSCA Overview
              </button>
              <button 
                onClick={() => setActiveTab('global')}
                className={`px-4 py-2 rounded-lg transition-colors ${activeTab === 'global' ? 'bg-gold/[0.07] text-gold' : 'hover:bg-ink-surface'}`}
              >
                Global Systems
              </button>
              <button 
                onClick={() => setActiveTab('blockchain')}
                className={`px-4 py-2 rounded-lg transition-colors ${activeTab === 'blockchain' ? 'bg-gold/[0.07] text-gold' : 'hover:bg-ink-surface'}`}
              >
                Blockchain Revolution
              </button>
              <button 
                onClick={() => setActiveTab('implementation')}
                className={`px-4 py-2 rounded-lg transition-colors ${activeTab === 'implementation' ? 'bg-gold/[0.07] text-gold' : 'hover:bg-ink-surface'}`}
              >
                Implementation
              </button>
            </div>
          </div>
        </section>

        {/* Main Content */}
        <main className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
          {/* Overview Section */}
          <div
            id="overview"
            role="tabpanel"
            className={activeTab === 'overview' ? '' : 'hidden'}
          >
            <section className="space-y-8">
              <div className="bg-ink-surface rounded-lg shadow-[0_20px_60px_-30px_rgba(0,0,0,0.85)] p-8">
                <h2 className="text-3xl font-bold mb-6 text-cream">What are ROSCAs?</h2>
                <p className="text-lg text-sand mb-6">
                  <strong>Rotating Savings and Credit Associations (ROSCAs)</strong> are informal financial cooperatives 
                  where groups of individuals contribute fixed amounts regularly to a common fund. Members take turns 
                  receiving the entire pooled amount, creating a rotating credit system that provides access to larger 
                  sums of money without traditional banking requirements.
                </p>
                
                <div className="grid md:grid-cols-2 gap-8 mb-8">
                  <div className="bg-gold/[0.07] p-6 rounded-lg">
                    <h3 className="text-xl font-semibold text-gold mb-4">Core Characteristics</h3>
                    <ul className="space-y-2 text-gold">
                      <li>• Fixed, regular contributions from all members</li>
                      <li>• Rotating payout system ensuring fair distribution</li>
                      <li>• Trust-based community membership</li>
                      <li>• No interest charges or traditional banking requirements</li>
                      <li>• Social and financial support network</li>
                    </ul>
                  </div>
                  
                  <div className="bg-gold/[0.07] p-6 rounded-lg">
                    <h3 className="text-xl font-semibold text-gold mb-4">Global Impact</h3>
                    <ul className="space-y-2 text-gold">
                      <li>• Found independently on every inhabited continent</li>
                      <li>• Works without a bank, a credit history or paperwork</li>
                      <li>• A common source of working capital for market traders</li>
                      <li>• Frequently organised and led by women</li>
                      <li>• Carried abroad intact by diaspora communities</li>
                    </ul>
                  </div>
                </div>

                <h3 className="text-2xl font-bold mb-4">How Traditional ROSCAs Work</h3>
                <div className="bg-ink-deep p-6 rounded-lg">
                  <div className="grid md:grid-cols-4 gap-4 text-center">
                    <div>
                      <div className="bg-gold text-cream rounded-full w-12 h-12 flex items-center justify-center mx-auto mb-2 text-lg font-bold">1</div>
                      <h4 className="font-semibold">Group Formation</h4>
                      <p className="text-sm text-sand">8-20 trusted members agree to participate</p>
                    </div>
                    <div>
                      <div className="bg-gold text-cream rounded-full w-12 h-12 flex items-center justify-center mx-auto mb-2 text-lg font-bold">2</div>
                      <h4 className="font-semibold">Regular Contributions</h4>
                      <p className="text-sm text-sand">Fixed amounts collected weekly/monthly</p>
                    </div>
                    <div>
                      <div className="bg-gold text-cream rounded-full w-12 h-12 flex items-center justify-center mx-auto mb-2 text-lg font-bold">3</div>
                      <h4 className="font-semibold">Rotating Payouts</h4>
                      <p className="text-sm text-sand">Members take turns receiving full amount</p>
                    </div>
                    <div>
                      <div className="bg-gold text-cream rounded-full w-12 h-12 flex items-center justify-center mx-auto mb-2 text-lg font-bold">4</div>
                      <h4 className="font-semibold">Cycle Completion</h4>
                      <p className="text-sm text-sand">Process continues until all receive payouts</p>
                    </div>
                  </div>
                </div>
              </div>
            </section>
          </div>

          {/* Global Systems Section */}
          <div
            id="global"
            role="tabpanel"
            className={activeTab === 'global' ? '' : 'hidden'}
          >
            <section className="space-y-8">
              <div className="bg-ink-surface rounded-lg shadow-[0_20px_60px_-30px_rgba(0,0,0,0.85)] p-8">
                <h2 className="text-3xl font-bold mb-6 text-cream">ROSCAs Around the World</h2>
                
                <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6 mb-8">
                  <div className="border border-ink-border rounded-lg p-4">
                    <h3 className="font-semibold text-lg mb-2">Africa</h3>
                    <ul className="text-sm space-y-1">
                      <li><strong>Njangi</strong> - Cameroon</li>
                      <li><strong>Tontines</strong> - French Africa</li>
                      <li><strong>Susu</strong> - Ghana, Sierra Leone</li>
                      <li><strong>Stokvels</strong> - South Africa</li>
                      <li><strong>Chit Funds</strong> - Kenya</li>
                    </ul>
                  </div>
                  
                  <div className="border border-ink-border rounded-lg p-4">
                    <h3 className="font-semibold text-lg mb-2">Asia</h3>
                    <ul className="text-sm space-y-1">
                      <li><strong>Chit Funds</strong> - India</li>
                      <li><strong>Hui</strong> - China</li>
                      <li><strong>Kye</strong> - Korea</li>
                      <li><strong>Paluwagan</strong> - Philippines</li>
                      <li><strong>Arisan</strong> - Indonesia</li>
                    </ul>
                  </div>
                  
                  <div className="border border-ink-border rounded-lg p-4">
                    <h3 className="font-semibold text-lg mb-2">Americas</h3>
                    <ul className="text-sm space-y-1">
                      <li><strong>Sou Sou</strong> - Caribbean</li>
                      <li><strong>Tandas</strong> - Mexico</li>
                      <li><strong>Susus</strong> - Guyana</li>
                      <li><strong>Juntas</strong> - Colombia</li>
                      <li><strong>Partners</strong> - Jamaica</li>
                    </ul>
                  </div>
                </div>

                <div className="bg-gold/[0.07] border border-gold/45 rounded-lg p-6">
                  <h3 className="text-lg font-semibold text-gold mb-3">Common Challenges Across All Systems</h3>
                  <div className="grid md:grid-cols-2 gap-4 text-sm text-gold">
                    <div>
                      <h4 className="font-medium">Trust and Security Issues</h4>
                      <ul className="mt-2 space-y-1">
                        <li>• Member default risks</li>
                        <li>• Organizer fraud potential</li>
                        <li>• Cash handling vulnerabilities</li>
                        <li>• Limited legal recourse</li>
                      </ul>
                    </div>
                    <div>
                      <h4 className="font-medium">Operational Limitations</h4>
                      <ul className="mt-2 space-y-1">
                        <li>• Geographic constraints</li>
                        <li>• Manual record keeping</li>
                        <li>• Cash sits with one treasurer</li>
                        <li>• Limited scalability</li>
                      </ul>
                    </div>
                  </div>
                </div>
              </div>
            </section>
          </div>

          {/* Blockchain Revolution Section */}
          <div
            id="blockchain"
            role="tabpanel"
            className={activeTab === 'blockchain' ? '' : 'hidden'}
          >
            <section className="space-y-8">
              <div className="bg-ink-surface rounded-lg shadow-[0_20px_60px_-30px_rgba(0,0,0,0.85)] p-8">
                <h2 className="text-3xl font-bold mb-6 text-cream">Blockchain Technology Revolution</h2>
                
                <div className="mb-8">
                  <h3 className="text-2xl font-bold mb-4">Smart Contract Automation</h3>
                  <div className="bg-ink-surface p-4 rounded-lg font-mono text-sm overflow-x-auto">
                    <pre>{`// Simplified ROSCA Smart Contract
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
    // Update reputation scores
}`}</pre>
                  </div>
                </div>

                <div className="grid md:grid-cols-2 gap-8 mb-8">
                  <div>
                    <h3 className="text-xl font-bold mb-4 text-gold">Traditional ROSCA Problems</h3>
                    <div className="space-y-3">
                      <div className="flex items-start space-x-3">
                        <div className="w-2 h-2 bg-gold rounded-full mt-2"></div>
                        <div>
                          <h4 className="font-semibold text-cream">Trust Vulnerabilities</h4>
                          <p className="text-sm text-sand">Single points of failure, fraud risks</p>
                        </div>
                      </div>
                      <div className="flex items-start space-x-3">
                        <div className="w-2 h-2 bg-gold rounded-full mt-2"></div>
                        <div>
                          <h4 className="font-semibold text-cream">Geographic Limitations</h4>
                          <p className="text-sm text-sand">Physical meetings, local membership only</p>
                        </div>
                      </div>
                      <div className="flex items-start space-x-3">
                        <div className="w-2 h-2 bg-gold rounded-full mt-2"></div>
                        <div>
                          <h4 className="font-semibold text-cream">Treasurer Risk</h4>
                          <p className="text-sm text-sand">One person physically holds the pooled cash</p>
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
                          <h4 className="font-semibold text-cream">Cryptographic Security</h4>
                          <p className="text-sm text-sand">Immutable, transparent, automated</p>
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

                <div className="bg-gold/[0.07] p-6 rounded-lg">
                  <h3 className="text-lg font-semibold text-gold mb-3">Key Blockchain Advantages</h3>
                  <div className="grid md:grid-cols-3 gap-4 text-sm text-gold">
                    <div>
                      <h4 className="font-medium">Transparency</h4>
                      <p>All transactions publicly verifiable on blockchain</p>
                    </div>
                    <div>
                      <h4 className="font-medium">Automation</h4>
                      <p>Contribution tracking and payout order run from contract rules, not memory</p>
                    </div>
                    <div>
                      <h4 className="font-medium">Scalability</h4>
                      <p>No size limits, global membership possible</p>
                    </div>
                  </div>
                </div>
              </div>
            </section>
          </div>

          {/* Implementation Section */}
          <div
            id="implementation"
            role="tabpanel"
            className={activeTab === 'implementation' ? '' : 'hidden'}
          >
            <section className="space-y-8">
              <div className="bg-ink-surface rounded-lg shadow-[0_20px_60px_-30px_rgba(0,0,0,0.85)] p-8">
                <h2 className="text-3xl font-bold mb-6 text-cream">Getting Started with Blockchain ROSCAs</h2>
                
                <div className="grid md:grid-cols-2 gap-8 mb-8">
                  <div>
                    <h3 className="text-xl font-bold mb-4">Platform Features</h3>
                    <div className="space-y-4">
                      <div className="border border-ink-border rounded-lg p-4">
                        <h4 className="font-semibold text-gold mb-2">Multi-Cultural Support</h4>
                        <p className="text-sm text-sand">
                          Supporting traditional ROSCA formats from around the world with 
                          culturally appropriate features and ceremonies.
                        </p>
                      </div>
                      <div className="border border-ink-border rounded-lg p-4">
                        <h4 className="font-semibold text-gold mb-2">Stablecoin Settlement</h4>
                        <p className="text-sm text-sand">
                          Contribute in USD-pegged stablecoins so the pot&rsquo;s value
                          stays predictable across borders.
                        </p>
                      </div>
                      <div className="border border-ink-border rounded-lg p-4">
                        <h4 className="font-semibold text-gold mb-2">Global Accessibility</h4>
                        <p className="text-sm text-sand">
                          Cross-border participation enabling diaspora communities 
                          to maintain connections with home countries.
                        </p>
                      </div>
                    </div>
                  </div>

                  <div>
                    <h3 className="text-xl font-bold mb-4">Quick Start Guide</h3>
                    <div className="space-y-3">
                      <div className="flex items-center space-x-3">
                        <div className="bg-gold text-cream rounded-full w-6 h-6 flex items-center justify-center text-sm font-bold">1</div>
                        <span className="text-sm">Set up cryptocurrency wallet (Sui Wallet recommended)</span>
                      </div>
                      <div className="flex items-center space-x-3">
                        <div className="bg-gold text-cream rounded-full w-6 h-6 flex items-center justify-center text-sm font-bold">2</div>
                        <span className="text-sm">Complete identity verification and KYC process</span>
                      </div>
                      <div className="flex items-center space-x-3">
                        <div className="bg-gold text-cream rounded-full w-6 h-6 flex items-center justify-center text-sm font-bold">3</div>
                        <span className="text-sm">Browse available circles or create your own</span>
                      </div>
                      <div className="flex items-center space-x-3">
                        <div className="bg-gold text-cream rounded-full w-6 h-6 flex items-center justify-center text-sm font-bold">4</div>
                        <span className="text-sm">Deposit security fund and start participating</span>
                      </div>
                    </div>

                    <div className="mt-6 space-y-3">
                      <Link 
                        href="/create-circle"
                        className="w-full bg-gold text-cream py-3 px-6 rounded-lg font-semibold hover:bg-gold transition-colors flex items-center justify-center"
                      >
                        Create Your Circle
                      </Link>
                      <Link 
                        href="/dashboard"
                        className="w-full border border-gold/45 text-gold py-3 px-6 rounded-lg font-semibold hover:bg-gold/[0.07] transition-colors flex items-center justify-center"
                      >
                        Browse Existing Circles
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
              
              <Link href="/learn/tontine" className="group">
                <div className="border border-ink-border rounded-lg p-4 hover:border-gold/45 hover:shadow-[0_14px_40px_-24px_rgba(0,0,0,0.8)] transition-all">
                  <h3 className="font-semibold text-gold group-hover:text-gold mb-2">
                    Tontine Blockchain: African Finance Revolution
                  </h3>
                  <p className="text-sm text-sand">
                    Discover how French African tontine traditions meet modern blockchain technology.
                  </p>
                </div>
              </Link>
              
              <Link href="/learn/susu" className="group">
                <div className="border border-ink-border rounded-lg p-4 hover:border-gold/45 hover:shadow-[0_14px_40px_-24px_rgba(0,0,0,0.8)] transition-all">
                  <h3 className="font-semibold text-gold group-hover:text-gold mb-2">
                    Sou Sou Crypto: Caribbean Savings Circles
                  </h3>
                  <p className="text-sm text-sand">
                    Explore how Caribbean and West African susu traditions embrace cryptocurrency.
                  </p>
                </div>
              </Link>
            </div>
          </section>

          {/* CTA Section */}
          <section className="bg-gradient-to-r from-ink-surface to-ink-deep rounded-lg text-cream p-8 mt-12 text-center">
            <h2 className="text-2xl font-bold mb-4">Ready to Join the Blockchain ROSCA Revolution?</h2>
            <p className="text-cream-muted mb-6">
              Experience the future of community savings with transparent, secure, and globally accessible 
              rotating savings circles powered by blockchain technology.
            </p>
            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <Link 
                href="/create-circle"
                className="bg-ink-surface text-gold px-8 py-3 rounded-lg font-semibold hover:bg-ink-surface transition-colors"
              >
                Start Your Circle
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

        {/* Footer Disclaimer */}
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