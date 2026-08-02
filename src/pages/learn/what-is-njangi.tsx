import Link from 'next/link';
import { useState } from 'react';
import { Seo } from '../../components/Seo';
import { article, breadcrumbs, definedTerm } from '../../lib/structured-data';
import { MarketingShell } from '../../components/marketing/ArticleLayout';

export default function WhatIsNjangiPage() {
  const [activeTab, setActiveTab] = useState('definition');

  return (
    <>
      <Seo
        title="What is a Njangi? Cameroon's Savings Circle"
        titleAbsolute
        description="Njangi (n-JAHN-gee) is Cameroon's rotating savings circle: members contribute on a shared schedule and each takes the whole pot in turn. Origins, mechanics, and how to run one."
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

      <MarketingShell>
        {/* Navigation Breadcrumb */}
        <nav className="bg-ink-surface border-b">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex items-center space-x-2 py-3 text-sm text-sand">
              <Link href="/" className="hover:text-gold transition-colors">Home</Link>
              <span>/</span>
              <Link href="/learn" className="hover:text-gold transition-colors">Learn</Link>
              <span>/</span>
              <span className="text-cream font-medium">What is Njangi</span>
            </div>
          </div>
        </nav>

        {/* Hero Section */}
        <section className="relative bg-gradient-to-r from-ink-surface to-ink-deep text-cream py-20">
          <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
            <h1 className="text-4xl md:text-5xl font-bold mb-6">
              What is Njangi? Understanding Cameroon&rsquo;s Revolutionary Savings Circle
            </h1>
            <p className="text-xl md:text-2xl mb-8 text-cream-muted">
              <strong>Njangi</strong> (pronounced &ldquo;n-JAHN-gee&rdquo;) is a Cameroon-originated rotating savings and credit association 
              where community members pool money regularly and take turns receiving lump sum payouts. Now revolutionized through 
              blockchain technology, Njangi combines centuries-old financial wisdom with modern transparency and automation.
            </p>
            <div className="flex flex-col sm:flex-row gap-4">
              <Link 
                href="/create-circle" 
                className="bg-ink-surface text-gold px-8 py-3 rounded-lg font-semibold hover:bg-ink-surface transition-colors text-center"
              >
                Start Your Digital Njangi Today →
              </Link>
              <Link 
                href="/dashboard" 
                className="border border-gold-deep/55 text-cream px-8 py-3 rounded-lg font-semibold hover:bg-ink-surface hover:text-gold transition-colors text-center"
              >
                View Dashboard
              </Link>
            </div>
          </div>
        </section>

        {/* Quick Navigation */}
        <section className="bg-ink-surface border-b">
          <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
            <h2 className="text-xl font-semibold mb-4">Table of Contents</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
              <button 
                onClick={() => setActiveTab('definition')}
                className={`text-left p-3 rounded-lg transition-colors ${activeTab === 'definition' ? 'bg-gold/[0.07] text-gold' : 'hover:bg-ink-surface'}`}
              >
                What is Njangi?
              </button>
              <button 
                onClick={() => setActiveTab('history')}
                className={`text-left p-3 rounded-lg transition-colors ${activeTab === 'history' ? 'bg-gold/[0.07] text-gold' : 'hover:bg-ink-surface'}`}
              >
                Historical Origins
              </button>
              <button 
                onClick={() => setActiveTab('how-it-works')}
                className={`text-left p-3 rounded-lg transition-colors ${activeTab === 'how-it-works' ? 'bg-gold/[0.07] text-gold' : 'hover:bg-ink-surface'}`}
              >
                How It Works
              </button>
              <button 
                onClick={() => setActiveTab('getting-started')}
                className={`text-left p-3 rounded-lg transition-colors ${activeTab === 'getting-started' ? 'bg-gold/[0.07] text-gold' : 'hover:bg-ink-surface'}`}
              >
                Getting Started
              </button>
            </div>
          </div>
        </section>

        {/* Main Content */}
        <main className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
          {/* Definition Section */}
          <div
            id="definition"
            role="tabpanel"
            className={activeTab === 'definition' ? '' : 'hidden'}
          >
            <section className="space-y-8">
              <div className="bg-ink-surface rounded-lg shadow-[0_20px_60px_-30px_rgba(0,0,0,0.85)] p-8">
                <h2 className="text-3xl font-bold mb-6 text-cream">What is Njangi?</h2>
                <p className="text-lg text-sand mb-6">
                  <strong>Njangi</strong> (pronounced &ldquo;n-JAHN-gee&rdquo;) is a Cameroon-originated rotating savings and credit association 
                  where a group of trusted individuals contribute fixed amounts regularly to a common pool. Each cycle, one member 
                  receives the entire collected amount, continuing until everyone has received their turn.
                </p>
                
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
                <div className="bg-gold/[0.07] border-l-4 border-gold/45 p-6 mb-6">
                  <h3 className="text-lg font-semibold text-gold mb-2">Why it endures</h3>
                  <ul className="space-y-2 text-gold">
                    <li>• The same rotating structure appears independently on every inhabited continent, under dozens of local names</li>
                    <li>• It needs no bank, no credit history, and no paperwork — only a group that knows each other</li>
                    <li>• Economists group these arrangements under the label <strong>ROSCA</strong>: rotating savings and credit association</li>
                  </ul>
                </div>

                <h3 className="text-2xl font-bold mb-4">Key Characteristics of Njangi</h3>
                <div className="grid md:grid-cols-2 gap-6 mb-8">
                  <div className="space-y-4">
                    <div className="border-l-4 border-gold/45 pl-4">
                      <h4 className="font-semibold text-cream">Community-based</h4>
                      <p className="text-sand">Built on existing social relationships and trust</p>
                    </div>
                    <div className="border-l-4 border-gold/45 pl-4">
                      <h4 className="font-semibold text-cream">No interest charges</h4>
                      <p className="text-sand">Members help each other without additional fees</p>
                    </div>
                  </div>
                  <div className="space-y-4">
                    <div className="border-l-4 border-gold/45 pl-4">
                      <h4 className="font-semibold text-cream">Rotating payouts</h4>
                      <p className="text-sand">Fair distribution ensuring everyone benefits</p>
                    </div>
                    <div className="border-l-4 border-gold/45 pl-4">
                      <h4 className="font-semibold text-cream">Cultural significance</h4>
                      <p className="text-sand">Strengthens community bonds and social capital</p>
                    </div>
                  </div>
                </div>
              </div>
            </section>
          </div>

          {/* History Section */}
          <div
            id="history"
            role="tabpanel"
            className={activeTab === 'history' ? '' : 'hidden'}
          >
            <section className="space-y-8">
              <div className="bg-ink-surface rounded-lg shadow-[0_20px_60px_-30px_rgba(0,0,0,0.85)] p-8">
                <h2 className="text-3xl font-bold mb-6 text-cream">Historical Origins & Cultural Significance</h2>
                
                <h3 className="text-2xl font-bold mb-4">Ancient Roots in West Africa</h3>
                <p className="text-lg text-sand mb-6">
                  Njangi traces its origins to ancient West African financial traditions, with similar systems documented for 
                  <strong> over 1,000 years</strong>. The practice emerged from the fundamental human need for financial cooperation 
                  and community support, particularly in agricultural societies where seasonal cash flows required collective savings strategies.
                </p>

                <div className="bg-gold/[0.07] rounded-lg p-6 mb-6">
                  <h4 className="text-lg font-semibold text-gold mb-3">Cultural Rituals and Practices</h4>
                  <p className="text-gold mb-3">Traditional Njangi meetings involve more than financial transactions:</p>
                  <ul className="space-y-2 text-gold">
                    <li>• <strong>Greetings and ceremonies</strong>: Members exchange traditional greetings and share kola nuts</li>
                    <li>• <strong>Community updates</strong>: Meetings serve as social gatherings for news and support</li>
                    <li>• <strong>Collective decision-making</strong>: Group consensus guides important decisions</li>
                    <li>• <strong>Celebration rituals</strong>: Payout recipients often treat the group to food or drinks</li>
                  </ul>
                </div>

                <h3 className="text-2xl font-bold mb-4">Evolution Across Africa</h3>
                <p className="text-sand mb-4">From Cameroon, similar systems spread throughout Africa under different names:</p>
                <div className="grid md:grid-cols-2 gap-4">
                  <div className="bg-ink-deep p-4 rounded-lg">
                    <h4 className="font-semibold">Djanggis</h4>
                    <p className="text-sm text-sand">Alternate Cameroon term</p>
                  </div>
                  <div className="bg-ink-deep p-4 rounded-lg">
                    <h4 className="font-semibold">Tontines</h4>
                    <p className="text-sm text-sand">French-speaking Africa</p>
                  </div>
                  <div className="bg-ink-deep p-4 rounded-lg">
                    <h4 className="font-semibold">Susus</h4>
                    <p className="text-sm text-sand">Ghana, Sierra Leone</p>
                  </div>
                  <div className="bg-ink-deep p-4 rounded-lg">
                    <h4 className="font-semibold">Stokvels</h4>
                    <p className="text-sm text-sand">South Africa</p>
                  </div>
                </div>
              </div>
            </section>
          </div>

          {/* How It Works Section */}
          <div
            id="how-it-works"
            role="tabpanel"
            className={activeTab === 'how-it-works' ? '' : 'hidden'}
          >
            <section className="space-y-8">
              <div className="bg-ink-surface rounded-lg shadow-[0_20px_60px_-30px_rgba(0,0,0,0.85)] p-8">
                <h2 className="text-3xl font-bold mb-6 text-cream">How Njangi Works: Traditional vs. Blockchain</h2>
                
                <div className="grid lg:grid-cols-2 gap-8 mb-8">
                  <div>
                    <h3 className="text-xl font-bold mb-4 text-cream">Traditional Njangi Process</h3>
                    <div className="space-y-4">
                      <div className="flex items-start space-x-3">
                        <div className="bg-gold text-cream rounded-full w-8 h-8 flex items-center justify-center text-sm font-bold">1</div>
                        <div>
                          <h4 className="font-semibold">Group Formation</h4>
                          <p className="text-sand text-sm">8-20 trusted community members agree to participate</p>
                        </div>
                      </div>
                      <div className="flex items-start space-x-3">
                        <div className="bg-gold text-cream rounded-full w-8 h-8 flex items-center justify-center text-sm font-bold">2</div>
                        <div>
                          <h4 className="font-semibold">Setting Terms</h4>
                          <p className="text-sand text-sm">Fixed contribution amount and meeting schedule</p>
                        </div>
                      </div>
                      <div className="flex items-start space-x-3">
                        <div className="bg-gold text-cream rounded-full w-8 h-8 flex items-center justify-center text-sm font-bold">3</div>
                        <div>
                          <h4 className="font-semibold">Regular Meetings</h4>
                          <p className="text-sand text-sm">Members gather to contribute and receive payouts</p>
                        </div>
                      </div>
                      <div className="flex items-start space-x-3">
                        <div className="bg-gold text-cream rounded-full w-8 h-8 flex items-center justify-center text-sm font-bold">4</div>
                        <div>
                          <h4 className="font-semibold">Rotation Completion</h4>
                          <p className="text-sand text-sm">Process continues until all members receive payouts</p>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div>
                    <h3 className="text-xl font-bold mb-4 text-gold">Blockchain-Powered Revolution</h3>
                    <div className="bg-gold/[0.07] p-6 rounded-lg">
                      <h4 className="font-semibold text-gold mb-3">Smart Contract Automation</h4>
                      <ul className="space-y-2 text-gold text-sm">
                        <li>• Contribution tracking happens automatically on-chain</li>
                        <li>• Payout distribution follows predetermined rules</li>
                        <li>• No single point of failure or fraud risk</li>
                        <li>• Complete transaction history immutably recorded</li>
                      </ul>
                    </div>
                  </div>
                </div>

                <div className="bg-gold/[0.07] border border-gold/45 rounded-lg p-6">
                  <h3 className="text-lg font-semibold text-gold mb-3">Traditional Challenges Solved</h3>
                  <div className="grid md:grid-cols-3 gap-4 text-sm">
                    <div>
                      <h4 className="font-medium text-gold">Trust vulnerabilities</h4>
                      <p className="text-gold">→ Cryptographic guarantees</p>
                    </div>
                    <div>
                      <h4 className="font-medium text-gold">Geographic constraints</h4>
                      <p className="text-gold">→ Global accessibility</p>
                    </div>
                    <div>
                      <h4 className="font-medium text-gold">Record-keeping issues</h4>
                      <p className="text-gold">→ Immutable blockchain records</p>
                    </div>
                  </div>
                </div>
              </div>
            </section>
          </div>

          {/* Getting Started Section */}
          <div
            id="getting-started"
            role="tabpanel"
            className={activeTab === 'getting-started' ? '' : 'hidden'}
          >
            <section className="space-y-8">
              <div className="bg-ink-surface rounded-lg shadow-[0_20px_60px_-30px_rgba(0,0,0,0.85)] p-8">
                <h2 className="text-3xl font-bold mb-6 text-cream">Getting Started with Digital Njangi</h2>
                
                <div className="grid md:grid-cols-2 gap-8 mb-8">
                  <div>
                    <h3 className="text-xl font-bold mb-4">Step-by-Step Onboarding</h3>
                    <div className="space-y-4">
                      <div className="border border-ink-border rounded-lg p-4">
                        <h4 className="font-semibold text-gold mb-2">1. Account Creation</h4>
                        <p className="text-sand text-sm">
                          Download the Njangi On-Chain mobile app, complete identity verification,
                          and set up secure authentication.
                        </p>
                      </div>
                      <div className="border border-ink-border rounded-lg p-4">
                        <h4 className="font-semibold text-gold mb-2">2. Wallet Setup</h4>
                        <p className="text-sand text-sm">
                          Create or connect existing Sui wallet, fund with initial deposit, 
                          and complete blockchain tutorial.
                        </p>
                      </div>
                      <div className="border border-ink-border rounded-lg p-4">
                        <h4 className="font-semibold text-gold mb-2">3. Circle Discovery</h4>
                        <p className="text-sand text-sm">
                          Browse available circles by contribution amount, duration, and location.
                          Review member reputation scores.
                        </p>
                      </div>
                      <div className="border border-ink-border rounded-lg p-4">
                        <h4 className="font-semibold text-gold mb-2">4. Active Participation</h4>
                        <p className="text-sand text-sm">
                          Set up automatic payments, participate in meetings, 
                          and engage with circle community features.
                        </p>
                      </div>
                    </div>
                  </div>

                  <div>
                    <h3 className="text-xl font-bold mb-4">Requirements</h3>
                    <div className="bg-ink-deep p-6 rounded-lg space-y-4">
                      <div>
                        <h4 className="font-semibold text-cream">Technical</h4>
                        <ul className="text-sm text-sand mt-2 space-y-1">
                          <li>• Smartphone (iOS 12+ or Android 8+)</li>
                          <li>• Basic cryptocurrency wallet (Sui Wallet)</li>
                          <li>• Government-issued ID for verification</li>
                          <li>• Email and phone number</li>
                        </ul>
                      </div>
                      <div>
                        <h4 className="font-semibold text-cream">Financial</h4>
                        <ul className="text-sm text-sand mt-2 space-y-1">
                          <li>• Security deposit (1-2x monthly contribution)</li>
                          <li>• Monthly contribution amount</li>
                          <li>• Small amount of SUI tokens for fees</li>
                          <li>• Emergency fund for penalties</li>
                        </ul>
                      </div>
                    </div>

                    <div className="mt-6">
                      <Link 
                        href="/create-circle"
                        className="w-full bg-gold text-cream py-3 px-6 rounded-lg font-semibold hover:bg-gold transition-colors flex items-center justify-center"
                      >
                        Start Your Digital Njangi Journey →
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
              
              <Link href="/learn/tontine-blockchain" className="group">
                <div className="border border-ink-border rounded-lg p-4 hover:border-gold/45 hover:shadow-[0_14px_40px_-24px_rgba(0,0,0,0.8)] transition-all">
                  <h3 className="font-semibold text-gold group-hover:text-gold mb-2">
                    Tontine Blockchain: Revolutionizing African Finance
                  </h3>
                  <p className="text-sm text-sand">
                    Learn about French African tontine traditions and their blockchain evolution.
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
            <h2 className="text-2xl font-bold mb-4">Ready to Join the Future of Community Savings?</h2>
            <p className="text-cream-muted mb-6">
              Start your digital Njangi journey today and connect with trusted communities worldwide
              with non-custodial coordination and partner-led on/off ramps.
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
                View Dashboard
              </Link>
            </div>
          </section>

          {/* Social Sharing */}
          <section className="text-center mt-8">
            <p className="text-sand mb-4">Share this article:</p>
            <div className="flex justify-center space-x-4">
              <a href="#" className="text-gold hover:text-gold">Twitter</a>
              <a href="#" className="text-gold hover:text-gold">Facebook</a>
              <a href="#" className="text-gold hover:text-gold">LinkedIn</a>
              <a href="#" className="text-gold hover:text-gold">WhatsApp</a>
            </div>
          </section>
        </main>

        {/* Disclaimer */}
        <footer className="bg-ink-surface mt-16">
          <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
            <p className="text-sm text-sand text-center">
              <strong>Disclaimer:</strong> This content is for educational purposes only and does not constitute financial advice. 
              Always consult with qualified financial advisors before making investment decisions.
            </p>
          </div>
        </footer>
      </MarketingShell>
    </>
  );
} 