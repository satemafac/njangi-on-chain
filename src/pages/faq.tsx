import Link from 'next/link';
import { useState } from 'react';
import { SUPPORT_MAILTO } from '../lib/constants';
import { Seo } from '../components/Seo';
import { breadcrumbs, faqPage } from '../lib/structured-data';
import { MarketingShell } from '../components/marketing/ArticleLayout';

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
          answer: "Running a circle is free. You pay only the small Sui network transaction fee (usually a few cents) when contributing or receiving a payout, and that goes to the network, not to us. We never take a cut of contributions or payouts. A Premium subscription unlocks coordination features — larger circles, WhatsApp notifications, smart goals, and analytics — and is paid by the circle admin; see the pricing page for what is included. Your circle's money is never behind a paywall."
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
          answer: "Smart contracts are automated programs on the blockchain that execute predefined rules without human intervention. In your Njangi circle, they hold each cycle's contributions in escrow, release the pot to the member whose turn it is under the rotation order your circle agreed, record every contribution and payout on chain, and apply the same rules to everyone. The rotation order is set by the circle admin before the circle starts, not drawn at random."
        },
        {
          id: "payout-order",
          question: "How is the payout order determined?",
          answer: "The circle admin sets the rotation order, the same way a njangi treasurer traditionally would — by arranging members into positions the group has agreed on. It is not random. What is different from a paper list is that the order is stored on-chain and visible to every member, and any change to it is recorded as an on-chain event, so nobody can quietly move themselves up the queue. Once the order is set, each cycle pays the member in the next position until everyone has had their turn."
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
          answer: "Several things work together: 1) contributions sit in a per-cycle escrow contract rather than with a treasurer, 2) each cycle's recipient is fixed when the round opens, so the pot can only be claimed by that member, 3) you sign every transaction from your own wallet — we hold no key that could sign for you, 4) the rotation order and every payment are recorded on chain for the whole circle to see, and 5) the contract code is public and auditable. What this does not do is remove risk: software can contain bugs, and a member who stops contributing can still leave your payout short. See our risk disclosure for what you are taking on."
        },
        {
          id: "what-if-member-leaves",
          question: "What if a member wants to leave the circle?",
          answer: "Members can leave circles, but there are important considerations: 1) If they haven't received their payout yet, they may forfeit their contributions (depending on circle rules), 2) If they've already been paid, they must complete their remaining contribution obligations, 3) Some circles allow transferring membership to a trusted replacement, 4) All departure rules are set when the circle is created and enforced by smart contracts."
        },
        {
          id: "identity-verification",
          question: "Why am I asked to complete identity verification before contributing?",
          answer: "Some circles turn on an identity verification requirement — usually because the circle operates in a region where regulations require it, or because the admin wants an extra layer of trust between members. Verification is a one-time check arranged through your circle admin: once you're verified, an attestation is recorded on-chain against your wallet and your contributions and payouts go through normally until it expires. Njangi On-Chain never sees or stores your identity documents — checks are performed by licensed verification partners, and only the pass/fail attestation touches the blockchain. If you're seeing a verification prompt, ask your circle admin to start your verification."
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
          answer: "The contract allows 3 to 20 members. On the Free plan a circle can have up to 3 members; a Premium subscription raises that to the full 20. Smaller circles come round faster but pool a smaller amount each turn; larger circles pool more but mean a longer wait between your turns. Most groups land somewhere in the middle."
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
          answer: "Njangi On-Chain is non-custodial coordination software for savings groups: we never hold, move, or take a cut of member funds. Rules about crypto and about savings groups differ by country, and whether any particular rule applies to you depends on where you live — please check your local law. We are not able to give you legal advice about your situation."
        }
      ]
    }
  ];

  return (
    <>
      <Seo
        title="Frequently Asked Questions"
        description="How a njangi works on-chain, who holds the money, what happens if someone stops contributing, and how the cultural traditions map onto the product. Answered plainly."
        path="/faq"
        image={{
          url: '/og/faq.png',
          alt: 'Njangi On-Chain — a few things people ask first',
        }}
        jsonLd={[
          breadcrumbs([{ name: 'Home', path: '/' }, { name: 'FAQ' }]),
          // FAQPage is emitted for entity understanding and for Bing, which
          // still renders FAQ results. Google restricted FAQ rich results to
          // government and health sites in Aug 2023 — do not expect visible
          // accordions in a Google result from this markup.
          // Built from the same array the page renders, so the markup and the
          // visible answers cannot drift apart (Google requires they match).
          faqPage(
            faqCategories.flatMap((category) =>
              category.faqs.map((item) => ({
                question: item.question,
                answer: item.answer,
              }))
            )
          ),
        ]}
      />

      <MarketingShell>
        {/* Navigation */}
        <nav className="bg-ink-surface border-b">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex items-center space-x-2 py-3 text-sm text-sand">
              <Link href="/" className="hover:text-gold transition-colors">Home</Link>
              <span>/</span>
              <span className="text-cream font-medium">FAQ</span>
            </div>
          </div>
        </nav>

        {/* Hero Section */}
        <section className="bg-gradient-to-r from-ink-surface to-ink-deep text-cream py-16">
          <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
            <h1 className="text-4xl md:text-5xl font-bold mb-6">
              Frequently Asked Questions
            </h1>
            <p className="text-xl md:text-2xl mb-8 text-cream-muted">
              Everything you need to know about Njangi On-Chain, blockchain savings circles, 
              and community finance on the Sui blockchain.
            </p>
            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <Link 
                href="/learn" 
                className="bg-ink-surface text-gold px-8 py-3 rounded-lg font-semibold hover:bg-ink-surface transition-colors"
              >
                Learn the Basics →
              </Link>
              <Link 
                href="/" 
                className="border border-gold-deep/55 text-cream px-8 py-3 rounded-lg font-semibold hover:bg-ink-surface hover:text-gold transition-colors"
              >
                Get Started
              </Link>
            </div>
          </div>
        </section>

        {/* Quick Links */}
        <section className="bg-ink-surface border-b">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
            <h2 className="text-xl font-semibold mb-4 text-center">Jump to Section</h2>
            <div className="flex flex-wrap justify-center gap-4">
              {faqCategories.map((category, index) => (
                <a
                  key={index}
                  href={`#${category.title.toLowerCase().replace(/\s+/g, '-')}`}
                  className="bg-gold/[0.07] text-gold px-4 py-2 rounded-lg text-sm font-medium hover:bg-gold/[0.07] transition-colors"
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
              <h2 className="text-3xl font-bold text-cream mb-8 pb-4 border-b border-ink-border border-ink-border">
                {category.title}
              </h2>
              
              <div className="space-y-4">
                {category.faqs.map((faq) => (
                  <div key={faq.id} className="bg-ink-surface border border-ink-border rounded-lg overflow-hidden">
                    <button 
                      className="w-full px-6 py-4 text-left hover:bg-ink-deep transition-colors"
                      onClick={() => toggleFaqItem(faq.id)}
                      aria-expanded={openFaqItems[faq.id]}
                    >
                      <div className="flex justify-between items-center">
                        <span className="text-lg font-semibold text-cream pr-4">
                          {faq.question}
                        </span>
                        <svg 
                          className={`h-5 w-5 text-sand-dim transform ${
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
                      <div className="text-sand leading-relaxed whitespace-pre-line">
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
        <section className="bg-gold/[0.07]">
          <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-16 text-center">
            <h2 className="text-3xl font-bold text-cream mb-4">
              Still Have Questions?
            </h2>
            <p className="text-lg text-sand mb-8 max-w-2xl mx-auto">
              Can&rsquo;t find what you&rsquo;re looking for? We&rsquo;re here to help! 
              Reach out to our community or learn more about blockchain savings circles.
            </p>
            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <Link 
                href="/learn"
                className="bg-gold text-cream px-8 py-3 rounded-lg font-semibold hover:bg-gold transition-colors"
              >
                Educational Resources
              </Link>
              <a
                href={SUPPORT_MAILTO}
                className="border-2 border-gold/45 text-gold px-8 py-3 rounded-lg font-semibold hover:bg-gold hover:text-cream transition-colors"
              >
                Contact Support
              </a>
              <a 
                href="https://x.com/njangi_on_chain"
                target="_blank"
                rel="noopener noreferrer"
                className="border-2 border-ink-border text-sand px-8 py-3 rounded-lg font-semibold hover:bg-ink-surface transition-colors"
              >
                Join Community
              </a>
            </div>
          </div>
        </section>

        {/* Related Resources */}
        <section className="bg-ink-surface">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
            <h2 className="text-3xl font-bold text-cream text-center mb-8">
              Learn More About Savings Circles
            </h2>
            <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
              <Link href="/learn/what-is-njangi" className="group">
                <div className="bg-gold/[0.07] border border-gold/45 rounded-lg p-6 hover:border-gold/45 hover:shadow-[0_14px_40px_-24px_rgba(0,0,0,0.8)] transition-all">
                  <h3 className="font-semibold text-gold group-hover:text-gold mb-2">
                    What is Njangi?
                  </h3>
                  <p className="text-sm text-gold">
                    Learn about Cameroon&rsquo;s traditional savings circles.
                  </p>
                </div>
              </Link>
              
              <Link href="/learn/rosca" className="group">
                <div className="bg-gold/[0.07] border border-gold/45 rounded-lg p-6 hover:border-gold/45 hover:shadow-[0_14px_40px_-24px_rgba(0,0,0,0.8)] transition-all">
                  <h3 className="font-semibold text-gold group-hover:text-gold mb-2">
                    Blockchain ROSCA
                  </h3>
                  <p className="text-sm text-gold">
                    Discover the future of community savings.
                  </p>
                </div>
              </Link>
              
              <Link href="/learn/tontine" className="group">
                <div className="bg-gold/[0.07] border border-gold/45 rounded-lg p-6 hover:border-gold/45 hover:shadow-[0_14px_40px_-24px_rgba(0,0,0,0.8)] transition-all">
                  <h3 className="font-semibold text-gold group-hover:text-gold mb-2">
                    Tontine Blockchain
                  </h3>
                  <p className="text-sm text-gold">
                    African finance meets blockchain technology.
                  </p>
                </div>
              </Link>
              
              <Link href="/learn/susu" className="group">
                <div className="bg-gold/[0.07] border border-gold/45 rounded-lg p-6 hover:border-gold/45 hover:shadow-[0_14px_40px_-24px_rgba(0,0,0,0.8)] transition-all">
                  <h3 className="font-semibold text-gold group-hover:text-gold mb-2">
                    Sou Sou Crypto
                  </h3>
                  <p className="text-sm text-gold">
                    Caribbean savings circles go digital.
                  </p>
                </div>
              </Link>
            </div>
          </div>
        </section>

        {/* Footer */}
        <footer className="bg-ink-surface">
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