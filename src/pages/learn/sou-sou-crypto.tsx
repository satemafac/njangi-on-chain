import Head from 'next/head';
import Link from 'next/link';
import { useState } from 'react';

export default function SouSouCryptoPage() {
  const [activeSection, setActiveSection] = useState('overview');

  return (
    <>
      <Head>
        <title>Sou Sou Crypto: Caribbean & West African Savings Circles Meet Blockchain</title>
        <meta name="description" content="Discover how Sou Sou, Partner, and Susu traditions from the Caribbean and West Africa are revolutionized through cryptocurrency and blockchain technology." />
        <meta name="keywords" content="sou sou crypto, caribbean savings circle, susu blockchain, partner system, west african susu, cryptocurrency savings, sou sou smart contract" />
        <link rel="canonical" href="https://njangionchain.com/learn/sou-sou-crypto" />
      </Head>

      <div className="min-h-screen bg-gradient-to-br from-orange-50 to-red-50">
        {/* Navigation */}
        <nav className="bg-white shadow-sm border-b">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex items-center space-x-2 py-3 text-sm text-gray-600">
              <Link href="/" className="hover:text-orange-600 transition-colors">Home</Link>
              <span>/</span>
              <Link href="/learn" className="hover:text-orange-600 transition-colors">Learn</Link>
              <span>/</span>
              <span className="text-gray-900 font-medium">Sou Sou Crypto</span>
            </div>
          </div>
        </nav>

        {/* Hero */}
        <section className="bg-gradient-to-r from-orange-600 to-red-600 text-white py-20">
          <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
            <h1 className="text-4xl md:text-5xl font-bold mb-6">
              Sou Sou Crypto: Caribbean Savings Circles Meet Blockchain
            </h1>
            <p className="text-xl md:text-2xl mb-8 text-orange-100">
              Explore how traditional Caribbean <strong>Sou Sou</strong>, Jamaican <strong>Partner</strong>, and 
              West African <strong>Susu</strong> savings circles are being transformed through cryptocurrency 
              and smart contract technology, connecting diaspora communities worldwide.
            </p>
            <div className="flex flex-col sm:flex-row gap-4">
              <Link 
                href="/create-circle" 
                className="bg-white text-orange-600 px-8 py-3 rounded-lg font-semibold hover:bg-gray-100 transition-colors text-center"
              >
                Start Your Digital Sou Sou →
              </Link>
              <Link 
                href="/dashboard" 
                className="border-2 border-white text-white px-8 py-3 rounded-lg font-semibold hover:bg-white hover:text-orange-600 transition-colors text-center"
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
                <div className="text-3xl font-bold text-orange-600">45M+</div>
                <div className="text-sm text-gray-600">Caribbean diaspora globally</div>
              </div>
              <div>
                <div className="text-3xl font-bold text-red-600">80%</div>
                <div className="text-sm text-gray-600">Women-led savings circles</div>
              </div>
              <div>
                <div className="text-3xl font-bold text-yellow-600">$25B+</div>
                <div className="text-sm text-gray-600">Annual remittances to Caribbean</div>
              </div>
              <div>
                <div className="text-3xl font-bold text-green-600">15+</div>
                <div className="text-sm text-gray-600">Countries with active traditions</div>
              </div>
            </div>
          </div>
        </section>

        {/* Navigation Tabs */}
        <section className="bg-white border-b">
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
                      ? 'bg-orange-100 text-orange-700' 
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
                <h2 className="text-3xl font-bold mb-6 text-gray-900">What is Sou Sou?</h2>
                <p className="text-lg text-gray-700 mb-6">
                  <strong>Sou Sou</strong> (also spelled &ldquo;Susu&rdquo;) is a Caribbean and West African 
                  community savings practice where trusted groups of people contribute fixed amounts regularly 
                  to a collective fund. Members take turns receiving the full amount, creating a rotating 
                  credit system that enables access to larger sums without traditional banking.
                </p>
                
                <div className="grid md:grid-cols-2 gap-8 mb-8">
                  <div className="bg-orange-50 p-6 rounded-lg">
                    <h3 className="text-xl font-semibold text-orange-800 mb-4">Cultural Heritage</h3>
                    <ul className="space-y-2 text-orange-700">
                      <li>• Brought to Caribbean by enslaved Africans</li>
                      <li>• Maintained through oral tradition</li>
                      <li>• Cornerstone of community resilience</li>
                      <li>• Informal financial institution for generations</li>
                      <li>• Gender-inclusive economic empowerment</li>
                    </ul>
                  </div>
                  
                  <div className="bg-red-50 p-6 rounded-lg">
                    <h3 className="text-xl font-semibold text-red-800 mb-4">Modern Importance</h3>
                    <ul className="space-y-2 text-red-700">
                      <li>• Bridge for unbanked populations</li>
                      <li>• Connects diaspora to homeland</li>
                      <li>• Enables microenterprise development</li>
                      <li>• Emergency financial support network</li>
                      <li>• Preserves cultural identity abroad</li>
                    </ul>
                  </div>
                </div>

                <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-6">
                  <h3 className="text-lg font-semibold text-yellow-800 mb-3">Traditional Sou Sou Structure</h3>
                  <div className="grid md:grid-cols-4 gap-4 text-sm text-yellow-700">
                    <div className="text-center">
                      <div className="bg-yellow-500 text-white rounded-full w-8 h-8 flex items-center justify-center mx-auto mb-2 font-bold">1</div>
                      <div className="font-medium">Community Formation</div>
                      <div className="text-xs">Trusted friends and family join</div>
                    </div>
                    <div className="text-center">
                      <div className="bg-yellow-500 text-white rounded-full w-8 h-8 flex items-center justify-center mx-auto mb-2 font-bold">2</div>
                      <div className="font-medium">Regular Contributions</div>
                      <div className="text-xs">Weekly or monthly fixed amounts</div>
                    </div>
                    <div className="text-center">
                      <div className="bg-yellow-500 text-white rounded-full w-8 h-8 flex items-center justify-center mx-auto mb-2 font-bold">3</div>
                      <div className="font-medium">Rotating &ldquo;Hand&rdquo;</div>
                      <div className="text-xs">Members receive full amount in turn</div>
                    </div>
                    <div className="text-center">
                      <div className="bg-yellow-500 text-white rounded-full w-8 h-8 flex items-center justify-center mx-auto mb-2 font-bold">4</div>
                      <div className="font-medium">Cycle Renewal</div>
                      <div className="text-xs">Process repeats until all members served</div>
                    </div>
                  </div>
                </div>
              </div>
            </section>
          )}

          {activeSection === 'regional' && (
            <section className="space-y-8">
              <div className="bg-white rounded-lg shadow-lg p-8">
                <h2 className="text-3xl font-bold mb-6 text-gray-900">Regional Variations Across the Caribbean & West Africa</h2>
                
                <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6 mb-8">
                  <div className="border border-gray-200 rounded-lg p-4">
                    <h3 className="font-semibold text-lg mb-2 text-orange-600">Greater Antilles</h3>
                    <ul className="text-sm space-y-1">
                      <li><strong>Jamaica</strong> - Partner/Pardner</li>
                      <li><strong>Haiti</strong> - Sol/Association</li>
                      <li><strong>Dominican Republic</strong> - San/Caja</li>
                      <li><strong>Puerto Rico</strong> - Vaca</li>
                      <li><strong>Cuba</strong> - Vaca (Historical)</li>
                    </ul>
                  </div>
                  
                  <div className="border border-gray-200 rounded-lg p-4">
                    <h3 className="font-semibold text-lg mb-2 text-red-600">Lesser Antilles</h3>
                    <ul className="text-sm space-y-1">
                      <li><strong>Trinidad & Tobago</strong> - Sou Sou</li>
                      <li><strong>Barbados</strong> - Meeting Turn</li>
                      <li><strong>Grenada</strong> - Box Money</li>
                      <li><strong>St. Lucia</strong> - Cooperative</li>
                      <li><strong>Dominica</strong> - Sou Sou Circle</li>
                    </ul>
                  </div>
                  
                  <div className="border border-gray-200 rounded-lg p-4">
                    <h3 className="font-semibold text-lg mb-2 text-yellow-600">West Africa Origins</h3>
                    <ul className="text-sm space-y-1">
                      <li><strong>Ghana</strong> - Susu</li>
                      <li><strong>Sierra Leone</strong> - Osusu</li>
                      <li><strong>Nigeria</strong> - Esusu (Yoruba)</li>
                      <li><strong>Gambia</strong> - Osusu</li>
                      <li><strong>Liberia</strong> - Susu (Kru)</li>
                    </ul>
                  </div>
                </div>

                <div className="bg-blue-50 p-6 rounded-lg mb-6">
                  <h3 className="text-lg font-semibold text-blue-800 mb-3">Unique Caribbean Adaptations</h3>
                  <div className="grid md:grid-cols-2 gap-4 text-sm text-blue-700">
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

                <div className="bg-green-50 p-6 rounded-lg">
                  <h3 className="text-lg font-semibold text-green-800 mb-3">Modern Challenges & Adaptations</h3>
                  <div className="grid md:grid-cols-2 gap-4 text-sm text-green-700">
                    <div>
                      <h4 className="font-medium text-red-700">Traditional Challenges</h4>
                      <ul className="mt-2 space-y-1">
                        <li>• Geographic dispersion of families</li>
                        <li>• Currency exchange complications</li>
                        <li>• Trust issues with new members</li>
                        <li>• Limited emergency protections</li>
                      </ul>
                    </div>
                    <div>
                      <h4 className="font-medium text-green-700">Digital Solutions</h4>
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
          )}

          {activeSection === 'blockchain' && (
            <section className="space-y-8">
              <div className="bg-white rounded-lg shadow-lg p-8">
                <h2 className="text-3xl font-bold mb-6 text-gray-900">Cryptocurrency Integration & Smart Contracts</h2>
                
                <div className="mb-8">
                  <h3 className="text-2xl font-bold mb-4">Smart Contract Implementation</h3>
                  <div className="bg-gray-100 p-4 rounded-lg font-mono text-sm overflow-x-auto">
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
                    <h3 className="text-xl font-bold mb-4 text-red-600">Traditional Limitations</h3>
                    <div className="space-y-3">
                      <div className="flex items-start space-x-3">
                        <div className="w-2 h-2 bg-red-500 rounded-full mt-2"></div>
                        <div>
                          <h4 className="font-semibold text-gray-900">Geographic Barriers</h4>
                          <p className="text-sm text-gray-600">Physical meetings, local-only membership</p>
                        </div>
                      </div>
                      <div className="flex items-start space-x-3">
                        <div className="w-2 h-2 bg-red-500 rounded-full mt-2"></div>
                        <div>
                          <h4 className="font-semibold text-gray-900">Currency Exchange</h4>
                          <p className="text-sm text-gray-600">Complex remittance fees and delays</p>
                        </div>
                      </div>
                      <div className="flex items-start space-x-3">
                        <div className="w-2 h-2 bg-red-500 rounded-full mt-2"></div>
                        <div>
                          <h4 className="font-semibold text-gray-900">Trust Dependencies</h4>
                          <p className="text-sm text-gray-600">Single coordinator risk, fraud potential</p>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div>
                    <h3 className="text-xl font-bold mb-4 text-green-600">Blockchain Advantages</h3>
                    <div className="space-y-3">
                      <div className="flex items-start space-x-3">
                        <div className="w-2 h-2 bg-green-500 rounded-full mt-2"></div>
                        <div>
                          <h4 className="font-semibold text-gray-900">Global Accessibility</h4>
                          <p className="text-sm text-gray-600">24/7 participation from anywhere</p>
                        </div>
                      </div>
                      <div className="flex items-start space-x-3">
                        <div className="w-2 h-2 bg-green-500 rounded-full mt-2"></div>
                        <div>
                          <h4 className="font-semibold text-gray-900">Instant Settlements</h4>
                          <p className="text-sm text-gray-600">Immediate transfers, minimal fees</p>
                        </div>
                      </div>
                      <div className="flex items-start space-x-3">
                        <div className="w-2 h-2 bg-green-500 rounded-full mt-2"></div>
                        <div>
                          <h4 className="font-semibold text-gray-900">Automated Trust</h4>
                          <p className="text-sm text-gray-600">Smart contracts ensure fairness</p>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="bg-orange-50 p-6 rounded-lg">
                  <h3 className="text-lg font-semibold text-orange-800 mb-3">Blockchain Features for Caribbean Communities</h3>
                  <div className="grid md:grid-cols-3 gap-4 text-sm text-orange-700">
                    <div>
                      <h4 className="font-medium">Multi-Currency Support</h4>
                      <p>USDC, Caribbean dollars, and cryptocurrencies</p>
                    </div>
                    <div>
                      <h4 className="font-medium">Virtual Ceremonies</h4>
                      <p>Online cultural celebrations and community meetings</p>
                    </div>
                    <div>
                      <h4 className="font-medium">Yield Generation</h4>
                      <p>DeFi strategies earning 3-8% on pooled funds</p>
                    </div>
                  </div>
                </div>
              </div>
            </section>
          )}

          {activeSection === 'diaspora' && (
            <section className="space-y-8">
              <div className="bg-white rounded-lg shadow-lg p-8">
                <h2 className="text-3xl font-bold mb-6 text-gray-900">Connecting Caribbean Diaspora Communities</h2>
                
                <div className="grid md:grid-cols-2 gap-8 mb-8">
                  <div>
                    <h3 className="text-xl font-bold mb-4">Global Caribbean Diaspora</h3>
                    <div className="space-y-4">
                      <div className="border border-gray-200 rounded-lg p-4">
                        <h4 className="font-semibold text-orange-600 mb-2">North America</h4>
                        <ul className="text-sm text-gray-600 space-y-1">
                          <li>• 4M+ in United States (NY, FL, CA)</li>
                          <li>• 800K+ in Canada (Toronto, Montreal)</li>
                          <li>• Strong remittance networks</li>
                        </ul>
                      </div>
                      <div className="border border-gray-200 rounded-lg p-4">
                        <h4 className="font-semibold text-orange-600 mb-2">United Kingdom</h4>
                        <ul className="text-sm text-gray-600 space-y-1">
                          <li>• 1M+ Caribbean-heritage residents</li>
                          <li>• Established community institutions</li>
                          <li>• Cultural preservation initiatives</li>
                        </ul>
                      </div>
                      <div className="border border-gray-200 rounded-lg p-4">
                        <h4 className="font-semibold text-orange-600 mb-2">Other Regions</h4>
                        <ul className="text-sm text-gray-600 space-y-1">
                          <li>• Netherlands (Surinamese communities)</li>
                          <li>• France (Martinique/Guadeloupe diaspora)</li>
                          <li>• Other Caribbean islands (migration)</li>
                        </ul>
                      </div>
                    </div>
                  </div>

                  <div>
                    <h3 className="text-xl font-bold mb-4">Digital Platform Benefits</h3>
                    <div className="bg-gray-50 p-6 rounded-lg space-y-4">
                      <div>
                        <h4 className="font-semibold text-gray-900">Cultural Connection</h4>
                        <p className="text-sm text-gray-600 mt-1">
                          Virtual meetups preserving Caribbean traditions and language, 
                          enabling cultural transmission to new generations.
                        </p>
                      </div>
                      <div>
                        <h4 className="font-semibold text-gray-900">Economic Empowerment</h4>
                        <p className="text-sm text-gray-600 mt-1">
                          Pooled savings for education, business investment, property 
                          purchase, and family support across borders.
                        </p>
                      </div>
                      <div>
                        <h4 className="font-semibold text-gray-900">Emergency Support</h4>
                        <p className="text-sm text-gray-600 mt-1">
                          Rapid response fund for natural disasters, family emergencies, 
                          and unexpected financial hardships.
                        </p>
                      </div>
                    </div>

                    <div className="mt-6 space-y-3">
                      <Link 
                        href="/create-circle"
                        className="w-full bg-orange-600 text-white py-3 px-6 rounded-lg font-semibold hover:bg-orange-700 transition-colors flex items-center justify-center"
                      >
                        Join Diaspora Network
                      </Link>
                      <Link 
                        href="/dashboard"
                        className="w-full border border-orange-600 text-orange-600 py-3 px-6 rounded-lg font-semibold hover:bg-orange-50 transition-colors flex items-center justify-center"
                      >
                        Find Your Community
                      </Link>
                    </div>
                  </div>
                </div>

                <div className="bg-blue-50 p-6 rounded-lg">
                  <h3 className="text-lg font-semibold text-blue-800 mb-3">Success Stories & Use Cases</h3>
                  <div className="grid md:grid-cols-2 gap-4 text-sm text-blue-700">
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
          )}

          {/* Related Content Links */}
          <section className="bg-white rounded-lg shadow-lg p-8 mt-12">
            <h2 className="text-2xl font-bold mb-6 text-gray-900">Related Content</h2>
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
              <Link href="/learn/what-is-njangi" className="group">
                <div className="border border-gray-200 rounded-lg p-4 hover:border-orange-300 hover:shadow-md transition-all">
                  <h3 className="font-semibold text-orange-600 group-hover:text-orange-700 mb-2">
                    What is Njangi? Cameroon&rsquo;s Savings Circle
                  </h3>
                  <p className="text-sm text-gray-600">
                    Learn about Cameroon&rsquo;s traditional Njangi system and its blockchain transformation.
                  </p>
                </div>
              </Link>
              
              <Link href="/learn/blockchain-rosca" className="group">
                <div className="border border-gray-200 rounded-lg p-4 hover:border-orange-300 hover:shadow-md transition-all">
                  <h3 className="font-semibold text-orange-600 group-hover:text-orange-700 mb-2">
                    Blockchain ROSCA: The Future of Community Savings
                  </h3>
                  <p className="text-sm text-gray-600">
                    Discover how blockchain technology revolutionizes traditional ROSCAs worldwide.
                  </p>
                </div>
              </Link>
              
              <Link href="/learn/tontine-blockchain" className="group">
                <div className="border border-gray-200 rounded-lg p-4 hover:border-orange-300 hover:shadow-md transition-all">
                  <h3 className="font-semibold text-orange-600 group-hover:text-orange-700 mb-2">
                    Tontine Blockchain: African Finance Revolution
                  </h3>
                  <p className="text-sm text-gray-600">
                    Explore how French African tontine traditions meet modern blockchain technology.
                  </p>
                </div>
              </Link>
            </div>
          </section>

          {/* CTA Section */}
          <section className="bg-gradient-to-r from-orange-600 to-red-600 rounded-lg text-white p-8 mt-12 text-center">
            <h2 className="text-2xl font-bold mb-4">Ready to Join the Caribbean Savings Revolution?</h2>
            <p className="text-orange-100 mb-6">
              Connect with Caribbean and West African diaspora communities worldwide through 
              secure, transparent digital Sou Sou circles powered by blockchain technology.
            </p>
            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <Link 
                href="/create-circle"
                className="bg-white text-orange-600 px-8 py-3 rounded-lg font-semibold hover:bg-gray-100 transition-colors"
              >
                Start Your Sou Sou
              </Link>
              <Link 
                href="/dashboard"
                className="border-2 border-white text-white px-8 py-3 rounded-lg font-semibold hover:bg-white hover:text-orange-600 transition-colors"
              >
                Find Your Circle
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