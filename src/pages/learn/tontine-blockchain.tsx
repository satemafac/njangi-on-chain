import Head from 'next/head';
import Link from 'next/link';
import { useState } from 'react';

export default function TontineBlockchainPage() {
  const [activeSection, setActiveSection] = useState('overview');

  return (
    <>
      <Head>
        <title>Tontine Blockchain: Revolutionizing African Finance | Digital Tontine Platform</title>
        <meta name="description" content="Discover how blockchain technology transforms traditional African tontines into secure, transparent digital savings circles. Learn about French African tontine traditions." />
        <meta name="keywords" content="tontine blockchain, digital tontine, african tontine, blockchain tontine, crypto tontine, tontine smart contract, african savings circle blockchain" />
        <link rel="canonical" href="https://njangionchain.com/learn/tontine-blockchain" />
      </Head>

      <div className="min-h-screen bg-gradient-to-br from-purple-50 to-pink-50">
        {/* Navigation */}
        <nav className="bg-white shadow-sm border-b">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex items-center space-x-2 py-3 text-sm text-gray-600">
              <Link href="/" className="hover:text-purple-600 transition-colors">Home</Link>
              <span>/</span>
              <Link href="/learn" className="hover:text-purple-600 transition-colors">Learn</Link>
              <span>/</span>
              <span className="text-gray-900 font-medium">Tontine Blockchain</span>
            </div>
          </div>
        </nav>

        {/* Hero */}
        <section className="bg-gradient-to-r from-purple-600 to-pink-600 text-white py-20">
          <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
            <h1 className="text-4xl md:text-5xl font-bold mb-6">
              Tontine Blockchain: Transforming African Community Finance
            </h1>
            <p className="text-xl md:text-2xl mb-8 text-purple-100">
              Discover how blockchain technology revolutionizes traditional African tontines—community 
              savings circles that have powered grassroots finance across French-speaking Africa for centuries.
            </p>
            <div className="flex flex-col sm:flex-row gap-4">
              <Link 
                href="/create-circle" 
                className="bg-white text-purple-600 px-8 py-3 rounded-lg font-semibold hover:bg-gray-100 transition-colors text-center"
              >
                Start Your Digital Tontine →
              </Link>
              <Link 
                href="/dashboard" 
                className="border-2 border-white text-white px-8 py-3 rounded-lg font-semibold hover:bg-white hover:text-purple-600 transition-colors text-center"
              >
                Explore Platform
              </Link>
            </div>
          </div>
        </section>

        {/* Navigation Tabs */}
        <section className="bg-white border-b">
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
                      ? 'bg-purple-100 text-purple-700' 
                      : 'hover:bg-gray-100'
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
          {activeSection === 'overview' && (
            <section className="space-y-8">
              <div className="bg-white rounded-lg shadow-lg p-8">
                <h2 className="text-3xl font-bold mb-6 text-gray-900">What is a Tontine?</h2>
                <p className="text-lg text-gray-700 mb-6">
                  A <strong>tontine</strong> is a traditional rotating savings and credit association prevalent 
                  throughout French-speaking Africa, where community members regularly contribute fixed amounts 
                  to a common fund. Each cycle, one member receives the entire collected amount, continuing 
                  until all participants have received their payout.
                </p>
                
                <div className="grid md:grid-cols-2 gap-8 mb-8">
                  <div className="bg-purple-50 p-6 rounded-lg">
                    <h3 className="text-xl font-semibold text-purple-800 mb-4">Cultural Significance</h3>
                    <ul className="space-y-2 text-purple-700">
                      <li>• Ubuntu philosophy: Community interdependence</li>
                      <li>• Collective prosperity benefits entire group</li>
                      <li>• Social capital building beyond finance</li>
                      <li>• Cultural preservation in modern contexts</li>
                    </ul>
                  </div>
                  
                  <div className="bg-pink-50 p-6 rounded-lg">
                    <h3 className="text-xl font-semibold text-pink-800 mb-4">Economic Impact</h3>
                    <ul className="space-y-2 text-pink-700">
                      <li>• Over 100 million Africans participate</li>
                      <li>• $50+ billion mobilized annually</li>
                      <li>• 75% of members are women</li>
                      <li>• 40% of businesses funded through tontines</li>
                    </ul>
                  </div>
                </div>

                <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-6">
                  <h3 className="text-lg font-semibold text-yellow-800 mb-3">Traditional Tontine Process</h3>
                  <div className="grid md:grid-cols-4 gap-4 text-sm text-yellow-700">
                    <div className="text-center">
                      <div className="bg-yellow-500 text-white rounded-full w-8 h-8 flex items-center justify-center mx-auto mb-2 font-bold">1</div>
                      <div className="font-medium">Group Formation</div>
                      <div className="text-xs">Trusted community members join</div>
                    </div>
                    <div className="text-center">
                      <div className="bg-yellow-500 text-white rounded-full w-8 h-8 flex items-center justify-center mx-auto mb-2 font-bold">2</div>
                      <div className="font-medium">Regular Contributions</div>
                      <div className="text-xs">Fixed amounts collected</div>
                    </div>
                    <div className="text-center">
                      <div className="bg-yellow-500 text-white rounded-full w-8 h-8 flex items-center justify-center mx-auto mb-2 font-bold">3</div>
                      <div className="font-medium">Rotating Payouts</div>
                      <div className="text-xs">Members receive full amount</div>
                    </div>
                    <div className="text-center">
                      <div className="bg-yellow-500 text-white rounded-full w-8 h-8 flex items-center justify-center mx-auto mb-2 font-bold">4</div>
                      <div className="font-medium">Cycle Completion</div>
                      <div className="text-xs">Process continues until all paid</div>
                    </div>
                  </div>
                </div>
              </div>
            </section>
          )}

          {activeSection === 'regional' && (
            <section className="space-y-8">
              <div className="bg-white rounded-lg shadow-lg p-8">
                <h2 className="text-3xl font-bold mb-6 text-gray-900">Tontine Traditions Across Francophone Africa</h2>
                
                <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6 mb-8">
                  <div className="border border-gray-200 rounded-lg p-4">
                    <h3 className="font-semibold text-lg mb-2 text-purple-600">West Africa</h3>
                    <ul className="text-sm space-y-1">
                      <li><strong>Senegal</strong> - Tontines & Nawétanes</li>
                      <li><strong>Mali</strong> - Ton & Community Savings</li>
                      <li><strong>Burkina Faso</strong> - Caisses Populaires</li>
                      <li><strong>Côte d&rsquo;Ivoire</strong> - Urban Professional Groups</li>
                    </ul>
                  </div>
                  
                  <div className="border border-gray-200 rounded-lg p-4">
                    <h3 className="font-semibold text-lg mb-2 text-pink-600">Central Africa</h3>
                    <ul className="text-sm space-y-1">
                      <li><strong>Cameroon</strong> - Tontines & Njangis</li>
                      <li><strong>CAR</strong> - Community Solidarity</li>
                      <li><strong>Gabon</strong> - Associations Tournantes</li>
                      <li><strong>Chad</strong> - Cross-border Networks</li>
                    </ul>
                  </div>
                  
                  <div className="border border-gray-200 rounded-lg p-4">
                    <h3 className="font-semibold text-lg mb-2 text-orange-600">Island Nations</h3>
                    <ul className="text-sm space-y-1">
                      <li><strong>Madagascar</strong> - Fihavanana Circles</li>
                      <li><strong>Comoros</strong> - Islamic Tontines</li>
                      <li><strong>Mauritius</strong> - Multi-cultural Groups</li>
                      <li><strong>Seychelles</strong> - Tourism Worker Circles</li>
                    </ul>
                  </div>
                </div>

                <div className="bg-blue-50 p-6 rounded-lg">
                  <h3 className="text-lg font-semibold text-blue-800 mb-3">Regional Specializations</h3>
                  <div className="grid md:grid-cols-2 gap-4 text-sm text-blue-700">
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
          )}

          {activeSection === 'blockchain' && (
            <section className="space-y-8">
              <div className="bg-white rounded-lg shadow-lg p-8">
                <h2 className="text-3xl font-bold mb-6 text-gray-900">Blockchain Technology Revolution</h2>
                
                <div className="grid md:grid-cols-2 gap-8 mb-8">
                  <div>
                    <h3 className="text-xl font-bold mb-4 text-red-600">Traditional Challenges</h3>
                    <div className="space-y-3">
                      <div className="flex items-start space-x-3">
                        <div className="w-2 h-2 bg-red-500 rounded-full mt-2"></div>
                        <div>
                          <h4 className="font-semibold text-gray-900">Trust Vulnerabilities</h4>
                          <p className="text-sm text-gray-600">Single treasurer risk, potential fraud</p>
                        </div>
                      </div>
                      <div className="flex items-start space-x-3">
                        <div className="w-2 h-2 bg-red-500 rounded-full mt-2"></div>
                        <div>
                          <h4 className="font-semibold text-gray-900">Geographic Constraints</h4>
                          <p className="text-sm text-gray-600">Physical meetings required, distance barriers</p>
                        </div>
                      </div>
                      <div className="flex items-start space-x-3">
                        <div className="w-2 h-2 bg-red-500 rounded-full mt-2"></div>
                        <div>
                          <h4 className="font-semibold text-gray-900">No Yield Generation</h4>
                          <p className="text-sm text-gray-600">Funds earn no returns while pooled</p>
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
                          <h4 className="font-semibold text-gray-900">Trustless Architecture</h4>
                          <p className="text-sm text-gray-600">Smart contracts eliminate intermediaries</p>
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

                <div className="bg-gray-100 p-4 rounded-lg font-mono text-sm overflow-x-auto mb-6">
                  <pre>{`// Smart Contract for African Tontine
struct AfricanTontine {
    members: vector<TontineMember>,
    contribution_amount: u64,
    cultural_fund: Balance<USDC>,
    yield_strategy: u8, // Conservative, Moderate, Aggressive
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

                <div className="bg-green-50 p-6 rounded-lg">
                  <h3 className="text-lg font-semibold text-green-800 mb-3">Key Blockchain Advantages</h3>
                  <div className="grid md:grid-cols-3 gap-4 text-sm text-green-700">
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
          )}

          {activeSection === 'implementation' && (
            <section className="space-y-8">
              <div className="bg-white rounded-lg shadow-lg p-8">
                <h2 className="text-3xl font-bold mb-6 text-gray-900">Getting Started with Digital Tontines</h2>
                
                <div className="grid md:grid-cols-2 gap-8 mb-8">
                  <div>
                    <h3 className="text-xl font-bold mb-4">Step-by-Step Process</h3>
                    <div className="space-y-4">
                      <div className="border border-gray-200 rounded-lg p-4">
                        <h4 className="font-semibold text-purple-600 mb-2">1. Cultural Registration</h4>
                        <p className="text-sm text-gray-600">
                          Select your region (Senegal, Mali, Cameroon, etc.) and cultural preferences.
                        </p>
                      </div>
                      <div className="border border-gray-200 rounded-lg p-4">
                        <h4 className="font-semibold text-purple-600 mb-2">2. Financial Setup</h4>
                        <p className="text-sm text-gray-600">
                          Connect your Sui wallet and fund with USDC or local currency equivalent.
                        </p>
                      </div>
                      <div className="border border-gray-200 rounded-lg p-4">
                        <h4 className="font-semibold text-purple-600 mb-2">3. Community Matching</h4>
                        <p className="text-sm text-gray-600">
                          Find tontines based on contribution amount, duration, and cultural background.
                        </p>
                      </div>
                      <div className="border border-gray-200 rounded-lg p-4">
                        <h4 className="font-semibold text-purple-600 mb-2">4. Active Participation</h4>
                        <p className="text-sm text-gray-600">
                          Set up automatic payments and engage with virtual community features.
                        </p>
                      </div>
                    </div>
                  </div>

                  <div>
                    <h3 className="text-xl font-bold mb-4">Platform Features</h3>
                    <div className="bg-gray-50 p-6 rounded-lg space-y-4">
                      <div>
                        <h4 className="font-semibold text-gray-900">Multi-Currency Support</h4>
                        <p className="text-sm text-gray-600 mt-1">
                          USDC, CFA francs, and other African currencies with automatic conversion.
                        </p>
                      </div>
                      <div>
                        <h4 className="font-semibold text-gray-900">Cultural Integration</h4>
                        <p className="text-sm text-gray-600 mt-1">
                          Virtual ceremonies, traditional greetings, and community celebrations.
                        </p>
                      </div>
                      <div>
                        <h4 className="font-semibold text-gray-900">Yield Strategies</h4>
                        <p className="text-sm text-gray-600 mt-1">
                          Conservative to aggressive DeFi strategies for additional returns.
                        </p>
                      </div>
                    </div>

                    <div className="mt-6 space-y-3">
                      <Link 
                        href="/create-circle"
                        className="w-full bg-purple-600 text-white py-3 px-6 rounded-lg font-semibold hover:bg-purple-700 transition-colors flex items-center justify-center"
                      >
                        Create Your Tontine
                      </Link>
                      <Link 
                        href="/dashboard"
                        className="w-full border border-purple-600 text-purple-600 py-3 px-6 rounded-lg font-semibold hover:bg-purple-50 transition-colors flex items-center justify-center"
                      >
                        Browse Existing Tontines
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
                <div className="border border-gray-200 rounded-lg p-4 hover:border-purple-300 hover:shadow-md transition-all">
                  <h3 className="font-semibold text-purple-600 group-hover:text-purple-700 mb-2">
                    What is Njangi? Cameroon&rsquo;s Savings Circle
                  </h3>
                  <p className="text-sm text-gray-600">
                    Learn about Cameroon&rsquo;s traditional Njangi system and its blockchain transformation.
                  </p>
                </div>
              </Link>
              
              <Link href="/learn/blockchain-rosca" className="group">
                <div className="border border-gray-200 rounded-lg p-4 hover:border-purple-300 hover:shadow-md transition-all">
                  <h3 className="font-semibold text-purple-600 group-hover:text-purple-700 mb-2">
                    Blockchain ROSCA: The Future of Community Savings
                  </h3>
                  <p className="text-sm text-gray-600">
                    Discover how blockchain technology revolutionizes traditional ROSCAs worldwide.
                  </p>
                </div>
              </Link>
              
              <Link href="/learn/sou-sou-crypto" className="group">
                <div className="border border-gray-200 rounded-lg p-4 hover:border-purple-300 hover:shadow-md transition-all">
                  <h3 className="font-semibold text-purple-600 group-hover:text-purple-700 mb-2">
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
          <section className="bg-gradient-to-r from-purple-600 to-pink-600 rounded-lg text-white p-8 mt-12 text-center">
            <h2 className="text-2xl font-bold mb-4">Ready to Join the African Finance Revolution?</h2>
            <p className="text-purple-100 mb-6">
              Start your digital tontine journey today and connect with African communities worldwide 
              while preserving cultural traditions and earning yields on your contributions.
            </p>
            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <Link 
                href="/create-circle"
                className="bg-white text-purple-600 px-8 py-3 rounded-lg font-semibold hover:bg-gray-100 transition-colors"
              >
                Start Your Tontine
              </Link>
              <Link 
                href="/dashboard"
                className="border-2 border-white text-white px-8 py-3 rounded-lg font-semibold hover:bg-white hover:text-purple-600 transition-colors"
              >
                Explore Platform
              </Link>
            </div>
          </section>
        </main>

        {/* Footer */}
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