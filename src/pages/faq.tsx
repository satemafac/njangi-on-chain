import Head from 'next/head';
import Link from 'next/link';
import { useState } from 'react';

export default function FAQPage() {
  const [openFaqItems, setOpenFaqItems] = useState<{[key: string]: boolean}>({});

  const toggleFaqItem = (id: string) => {
    setOpenFaqItems(prev => ({
      ...prev,
      [id]: !prev[id]
    }));
  };

  const faqCategories = [
    {
      title: "Getting Started",
      faqs: [
        {
          id: "what-is-njangi",
          question: "What is a Njangi?",
          answer: "A Njangi is a community-based savings system where members contribute funds together in a rotation for the equal benefit of every member. It's also known as ROSCA (Rotating Savings and Credit Association), Tontine, Sou Sou, or by many other cultural names around the world. Our platform brings this time-tested tradition to the blockchain for enhanced security and transparency."
        },
        {
          id: "how-to-start",
          question: "How do I get started with Njangi On-Chain?",
          answer: "Getting started is simple: 1) Click 'Login' and authenticate with your Google, Facebook, or other social account using zkLogin, 2) Set up your blockchain wallet (we'll guide you through this), 3) Create a new savings circle or join an existing one, 4) Start contributing and participating in your community savings group."
        },
        {
          id: "cost-to-use",
          question: "How much does it cost to use Njangi On-Chain?",
          answer: "The platform itself is free to use. You only pay minimal blockchain transaction fees (usually a few cents) when making contributions or receiving payouts. These fees go to the Sui blockchain network, not to us. There are no monthly subscriptions, account maintenance fees, or hidden charges."
        },
        {
          id: "currencies-supported",
          question: "What currencies can I use?",
          answer: "We support 6+ major cryptocurrencies including USDC, USDT, SUI, BTC, and others. USDC and USDT are stablecoins pegged to the US Dollar, making them ideal for predictable savings amounts. You can also use native cryptocurrencies if your group prefers."
        }
      ]
    },
    {
      title: "How It Works",
      faqs: [
        {
          id: "how-blockchain-different",
          question: "How is Njangi On-Chain different from traditional savings circles?",
          answer: "While preserving the community spirit of traditional Njangi, our blockchain version offers key advantages: 1) Global accessibility - join circles worldwide, not just locally, 2) Transparent automation - smart contracts handle contributions and payouts fairly, 3) Enhanced security - cryptographic protection against fraud, 4) Permanent records - all transactions are immutably recorded, 5) No geographic limitations - participate from anywhere in the world."
        },
        {
          id: "smart-contracts-work",
          question: "How do smart contracts manage our savings circle?",
          answer: "Smart contracts are automated programs on the blockchain that execute predefined rules without human intervention. In your Njangi circle, they automatically: collect contributions from members, randomly determine payout order fairly, distribute funds to the designated recipient each cycle, track all member participation and payments, and enforce circle rules consistently for everyone."
        },
        {
          id: "payout-order",
          question: "How is the payout order determined?",
          answer: "The payout order is determined by a provably fair random selection built into the smart contract. This ensures no one can manipulate who gets paid when. Once a member receives their payout, they're automatically moved to the end of the queue. The entire process is transparent and verifiable on the blockchain."
        },
        {
          id: "what-happens-missed-payment",
          question: "What happens if someone misses a payment?",
          answer: "Smart contracts have built-in penalties for missed payments to protect the group. Depending on your circle's rules: the member may pay a penalty fee, they might be moved later in the payout queue, or in severe cases, they could be removed from the circle. All rules are agreed upon when joining and automatically enforced by the smart contract."
        }
      ]
    },
    {
      title: "Security & Trust",
      faqs: [
        {
          id: "zklogin-secure",
          question: "Is zkLogin secure? How does it work?",
          answer: "zkLogin is a cutting-edge authentication system that's actually more secure than traditional passwords. It uses zero-knowledge proofs to verify your identity through social accounts (Google, Facebook, etc.) without exposing your personal information to the blockchain. You get the convenience of social login with the security of cryptographic verification."
        },
        {
          id: "funds-security",
          question: "How secure are my funds?",
          answer: "Your funds are secured by multiple layers: 1) Sui blockchain's cryptographic security (same level as Bitcoin), 2) Smart contract automation eliminates human error and fraud, 3) Self-custody means you control your own wallet keys, 4) Multi-signature requirements for group actions, 5) Open-source code that's publicly auditable. We never hold your funds - they're always in your control or locked in transparent smart contracts."
        },
        {
          id: "what-if-member-leaves",
          question: "What if a member wants to leave the circle?",
          answer: "Members can leave circles, but there are important considerations: 1) If they haven't received their payout yet, they may forfeit their contributions (depending on circle rules), 2) If they've already been paid, they must complete their remaining contribution obligations, 3) Some circles allow transferring membership to a trusted replacement, 4) All departure rules are set when the circle is created and enforced by smart contracts."
        },
        {
          id: "blockchain-fails",
          question: "What happens if the blockchain goes down?",
          answer: "Blockchain networks like Sui are designed to be highly resilient with thousands of validators worldwide. Even if some nodes go offline, your funds and circle data remain secure and accessible. In the extremely unlikely event of a complete network failure, your funds are still recoverable using your private keys. However, major blockchains have operated continuously for years without such issues."
        }
      ]
    },
    {
      title: "Platform Features",
      faqs: [
        {
          id: "create-vs-join",
          question: "Should I create a new circle or join an existing one?",
          answer: "Both options have benefits: Create a new circle if you want to invite specific friends/family, set your own rules and schedule, or start with people you already trust. Join an existing circle if you want to start immediately, connect with new community members, or find circles with specific contribution amounts that match your budget."
        },
        {
          id: "circle-size-limits",
          question: "How many people can be in a circle?",
          answer: "Circles can have anywhere from 3 to 50 members, though most work best with 8-20 people. Smaller circles mean faster payout cycles but smaller lump sums. Larger circles mean bigger payouts but longer waits between turns. The optimal size depends on your group's savings goals and preferences."
        },
        {
          id: "contribution-frequency",
          question: "How often do I need to contribute?",
          answer: "Contribution frequency is set when creating or joining a circle. Common options include: weekly, bi-weekly, monthly, or quarterly. Most circles use monthly contributions as it aligns with salary cycles and gives everyone predictable payment schedules. The smart contract will automatically track and enforce the chosen frequency."
        },
        {
          id: "mobile-app",
          question: "Is there a mobile app?",
          answer: "Currently, Njangi On-Chain works through your web browser on any device (mobile, tablet, desktop). The interface is fully responsive and works great on mobile browsers. We're planning a dedicated mobile app for iOS and Android in the future, which will offer push notifications and even easier access to your circles."
        }
      ]
    },
    {
      title: "Cultural & Global",
      faqs: [
        {
          id: "cultural-names",
          question: "Why do you mention so many different names (Tontine, Sou Sou, etc.)?",
          answer: "Rotating savings and credit associations exist in virtually every culture worldwide, each with their own name and traditions: Njangi (Cameroon), Tontine (French-speaking Africa), Sou Sou (Caribbean), ROSCA (Economics), Chama (Kenya), Hui (China), and dozens more. We honor all these traditions while providing a universal platform that serves every community."
        },
        {
          id: "preserve-culture",
          question: "How does the platform preserve cultural traditions?",
          answer: "While we modernize the financial infrastructure, we preserve cultural elements through: customizable circle ceremonies and rituals, support for traditional meeting schedules, cultural naming and language options, community celebration features, and integration with diaspora communities. Technology enhances tradition rather than replacing it."
        },
        {
          id: "global-participation",
          question: "Can I join circles with people from other countries?",
          answer: "Absolutely! One of blockchain's biggest advantages is enabling global participation. You can join circles with diaspora communities, international friends, or people who share your cultural background but live worldwide. Currency conversion and international transfers are handled seamlessly by the blockchain."
        },
        {
          id: "regulations-compliance",
          question: "Is this legal in my country?",
          answer: "Njangi On-Chain operates as a peer-to-peer community savings platform, similar to traditional informal savings groups that are legal worldwide. However, cryptocurrency regulations vary by country. We recommend checking your local laws regarding cryptocurrency use. Our platform complies with applicable regulations and we're committed to working with authorities to ensure compliance."
        }
      ]
    }
  ];

  return (
    <>
      <Head>
        <title>Frequently Asked Questions | Njangi On-Chain - Blockchain Savings Circles</title>
        <meta name="description" content="Get answers to common questions about Njangi On-Chain, blockchain savings circles, security, how it works, and cultural traditions. Learn about zkLogin, smart contracts, and global community savings." />
        <meta name="keywords" content="njangi faq, blockchain savings questions, rosca help, tontine guide, sou sou help, zkLogin security, smart contract savings" />
        <link rel="canonical" href="https://njangi.com/faq" />
        
        {/* Open Graph / Facebook */}
        <meta property="og:type" content="website" />
        <meta property="og:title" content="FAQ - Njangi On-Chain Blockchain Savings Circles" />
        <meta property="og:description" content="Get answers to common questions about blockchain savings circles and community finance." />
        <meta property="og:url" content="https://njangi.com/faq" />
        <meta property="og:image" content="https://njangi.com/images/faq-hero.jpg" />

        {/* Twitter */}
        <meta property="twitter:card" content="summary_large_image" />
        <meta property="twitter:title" content="FAQ - Njangi On-Chain" />
        <meta property="twitter:description" content="Get answers to common questions about blockchain savings circles." />
        <meta property="twitter:image" content="https://njangi.com/images/faq-hero.jpg" />
      </Head>

      <div className="min-h-screen bg-gray-50">
        {/* Navigation */}
        <nav className="bg-white shadow-sm border-b">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex items-center space-x-2 py-3 text-sm text-gray-600">
              <Link href="/" className="hover:text-blue-600 transition-colors">Home</Link>
              <span>/</span>
              <span className="text-gray-900 font-medium">FAQ</span>
            </div>
          </div>
        </nav>

        {/* Hero Section */}
        <section className="bg-gradient-to-r from-blue-600 to-indigo-600 text-white py-16">
          <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
            <h1 className="text-4xl md:text-5xl font-bold mb-6">
              Frequently Asked Questions
            </h1>
            <p className="text-xl md:text-2xl mb-8 text-blue-100">
              Everything you need to know about Njangi On-Chain, blockchain savings circles, 
              and community finance on the Sui blockchain.
            </p>
            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <Link 
                href="/learn" 
                className="bg-white text-blue-600 px-8 py-3 rounded-lg font-semibold hover:bg-gray-100 transition-colors"
              >
                Learn the Basics →
              </Link>
              <Link 
                href="/" 
                className="border-2 border-white text-white px-8 py-3 rounded-lg font-semibold hover:bg-white hover:text-blue-600 transition-colors"
              >
                Get Started
              </Link>
            </div>
          </div>
        </section>

        {/* Quick Links */}
        <section className="bg-white border-b">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
            <h2 className="text-xl font-semibold mb-4 text-center">Jump to Section</h2>
            <div className="flex flex-wrap justify-center gap-4">
              {faqCategories.map((category, index) => (
                <a
                  key={index}
                  href={`#${category.title.toLowerCase().replace(/\s+/g, '-')}`}
                  className="bg-blue-50 text-blue-700 px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-100 transition-colors"
                >
                  {category.title}
                </a>
              ))}
            </div>
          </div>
        </section>

        {/* FAQ Content */}
        <main className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
          {faqCategories.map((category, categoryIndex) => (
            <section 
              key={categoryIndex}
              id={category.title.toLowerCase().replace(/\s+/g, '-')}
              className="mb-12"
            >
              <h2 className="text-3xl font-bold text-gray-900 mb-8 pb-4 border-b border-gray-200">
                {category.title}
              </h2>
              
              <div className="space-y-4">
                {category.faqs.map((faq) => (
                  <div key={faq.id} className="bg-white shadow-sm border border-gray-200 rounded-lg overflow-hidden">
                    <button 
                      className="w-full px-6 py-4 text-left hover:bg-gray-50 transition-colors"
                      onClick={() => toggleFaqItem(faq.id)}
                      aria-expanded={openFaqItems[faq.id]}
                    >
                      <div className="flex justify-between items-center">
                        <span className="text-lg font-semibold text-gray-900 pr-4">
                          {faq.question}
                        </span>
                        <svg 
                          className={`h-5 w-5 text-gray-500 transform ${
                            openFaqItems[faq.id] ? 'rotate-180' : ''
                          } transition-transform duration-200 flex-shrink-0`} 
                          fill="none" 
                          viewBox="0 0 24 24" 
                          stroke="currentColor"
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                        </svg>
                      </div>
                    </button>
                    <div 
                      className={`px-6 pb-4 ${openFaqItems[faq.id] ? 'block' : 'hidden'}`}
                    >
                      <div className="text-gray-700 leading-relaxed whitespace-pre-line">
                        {faq.answer}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </main>

        {/* Still Have Questions */}
        <section className="bg-blue-50">
          <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-16 text-center">
            <h2 className="text-3xl font-bold text-gray-900 mb-4">
              Still Have Questions?
            </h2>
            <p className="text-lg text-gray-600 mb-8 max-w-2xl mx-auto">
              Can&rsquo;t find what you&rsquo;re looking for? We&rsquo;re here to help! 
              Reach out to our community or learn more about blockchain savings circles.
            </p>
            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <Link 
                href="/learn"
                className="bg-blue-600 text-white px-8 py-3 rounded-lg font-semibold hover:bg-blue-700 transition-colors"
              >
                Educational Resources
              </Link>
              <a 
                href="mailto:njangionchain@gmail.com"
                className="border-2 border-blue-600 text-blue-600 px-8 py-3 rounded-lg font-semibold hover:bg-blue-600 hover:text-white transition-colors"
              >
                Contact Support
              </a>
              <a 
                href="https://x.com/njangi_on_chain"
                target="_blank"
                rel="noopener noreferrer"
                className="border-2 border-gray-300 text-gray-700 px-8 py-3 rounded-lg font-semibold hover:bg-gray-100 transition-colors"
              >
                Join Community
              </a>
            </div>
          </div>
        </section>

        {/* Related Resources */}
        <section className="bg-white">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
            <h2 className="text-3xl font-bold text-gray-900 text-center mb-8">
              Learn More About Savings Circles
            </h2>
            <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
              <Link href="/learn/what-is-njangi" className="group">
                <div className="bg-green-50 border border-green-200 rounded-lg p-6 hover:border-green-300 hover:shadow-md transition-all">
                  <h3 className="font-semibold text-green-800 group-hover:text-green-900 mb-2">
                    What is Njangi?
                  </h3>
                  <p className="text-sm text-green-600">
                    Learn about Cameroon&rsquo;s traditional savings circles.
                  </p>
                </div>
              </Link>
              
              <Link href="/learn/blockchain-rosca" className="group">
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-6 hover:border-blue-300 hover:shadow-md transition-all">
                  <h3 className="font-semibold text-blue-800 group-hover:text-blue-900 mb-2">
                    Blockchain ROSCA
                  </h3>
                  <p className="text-sm text-blue-600">
                    Discover the future of community savings.
                  </p>
                </div>
              </Link>
              
              <Link href="/learn/tontine-blockchain" className="group">
                <div className="bg-purple-50 border border-purple-200 rounded-lg p-6 hover:border-purple-300 hover:shadow-md transition-all">
                  <h3 className="font-semibold text-purple-800 group-hover:text-purple-900 mb-2">
                    Tontine Blockchain
                  </h3>
                  <p className="text-sm text-purple-600">
                    African finance meets blockchain technology.
                  </p>
                </div>
              </Link>
              
              <Link href="/learn/sou-sou-crypto" className="group">
                <div className="bg-orange-50 border border-orange-200 rounded-lg p-6 hover:border-orange-300 hover:shadow-md transition-all">
                  <h3 className="font-semibold text-orange-800 group-hover:text-orange-900 mb-2">
                    Sou Sou Crypto
                  </h3>
                  <p className="text-sm text-orange-600">
                    Caribbean savings circles go digital.
                  </p>
                </div>
              </Link>
            </div>
          </div>
        </section>

        {/* Footer */}
        <footer className="bg-gray-100">
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