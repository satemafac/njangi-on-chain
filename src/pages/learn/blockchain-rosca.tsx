import Head from 'next/head';
import Link from 'next/link';
import { useState } from 'react';

export default function BlockchainRoscaPage() {
  const [activeTab, setActiveTab] = useState('overview');

  return (
    <>
      <Head>
        <title>Blockchain ROSCA: The Future of Community Savings | Digital ROSCA Platform</title>
        <meta name="description" content="Discover how blockchain technology revolutionizes traditional ROSCAs (Rotating Savings and Credit Associations) worldwide. Join secure, transparent digital savings circles." />
        <meta name="keywords" content="blockchain rosca, digital rosca, rotating savings blockchain, community savings, cryptocurrency rosca, smart contract savings" />
        <link rel="canonical" href="https://njangi.com/learn/blockchain-rosca" />
        
        {/* Open Graph / Facebook */}
        <meta property="og:type" content="article" />
        <meta property="og:title" content="Blockchain ROSCA: The Future of Community Savings" />
        <meta property="og:description" content="Discover how blockchain technology revolutionizes traditional ROSCAs worldwide." />
        <meta property="og:url" content="https://njangi.com/learn/blockchain-rosca" />
        <meta property="og:image" content="https://njangi.com/images/blockchain-rosca.jpg" />

        {/* Twitter */}
        <meta property="twitter:card" content="summary_large_image" />
        <meta property="twitter:title" content="Blockchain ROSCA: The Future of Community Savings" />
        <meta property="twitter:description" content="Discover how blockchain technology revolutionizes traditional ROSCAs worldwide." />
        <meta property="twitter:image" content="https://njangi.com/images/blockchain-rosca.jpg" />
      </Head>

      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-purple-50">
        {/* Navigation Breadcrumb */}
        <nav className="bg-white shadow-sm border-b">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex items-center space-x-2 py-3 text-sm text-gray-600">
              <Link href="/" className="hover:text-blue-600 transition-colors">Home</Link>
              <span>/</span>
              <Link href="/learn" className="hover:text-blue-600 transition-colors">Learn</Link>
              <span>/</span>
              <span className="text-gray-900 font-medium">Blockchain ROSCA</span>
            </div>
          </div>
        </nav>

        {/* Hero Section */}
        <section className="relative bg-gradient-to-r from-blue-600 to-purple-600 text-white py-20">
          <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
            <h1 className="text-4xl md:text-5xl font-bold mb-6">
              Blockchain ROSCA: The Future of Community Savings
            </h1>
            <p className="text-xl md:text-2xl mb-8 text-blue-100">
              Transforming traditional <strong>Rotating Savings and Credit Associations (ROSCAs)</strong> through 
              blockchain technology, smart contracts, and decentralized finance. Experience the security and 
              transparency of community savings reimagined for the digital age.
            </p>
            <div className="flex flex-col sm:flex-row gap-4">
              <Link 
                href="/create-circle" 
                className="bg-white text-blue-600 px-8 py-3 rounded-lg font-semibold hover:bg-gray-100 transition-colors text-center"
              >
                Start Your Digital ROSCA →
              </Link>
              <Link 
                href="/dashboard" 
                className="border-2 border-white text-white px-8 py-3 rounded-lg font-semibold hover:bg-white hover:text-blue-600 transition-colors text-center"
              >
                Explore Platform
              </Link>
            </div>
          </div>
        </section>

        {/* Quick Stats */}
        <section className="bg-white border-b">
          <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-6 text-center">
              <div>
                <div className="text-3xl font-bold text-blue-600">1B+</div>
                <div className="text-sm text-gray-600">Global ROSCA participants</div>
              </div>
              <div>
                <div className="text-3xl font-bold text-green-600">200+</div>
                <div className="text-sm text-gray-600">Countries with ROSCAs</div>
              </div>
              <div>
                <div className="text-3xl font-bold text-purple-600">$500B+</div>
                <div className="text-sm text-gray-600">Annual ROSCA volume</div>
              </div>
              <div>
                <div className="text-3xl font-bold text-orange-600">8%</div>
                <div className="text-sm text-gray-600">Average DeFi yields</div>
              </div>
            </div>
          </div>
        </section>

        {/* Main Navigation */}
        <section className="bg-white border-b">
          <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
            <div className="flex flex-wrap gap-4">
              <button 
                onClick={() => setActiveTab('overview')}
                className={`px-4 py-2 rounded-lg transition-colors ${activeTab === 'overview' ? 'bg-blue-100 text-blue-700' : 'hover:bg-gray-100'}`}
              >
                ROSCA Overview
              </button>
              <button 
                onClick={() => setActiveTab('global')}
                className={`px-4 py-2 rounded-lg transition-colors ${activeTab === 'global' ? 'bg-blue-100 text-blue-700' : 'hover:bg-gray-100'}`}
              >
                Global Systems
              </button>
              <button 
                onClick={() => setActiveTab('blockchain')}
                className={`px-4 py-2 rounded-lg transition-colors ${activeTab === 'blockchain' ? 'bg-blue-100 text-blue-700' : 'hover:bg-gray-100'}`}
              >
                Blockchain Revolution
              </button>
              <button 
                onClick={() => setActiveTab('implementation')}
                className={`px-4 py-2 rounded-lg transition-colors ${activeTab === 'implementation' ? 'bg-blue-100 text-blue-700' : 'hover:bg-gray-100'}`}
              >
                Implementation
              </button>
            </div>
          </div>
        </section>

        {/* Main Content */}
        <main className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
          {/* Overview Section */}
          {activeTab === 'overview' && (
            <section className="space-y-8">
              <div className="bg-white rounded-lg shadow-lg p-8">
                <h2 className="text-3xl font-bold mb-6 text-gray-900">What are ROSCAs?</h2>
                <p className="text-lg text-gray-700 mb-6">
                  <strong>Rotating Savings and Credit Associations (ROSCAs)</strong> are informal financial cooperatives 
                  where groups of individuals contribute fixed amounts regularly to a common fund. Members take turns 
                  receiving the entire pooled amount, creating a rotating credit system that provides access to larger 
                  sums of money without traditional banking requirements.
                </p>
                
                <div className="grid md:grid-cols-2 gap-8 mb-8">
                  <div className="bg-blue-50 p-6 rounded-lg">
                    <h3 className="text-xl font-semibold text-blue-800 mb-4">Core Characteristics</h3>
                    <ul className="space-y-2 text-blue-700">
                      <li>• Fixed, regular contributions from all members</li>
                      <li>• Rotating payout system ensuring fair distribution</li>
                      <li>• Trust-based community membership</li>
                      <li>• No interest charges or traditional banking requirements</li>
                      <li>• Social and financial support network</li>
                    </ul>
                  </div>
                  
                  <div className="bg-green-50 p-6 rounded-lg">
                    <h3 className="text-xl font-semibold text-green-800 mb-4">Global Impact</h3>
                    <ul className="space-y-2 text-green-700">
                      <li>• Serving 1+ billion people worldwide</li>
                      <li>• Critical for unbanked populations</li>
                      <li>• Supporting microenterprise development</li>
                      <li>• Empowering women&rsquo;s economic participation</li>
                      <li>• Preserving cultural financial traditions</li>
                    </ul>
                  </div>
                </div>

                <h3 className="text-2xl font-bold mb-4">How Traditional ROSCAs Work</h3>
                <div className="bg-gray-50 p-6 rounded-lg">
                  <div className="grid md:grid-cols-4 gap-4 text-center">
                    <div>
                      <div className="bg-blue-500 text-white rounded-full w-12 h-12 flex items-center justify-center mx-auto mb-2 text-lg font-bold">1</div>
                      <h4 className="font-semibold">Group Formation</h4>
                      <p className="text-sm text-gray-600">8-20 trusted members agree to participate</p>
                    </div>
                    <div>
                      <div className="bg-green-500 text-white rounded-full w-12 h-12 flex items-center justify-center mx-auto mb-2 text-lg font-bold">2</div>
                      <h4 className="font-semibold">Regular Contributions</h4>
                      <p className="text-sm text-gray-600">Fixed amounts collected weekly/monthly</p>
                    </div>
                    <div>
                      <div className="bg-purple-500 text-white rounded-full w-12 h-12 flex items-center justify-center mx-auto mb-2 text-lg font-bold">3</div>
                      <h4 className="font-semibold">Rotating Payouts</h4>
                      <p className="text-sm text-gray-600">Members take turns receiving full amount</p>
                    </div>
                    <div>
                      <div className="bg-orange-500 text-white rounded-full w-12 h-12 flex items-center justify-center mx-auto mb-2 text-lg font-bold">4</div>
                      <h4 className="font-semibold">Cycle Completion</h4>
                      <p className="text-sm text-gray-600">Process continues until all receive payouts</p>
                    </div>
                  </div>
                </div>
              </div>
            </section>
          )}

          {/* Global Systems Section */}
          {activeTab === 'global' && (
            <section className="space-y-8">
              <div className="bg-white rounded-lg shadow-lg p-8">
                <h2 className="text-3xl font-bold mb-6 text-gray-900">ROSCAs Around the World</h2>
                
                <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6 mb-8">
                  <div className="border border-gray-200 rounded-lg p-4">
                    <h3 className="font-semibold text-lg mb-2">Africa</h3>
                    <ul className="text-sm space-y-1">
                      <li><strong>Njangi</strong> - Cameroon</li>
                      <li><strong>Tontines</strong> - French Africa</li>
                      <li><strong>Susu</strong> - Ghana, Sierra Leone</li>
                      <li><strong>Stokvels</strong> - South Africa</li>
                      <li><strong>Chit Funds</strong> - Kenya</li>
                    </ul>
                  </div>
                  
                  <div className="border border-gray-200 rounded-lg p-4">
                    <h3 className="font-semibold text-lg mb-2">Asia</h3>
                    <ul className="text-sm space-y-1">
                      <li><strong>Chit Funds</strong> - India</li>
                      <li><strong>Hui</strong> - China</li>
                      <li><strong>Kye</strong> - Korea</li>
                      <li><strong>Paluwagan</strong> - Philippines</li>
                      <li><strong>Arisan</strong> - Indonesia</li>
                    </ul>
                  </div>
                  
                  <div className="border border-gray-200 rounded-lg p-4">
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

                <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-6">
                  <h3 className="text-lg font-semibold text-yellow-800 mb-3">Common Challenges Across All Systems</h3>
                  <div className="grid md:grid-cols-2 gap-4 text-sm text-yellow-700">
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
                        <li>• No yield generation</li>
                        <li>• Limited scalability</li>
                      </ul>
                    </div>
                  </div>
                </div>
              </div>
            </section>
          )}

          {/* Blockchain Revolution Section */}
          {activeTab === 'blockchain' && (
            <section className="space-y-8">
              <div className="bg-white rounded-lg shadow-lg p-8">
                <h2 className="text-3xl font-bold mb-6 text-gray-900">Blockchain Technology Revolution</h2>
                
                <div className="mb-8">
                  <h3 className="text-2xl font-bold mb-4">Smart Contract Automation</h3>
                  <div className="bg-gray-100 p-4 rounded-lg font-mono text-sm overflow-x-auto">
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
                    <h3 className="text-xl font-bold mb-4 text-blue-600">Traditional ROSCA Problems</h3>
                    <div className="space-y-3">
                      <div className="flex items-start space-x-3">
                        <div className="w-2 h-2 bg-red-500 rounded-full mt-2"></div>
                        <div>
                          <h4 className="font-semibold text-gray-900">Trust Vulnerabilities</h4>
                          <p className="text-sm text-gray-600">Single points of failure, fraud risks</p>
                        </div>
                      </div>
                      <div className="flex items-start space-x-3">
                        <div className="w-2 h-2 bg-red-500 rounded-full mt-2"></div>
                        <div>
                          <h4 className="font-semibold text-gray-900">Geographic Limitations</h4>
                          <p className="text-sm text-gray-600">Physical meetings, local membership only</p>
                        </div>
                      </div>
                      <div className="flex items-start space-x-3">
                        <div className="w-2 h-2 bg-red-500 rounded-full mt-2"></div>
                        <div>
                          <h4 className="font-semibold text-gray-900">No Returns</h4>
                          <p className="text-sm text-gray-600">Funds earn no interest while pooled</p>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div>
                    <h3 className="text-xl font-bold mb-4 text-green-600">Blockchain Solutions</h3>
                    <div className="space-y-3">
                      <div className="flex items-start space-x-3">
                        <div className="w-2 h-2 bg-green-500 rounded-full mt-2"></div>
                        <div>
                          <h4 className="font-semibold text-gray-900">Cryptographic Security</h4>
                          <p className="text-sm text-gray-600">Immutable, transparent, automated</p>
                        </div>
                      </div>
                      <div className="flex items-start space-x-3">
                        <div className="w-2 h-2 bg-green-500 rounded-full mt-2"></div>
                        <div>
                          <h4 className="font-semibold text-gray-900">Global Accessibility</h4>
                          <p className="text-sm text-gray-600">24/7 availability, cross-border participation</p>
                        </div>
                      </div>
                      <div className="flex items-start space-x-3">
                        <div className="w-2 h-2 bg-green-500 rounded-full mt-2"></div>
                        <div>
                          <h4 className="font-semibold text-gray-900">DeFi Yield Generation</h4>
                          <p className="text-sm text-gray-600">3-8% annual returns on pooled funds</p>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="bg-blue-50 p-6 rounded-lg">
                  <h3 className="text-lg font-semibold text-blue-800 mb-3">Key Blockchain Advantages</h3>
                  <div className="grid md:grid-cols-3 gap-4 text-sm text-blue-700">
                    <div>
                      <h4 className="font-medium">Transparency</h4>
                      <p>All transactions publicly verifiable on blockchain</p>
                    </div>
                    <div>
                      <h4 className="font-medium">Automation</h4>
                      <p>Smart contracts eliminate human error and bias</p>
                    </div>
                    <div>
                      <h4 className="font-medium">Scalability</h4>
                      <p>No size limits, global membership possible</p>
                    </div>
                  </div>
                </div>
              </div>
            </section>
          )}

          {/* Implementation Section */}
          {activeTab === 'implementation' && (
            <section className="space-y-8">
              <div className="bg-white rounded-lg shadow-lg p-8">
                <h2 className="text-3xl font-bold mb-6 text-gray-900">Getting Started with Blockchain ROSCAs</h2>
                
                <div className="grid md:grid-cols-2 gap-8 mb-8">
                  <div>
                    <h3 className="text-xl font-bold mb-4">Platform Features</h3>
                    <div className="space-y-4">
                      <div className="border border-gray-200 rounded-lg p-4">
                        <h4 className="font-semibold text-blue-600 mb-2">Multi-Cultural Support</h4>
                        <p className="text-sm text-gray-600">
                          Supporting traditional ROSCA formats from around the world with 
                          culturally appropriate features and ceremonies.
                        </p>
                      </div>
                      <div className="border border-gray-200 rounded-lg p-4">
                        <h4 className="font-semibold text-green-600 mb-2">DeFi Integration</h4>
                        <p className="text-sm text-gray-600">
                          Automatic yield generation through conservative DeFi strategies 
                          while maintaining security and liquidity.
                        </p>
                      </div>
                      <div className="border border-gray-200 rounded-lg p-4">
                        <h4 className="font-semibold text-purple-600 mb-2">Global Accessibility</h4>
                        <p className="text-sm text-gray-600">
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
                        <div className="bg-blue-500 text-white rounded-full w-6 h-6 flex items-center justify-center text-sm font-bold">1</div>
                        <span className="text-sm">Set up cryptocurrency wallet (Sui Wallet recommended)</span>
                      </div>
                      <div className="flex items-center space-x-3">
                        <div className="bg-green-500 text-white rounded-full w-6 h-6 flex items-center justify-center text-sm font-bold">2</div>
                        <span className="text-sm">Complete identity verification and KYC process</span>
                      </div>
                      <div className="flex items-center space-x-3">
                        <div className="bg-purple-500 text-white rounded-full w-6 h-6 flex items-center justify-center text-sm font-bold">3</div>
                        <span className="text-sm">Browse available circles or create your own</span>
                      </div>
                      <div className="flex items-center space-x-3">
                        <div className="bg-orange-500 text-white rounded-full w-6 h-6 flex items-center justify-center text-sm font-bold">4</div>
                        <span className="text-sm">Deposit security fund and start participating</span>
                      </div>
                    </div>

                    <div className="mt-6 space-y-3">
                      <Link 
                        href="/create-circle"
                        className="w-full bg-blue-600 text-white py-3 px-6 rounded-lg font-semibold hover:bg-blue-700 transition-colors flex items-center justify-center"
                      >
                        Create Your Circle
                      </Link>
                      <Link 
                        href="/dashboard"
                        className="w-full border border-blue-600 text-blue-600 py-3 px-6 rounded-lg font-semibold hover:bg-blue-50 transition-colors flex items-center justify-center"
                      >
                        Browse Existing Circles
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
              <Link href="/learn/what-is-njangi" className="group">
                <div className="border border-gray-200 rounded-lg p-4 hover:border-blue-300 hover:shadow-md transition-all">
                  <h3 className="font-semibold text-blue-600 group-hover:text-blue-700 mb-2">
                    What is Njangi? Cameroon&rsquo;s Savings Circle
                  </h3>
                  <p className="text-sm text-gray-600">
                    Learn about Cameroon&rsquo;s traditional Njangi system and its blockchain transformation.
                  </p>
                </div>
              </Link>
              
              <Link href="/learn/tontine-blockchain" className="group">
                <div className="border border-gray-200 rounded-lg p-4 hover:border-blue-300 hover:shadow-md transition-all">
                  <h3 className="font-semibold text-blue-600 group-hover:text-blue-700 mb-2">
                    Tontine Blockchain: African Finance Revolution
                  </h3>
                  <p className="text-sm text-gray-600">
                    Discover how French African tontine traditions meet modern blockchain technology.
                  </p>
                </div>
              </Link>
              
              <Link href="/learn/sou-sou-crypto" className="group">
                <div className="border border-gray-200 rounded-lg p-4 hover:border-blue-300 hover:shadow-md transition-all">
                  <h3 className="font-semibold text-blue-600 group-hover:text-blue-700 mb-2">
                    Sou Sou Crypto: Caribbean Savings Circles
                  </h3>
                  <p className="text-sm text-gray-600">
                    Explore how Caribbean and West African susu traditions embrace cryptocurrency.
                  </p>
                </div>
              </Link>
            </div>
          </section>

          {/* CTA Section */}
          <section className="bg-gradient-to-r from-blue-600 to-purple-600 rounded-lg text-white p-8 mt-12 text-center">
            <h2 className="text-2xl font-bold mb-4">Ready to Join the Blockchain ROSCA Revolution?</h2>
            <p className="text-blue-100 mb-6">
              Experience the future of community savings with transparent, secure, and globally accessible 
              rotating savings circles powered by blockchain technology.
            </p>
            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <Link 
                href="/create-circle"
                className="bg-white text-blue-600 px-8 py-3 rounded-lg font-semibold hover:bg-gray-100 transition-colors"
              >
                Start Your Circle
              </Link>
              <Link 
                href="/dashboard"
                className="border-2 border-white text-white px-8 py-3 rounded-lg font-semibold hover:bg-white hover:text-blue-600 transition-colors"
              >
                Explore Platform
              </Link>
            </div>
          </section>
        </main>

        {/* Footer Disclaimer */}
        <footer className="bg-gray-100 mt-16">
          <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
            <p className="text-sm text-gray-600 text-center">
              <strong>Disclaimer:</strong> This content is for educational purposes only and does not constitute financial advice. 
              Cryptocurrency investments carry risks. Always consult with qualified financial advisors before making investment decisions.
            </p>
          </div>
        </footer>
      </div>
    </>
  );
} 