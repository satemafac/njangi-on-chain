import Head from 'next/head';
import Link from 'next/link';
import { useState } from 'react';

export default function WhatIsNjangiPage() {
  const [activeTab, setActiveTab] = useState('definition');

  return (
    <>
      <Head>
        <title>What is Njangi? - Cameroon&#39;s Traditional Savings Circle Goes Blockchain | Njangi Platform</title>
        <meta name="description" content="Discover how Njangi works and how blockchain technology revolutionizes traditional Cameroon savings circles. Join secure, transparent Njangi on the Sui blockchain platform." />
        <meta name="keywords" content="njangi, what is njangi, njangi meaning, cameroon savings, blockchain rosca, digital njangi, rotating savings cameroon" />
        <link rel="canonical" href="https://njangionchain.com/learn/what-is-njangi" />
        
        {/* Open Graph / Facebook */}
        <meta property="og:type" content="article" />
        <meta property="og:title" content="What is Njangi? - Cameroon's Traditional Savings Circle Goes Blockchain" />
        <meta property="og:description" content="Discover how Njangi works and how blockchain technology revolutionizes traditional Cameroon savings circles." />
        <meta property="og:url" content="https://njangionchain.com/learn/what-is-njangi" />
        <meta property="og:image" content="https://njangionchain.com/images/njangi-hero.jpg" />

        {/* Twitter */}
        <meta property="twitter:card" content="summary_large_image" />
        <meta property="twitter:title" content="What is Njangi? - Cameroon's Traditional Savings Circle Goes Blockchain" />
        <meta property="twitter:description" content="Discover how Njangi works and how blockchain technology revolutionizes traditional Cameroon savings circles." />
        <meta property="twitter:image" content="https://njangionchain.com/images/njangi-hero.jpg" />

        {/* Article specific */}
        <meta property="article:published_time" content="2025-06-05T00:00:00.000Z" />
        <meta property="article:author" content="Njangi Platform Team" />
        <meta property="article:section" content="Education" />
        <meta property="article:tag" content="njangi" />
        <meta property="article:tag" content="blockchain" />
        <meta property="article:tag" content="cameroon" />
        <meta property="article:tag" content="savings circle" />
      </Head>

      <div className="min-h-screen bg-gradient-to-br from-green-50 to-blue-50">
        {/* Navigation Breadcrumb */}
        <nav className="bg-white shadow-sm border-b">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex items-center space-x-2 py-3 text-sm text-gray-600">
              <Link href="/" className="hover:text-green-600 transition-colors">Home</Link>
              <span>/</span>
              <Link href="/learn" className="hover:text-green-600 transition-colors">Learn</Link>
              <span>/</span>
              <span className="text-gray-900 font-medium">What is Njangi</span>
            </div>
          </div>
        </nav>

        {/* Hero Section */}
        <section className="relative bg-gradient-to-r from-green-600 to-emerald-600 text-white py-20">
          <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
            <h1 className="text-4xl md:text-5xl font-bold mb-6">
              What is Njangi? Understanding Cameroon&rsquo;s Revolutionary Savings Circle
            </h1>
            <p className="text-xl md:text-2xl mb-8 text-green-100">
              <strong>Njangi</strong> (pronounced &ldquo;n-JAHN-gee&rdquo;) is a Cameroon-originated rotating savings and credit association 
              where community members pool money regularly and take turns receiving lump sum payouts. Now revolutionized through 
              blockchain technology, Njangi combines centuries-old financial wisdom with modern transparency and automation.
            </p>
            <div className="flex flex-col sm:flex-row gap-4">
              <Link 
                href="/create-circle" 
                className="bg-white text-green-600 px-8 py-3 rounded-lg font-semibold hover:bg-gray-100 transition-colors text-center"
              >
                Start Your Digital Njangi Today →
              </Link>
              <Link 
                href="/dashboard" 
                className="border-2 border-white text-white px-8 py-3 rounded-lg font-semibold hover:bg-white hover:text-green-600 transition-colors text-center"
              >
                View Dashboard
              </Link>
            </div>
          </div>
        </section>

        {/* Quick Navigation */}
        <section className="bg-white border-b">
          <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
            <h2 className="text-xl font-semibold mb-4">Table of Contents</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
              <button 
                onClick={() => setActiveTab('definition')}
                className={`text-left p-3 rounded-lg transition-colors ${activeTab === 'definition' ? 'bg-green-100 text-green-700' : 'hover:bg-gray-100'}`}
              >
                What is Njangi?
              </button>
              <button 
                onClick={() => setActiveTab('history')}
                className={`text-left p-3 rounded-lg transition-colors ${activeTab === 'history' ? 'bg-green-100 text-green-700' : 'hover:bg-gray-100'}`}
              >
                Historical Origins
              </button>
              <button 
                onClick={() => setActiveTab('how-it-works')}
                className={`text-left p-3 rounded-lg transition-colors ${activeTab === 'how-it-works' ? 'bg-green-100 text-green-700' : 'hover:bg-gray-100'}`}
              >
                How It Works
              </button>
              <button 
                onClick={() => setActiveTab('getting-started')}
                className={`text-left p-3 rounded-lg transition-colors ${activeTab === 'getting-started' ? 'bg-green-100 text-green-700' : 'hover:bg-gray-100'}`}
              >
                Getting Started
              </button>
            </div>
          </div>
        </section>

        {/* Main Content */}
        <main className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
          {/* Definition Section */}
          {activeTab === 'definition' && (
            <section className="space-y-8">
              <div className="bg-white rounded-lg shadow-lg p-8">
                <h2 className="text-3xl font-bold mb-6 text-gray-900">What is Njangi?</h2>
                <p className="text-lg text-gray-700 mb-6">
                  <strong>Njangi</strong> (pronounced &ldquo;n-JAHN-gee&rdquo;) is a Cameroon-originated rotating savings and credit association 
                  where a group of trusted individuals contribute fixed amounts regularly to a common pool. Each cycle, one member 
                  receives the entire collected amount, continuing until everyone has received their turn.
                </p>
                
                <div className="bg-green-50 border-l-4 border-green-400 p-6 mb-6">
                  <h3 className="text-lg font-semibold text-green-800 mb-2">Key Statistics</h3>
                  <ul className="space-y-2 text-green-700">
                    <li>• Over <strong>1 billion people globally</strong> participate in similar systems worldwide</li>
                    <li>• In Cameroon alone, <strong>over 60% of adults</strong> participate in some form of Njangi</li>
                    <li>• More accessible than traditional banking for many communities</li>
                  </ul>
                </div>

                <h3 className="text-2xl font-bold mb-4">Key Characteristics of Njangi</h3>
                <div className="grid md:grid-cols-2 gap-6 mb-8">
                  <div className="space-y-4">
                    <div className="border-l-4 border-green-500 pl-4">
                      <h4 className="font-semibold text-gray-900">Community-based</h4>
                      <p className="text-gray-700">Built on existing social relationships and trust</p>
                    </div>
                    <div className="border-l-4 border-blue-500 pl-4">
                      <h4 className="font-semibold text-gray-900">No interest charges</h4>
                      <p className="text-gray-700">Members help each other without additional fees</p>
                    </div>
                  </div>
                  <div className="space-y-4">
                    <div className="border-l-4 border-purple-500 pl-4">
                      <h4 className="font-semibold text-gray-900">Rotating payouts</h4>
                      <p className="text-gray-700">Fair distribution ensuring everyone benefits</p>
                    </div>
                    <div className="border-l-4 border-orange-500 pl-4">
                      <h4 className="font-semibold text-gray-900">Cultural significance</h4>
                      <p className="text-gray-700">Strengthens community bonds and social capital</p>
                    </div>
                  </div>
                </div>
              </div>
            </section>
          )}

          {/* History Section */}
          {activeTab === 'history' && (
            <section className="space-y-8">
              <div className="bg-white rounded-lg shadow-lg p-8">
                <h2 className="text-3xl font-bold mb-6 text-gray-900">Historical Origins & Cultural Significance</h2>
                
                <h3 className="text-2xl font-bold mb-4">Ancient Roots in West Africa</h3>
                <p className="text-lg text-gray-700 mb-6">
                  Njangi traces its origins to ancient West African financial traditions, with similar systems documented for 
                  <strong> over 1,000 years</strong>. The practice emerged from the fundamental human need for financial cooperation 
                  and community support, particularly in agricultural societies where seasonal cash flows required collective savings strategies.
                </p>

                <div className="bg-blue-50 rounded-lg p-6 mb-6">
                  <h4 className="text-lg font-semibold text-blue-800 mb-3">Cultural Rituals and Practices</h4>
                  <p className="text-blue-700 mb-3">Traditional Njangi meetings involve more than financial transactions:</p>
                  <ul className="space-y-2 text-blue-700">
                    <li>• <strong>Greetings and ceremonies</strong>: Members exchange traditional greetings and share kola nuts</li>
                    <li>• <strong>Community updates</strong>: Meetings serve as social gatherings for news and support</li>
                    <li>• <strong>Collective decision-making</strong>: Group consensus guides important decisions</li>
                    <li>• <strong>Celebration rituals</strong>: Payout recipients often treat the group to food or drinks</li>
                  </ul>
                </div>

                <h3 className="text-2xl font-bold mb-4">Evolution Across Africa</h3>
                <p className="text-gray-700 mb-4">From Cameroon, similar systems spread throughout Africa under different names:</p>
                <div className="grid md:grid-cols-2 gap-4">
                  <div className="bg-gray-50 p-4 rounded-lg">
                    <h4 className="font-semibold">Djanggis</h4>
                    <p className="text-sm text-gray-600">Alternate Cameroon term</p>
                  </div>
                  <div className="bg-gray-50 p-4 rounded-lg">
                    <h4 className="font-semibold">Tontines</h4>
                    <p className="text-sm text-gray-600">French-speaking Africa</p>
                  </div>
                  <div className="bg-gray-50 p-4 rounded-lg">
                    <h4 className="font-semibold">Susus</h4>
                    <p className="text-sm text-gray-600">Ghana, Sierra Leone</p>
                  </div>
                  <div className="bg-gray-50 p-4 rounded-lg">
                    <h4 className="font-semibold">Stokvels</h4>
                    <p className="text-sm text-gray-600">South Africa</p>
                  </div>
                </div>
              </div>
            </section>
          )}

          {/* How It Works Section */}
          {activeTab === 'how-it-works' && (
            <section className="space-y-8">
              <div className="bg-white rounded-lg shadow-lg p-8">
                <h2 className="text-3xl font-bold mb-6 text-gray-900">How Njangi Works: Traditional vs. Blockchain</h2>
                
                <div className="grid lg:grid-cols-2 gap-8 mb-8">
                  <div>
                    <h3 className="text-xl font-bold mb-4 text-gray-900">Traditional Njangi Process</h3>
                    <div className="space-y-4">
                      <div className="flex items-start space-x-3">
                        <div className="bg-green-500 text-white rounded-full w-8 h-8 flex items-center justify-center text-sm font-bold">1</div>
                        <div>
                          <h4 className="font-semibold">Group Formation</h4>
                          <p className="text-gray-600 text-sm">8-20 trusted community members agree to participate</p>
                        </div>
                      </div>
                      <div className="flex items-start space-x-3">
                        <div className="bg-green-500 text-white rounded-full w-8 h-8 flex items-center justify-center text-sm font-bold">2</div>
                        <div>
                          <h4 className="font-semibold">Setting Terms</h4>
                          <p className="text-gray-600 text-sm">Fixed contribution amount and meeting schedule</p>
                        </div>
                      </div>
                      <div className="flex items-start space-x-3">
                        <div className="bg-green-500 text-white rounded-full w-8 h-8 flex items-center justify-center text-sm font-bold">3</div>
                        <div>
                          <h4 className="font-semibold">Regular Meetings</h4>
                          <p className="text-gray-600 text-sm">Members gather to contribute and receive payouts</p>
                        </div>
                      </div>
                      <div className="flex items-start space-x-3">
                        <div className="bg-green-500 text-white rounded-full w-8 h-8 flex items-center justify-center text-sm font-bold">4</div>
                        <div>
                          <h4 className="font-semibold">Rotation Completion</h4>
                          <p className="text-gray-600 text-sm">Process continues until all members receive payouts</p>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div>
                    <h3 className="text-xl font-bold mb-4 text-blue-600">Blockchain-Powered Revolution</h3>
                    <div className="bg-blue-50 p-6 rounded-lg">
                      <h4 className="font-semibold text-blue-800 mb-3">Smart Contract Automation</h4>
                      <ul className="space-y-2 text-blue-700 text-sm">
                        <li>• Contribution tracking happens automatically on-chain</li>
                        <li>• Payout distribution follows predetermined rules</li>
                        <li>• No single point of failure or fraud risk</li>
                        <li>• Complete transaction history immutably recorded</li>
                      </ul>
                    </div>
                  </div>
                </div>

                <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-6">
                  <h3 className="text-lg font-semibold text-yellow-800 mb-3">Traditional Challenges Solved</h3>
                  <div className="grid md:grid-cols-3 gap-4 text-sm">
                    <div>
                      <h4 className="font-medium text-yellow-800">Trust vulnerabilities</h4>
                      <p className="text-yellow-700">→ Cryptographic guarantees</p>
                    </div>
                    <div>
                      <h4 className="font-medium text-yellow-800">Geographic constraints</h4>
                      <p className="text-yellow-700">→ Global accessibility</p>
                    </div>
                    <div>
                      <h4 className="font-medium text-yellow-800">Record-keeping issues</h4>
                      <p className="text-yellow-700">→ Immutable blockchain records</p>
                    </div>
                  </div>
                </div>
              </div>
            </section>
          )}

          {/* Getting Started Section */}
          {activeTab === 'getting-started' && (
            <section className="space-y-8">
              <div className="bg-white rounded-lg shadow-lg p-8">
                <h2 className="text-3xl font-bold mb-6 text-gray-900">Getting Started with Digital Njangi</h2>
                
                <div className="grid md:grid-cols-2 gap-8 mb-8">
                  <div>
                    <h3 className="text-xl font-bold mb-4">Step-by-Step Onboarding</h3>
                    <div className="space-y-4">
                      <div className="border border-gray-200 rounded-lg p-4">
                        <h4 className="font-semibold text-green-600 mb-2">1. Account Creation</h4>
                        <p className="text-gray-600 text-sm">
                          Download the Njangi Platform mobile app, complete identity verification, 
                          and set up secure authentication.
                        </p>
                      </div>
                      <div className="border border-gray-200 rounded-lg p-4">
                        <h4 className="font-semibold text-green-600 mb-2">2. Wallet Setup</h4>
                        <p className="text-gray-600 text-sm">
                          Create or connect existing Sui wallet, fund with initial deposit, 
                          and complete blockchain tutorial.
                        </p>
                      </div>
                      <div className="border border-gray-200 rounded-lg p-4">
                        <h4 className="font-semibold text-green-600 mb-2">3. Circle Discovery</h4>
                        <p className="text-gray-600 text-sm">
                          Browse available circles by contribution amount, duration, and location.
                          Review member reputation scores.
                        </p>
                      </div>
                      <div className="border border-gray-200 rounded-lg p-4">
                        <h4 className="font-semibold text-green-600 mb-2">4. Active Participation</h4>
                        <p className="text-gray-600 text-sm">
                          Set up automatic payments, participate in meetings, 
                          and engage with circle community features.
                        </p>
                      </div>
                    </div>
                  </div>

                  <div>
                    <h3 className="text-xl font-bold mb-4">Requirements</h3>
                    <div className="bg-gray-50 p-6 rounded-lg space-y-4">
                      <div>
                        <h4 className="font-semibold text-gray-900">Technical</h4>
                        <ul className="text-sm text-gray-600 mt-2 space-y-1">
                          <li>• Smartphone (iOS 12+ or Android 8+)</li>
                          <li>• Basic cryptocurrency wallet (Sui Wallet)</li>
                          <li>• Government-issued ID for verification</li>
                          <li>• Email and phone number</li>
                        </ul>
                      </div>
                      <div>
                        <h4 className="font-semibold text-gray-900">Financial</h4>
                        <ul className="text-sm text-gray-600 mt-2 space-y-1">
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
                        className="w-full bg-green-600 text-white py-3 px-6 rounded-lg font-semibold hover:bg-green-700 transition-colors flex items-center justify-center"
                      >
                        Start Your Digital Njangi Journey →
                      </Link>
                    </div>
                  </div>
                </div>
              </div>
            </section>
          )}

          {/* Related Content Links */}
          <section className="bg-white rounded-lg shadow-lg p-8 mt-12">
            <h2 className="text-2xl font-bold mb-6 text-gray-900">Related Content</h2>
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
              <Link href="/learn/blockchain-rosca" className="group">
                <div className="border border-gray-200 rounded-lg p-4 hover:border-green-300 hover:shadow-md transition-all">
                  <h3 className="font-semibold text-green-600 group-hover:text-green-700 mb-2">
                    Blockchain ROSCA: The Future of Community Savings
                  </h3>
                  <p className="text-sm text-gray-600">
                    Discover how blockchain technology revolutionizes traditional ROSCAs worldwide.
                  </p>
                </div>
              </Link>
              
              <Link href="/learn/tontine-blockchain" className="group">
                <div className="border border-gray-200 rounded-lg p-4 hover:border-green-300 hover:shadow-md transition-all">
                  <h3 className="font-semibold text-green-600 group-hover:text-green-700 mb-2">
                    Tontine Blockchain: Revolutionizing African Finance
                  </h3>
                  <p className="text-sm text-gray-600">
                    Learn about French African tontine traditions and their blockchain evolution.
                  </p>
                </div>
              </Link>
              
              <Link href="/learn/sou-sou-crypto" className="group">
                <div className="border border-gray-200 rounded-lg p-4 hover:border-green-300 hover:shadow-md transition-all">
                  <h3 className="font-semibold text-green-600 group-hover:text-green-700 mb-2">
                    Sou Sou Crypto: Caribbean Savings Circles
                  </h3>
                  <p className="text-sm text-gray-600">
                    Explore how Caribbean and West African susu traditions meet cryptocurrency.
                  </p>
                </div>
              </Link>
            </div>
          </section>

          {/* CTA Section */}
          <section className="bg-gradient-to-r from-green-600 to-emerald-600 rounded-lg text-white p-8 mt-12 text-center">
            <h2 className="text-2xl font-bold mb-4">Ready to Join the Future of Community Savings?</h2>
            <p className="text-green-100 mb-6">
              Start your digital Njangi journey today and connect with trusted communities worldwide
              with non-custodial coordination and partner-led on/off ramps.
            </p>
            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <Link 
                href="/create-circle"
                className="bg-white text-green-600 px-8 py-3 rounded-lg font-semibold hover:bg-gray-100 transition-colors"
              >
                Start Your Circle
              </Link>
              <Link 
                href="/dashboard"
                className="border-2 border-white text-white px-8 py-3 rounded-lg font-semibold hover:bg-white hover:text-green-600 transition-colors"
              >
                View Dashboard
              </Link>
            </div>
          </section>

          {/* Social Sharing */}
          <section className="text-center mt-8">
            <p className="text-gray-600 mb-4">Share this article:</p>
            <div className="flex justify-center space-x-4">
              <a href="#" className="text-blue-600 hover:text-blue-700">Twitter</a>
              <a href="#" className="text-blue-800 hover:text-blue-900">Facebook</a>
              <a href="#" className="text-blue-700 hover:text-blue-800">LinkedIn</a>
              <a href="#" className="text-green-600 hover:text-green-700">WhatsApp</a>
            </div>
          </section>
        </main>

        {/* Disclaimer */}
        <footer className="bg-gray-100 mt-16">
          <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
            <p className="text-sm text-gray-600 text-center">
              <strong>Disclaimer:</strong> This content is for educational purposes only and does not constitute financial advice. 
              Always consult with qualified financial advisors before making investment decisions.
            </p>
          </div>
        </footer>
      </div>
    </>
  );
} 