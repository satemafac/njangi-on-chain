import Link from 'next/link';
import { useState } from 'react';
import { SUPPORT_MAILTO } from '../lib/constants';
import { Seo } from '../components/Seo';
import { breadcrumbs, faqPage } from '../lib/structured-data';
import { Breadcrumbs, MarketingShell } from '../components/marketing/ArticleLayout';
import {
  ChevronLink,
  FaqList,
  focusRing,
  goldButtonClass,
  quietButtonClass,
} from '../components/landing/ui';

/** Stable in-page anchor for a category ("Security & Trust" → "security-&-trust"). */
const categoryAnchor = (title: string) => title.toLowerCase().replace(/\s+/g, '-');

const RELATED = [
  { href: '/learn/what-is-njangi', title: 'What is Njangi?', body: 'Learn about Cameroon\u2019s traditional savings circles.' },
  { href: '/learn/rosca', title: 'What is a ROSCA?', body: 'Discover the future of community savings.' },
  { href: '/learn/tontine', title: 'What is a Tontine?', body: 'The rotating savings circle across West and Central Africa.' },
  { href: '/learn/susu', title: 'What is a Susu?', body: 'Caribbean savings circles go digital.' },
];

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
          answer: "A Njangi is a community-based savings system where members contribute funds together in a rotation for the equal benefit of every member. It's also known as ROSCA (Rotating Savings and Credit Association), Tontine, Sou Sou, or by many other cultural names around the world. Njangi On-Chain runs that same tradition with the pot held in escrow rather than by a treasurer, so nobody has to hold everyone else's money."
        },
        {
          id: "how-to-start",
          question: "How do I get started with Njangi On-Chain?",
          answer: "Getting started is simple: 1) Click 'Login' and sign in with your Google, Facebook or Apple account using zkLogin, 2) Create a new savings circle, or join one from the invite link its organiser sends you, 3) Agree the contribution amount and rotation order with your group, 4) Post your security deposit and start contributing. There is no seed phrase to write down; contributions are paid in USDC or SUI."
        },
        {
          id: "cost-to-use",
          question: "How much does it cost to use Njangi On-Chain?",
          answer: "Running a circle is free. You pay only the small Sui network transaction fee (usually a few cents) when contributing or receiving a payout, and that goes to the network, not to us. We never take a cut of contributions or payouts. A Premium subscription unlocks coordination features — larger circles, WhatsApp notifications and smart goals — and is paid by the circle admin; see the pricing page for what is included. Your circle's money is never behind a paywall."
        },
        {
          id: "currencies-supported",
          question: "What currencies can I use?",
          answer: "Two: USDC and SUI. USDC is a digital dollar, so a circle spread across countries can agree an amount that holds its value. Do not send any other asset, and do not send over any network other than Sui — funds sent another way cannot be recovered."
        }
      ]
    },
    {
      title: "How It Works",
      faqs: [
        {
          id: "how-its-different",
          question: "How is Njangi On-Chain different from traditional savings circles?",
          answer: "The circle is the same; what changes is who holds the money and who keeps the record. 1) Nobody holds the pot — each cycle's contributions sit in escrow that only the scheduled recipient can open, 2) the rotation runs to the order your circle agreed rather than to memory, 3) every contribution and payout is on a shared record any member can check, 4) stopping a circle early goes to a member vote, and a stopped circle returns each member's security deposit, and 5) a circle can span countries, so family abroad can take part."
        },
        {
          id: "smart-contracts-work",
          question: "How is the money actually held?",
          answer: "Each cycle's contributions are held by a contract — a set of rules fixed before anyone pays in. It holds the contributions in escrow, releases the pot to the member whose turn it is under the rotation order your circle agreed, records every contribution and payout on chain, and applies the same rules to everyone. The rotation order is set by the circle admin before the circle starts, not drawn at random. During the testnet pilot, Njangi holds the contract's upgrade key so we can fix bugs, and every upgrade is public on the Sui blockchain. Before mainnet, that key moves to a multi-signature account, so no upgrade can happen without several people approving it, and we'll publish our upgrade policy."
        },
        {
          id: "payout-order",
          question: "How is the payout order determined?",
          answer: "The circle admin sets the rotation order, the same way a njangi treasurer traditionally would — by arranging members into positions the group has agreed on. It is not random. What is different from a paper list is that the order is stored on-chain, where any member can check it, and any change to it is recorded as an on-chain event, so nobody can quietly move themselves up the queue. Once the order is set, each cycle pays the member in the next position until everyone has had their turn."
        },
        {
          id: "what-happens-missed-payment",
          question: "What happens if someone misses a payment?",
          answer: "The round waits. The member whose turn it is can collect only once everyone else has paid, and nothing in the app can force a member to pay, so a missed payment can make a payout late or stop it happening at all. That is why a circle works best with people who already trust each other."
        }
      ]
    },
    {
      title: "Security & Trust",
      faqs: [
        {
          id: "zklogin-secure",
          question: "Is zkLogin secure? How does it work?",
          answer: "zkLogin lets you sign in with your Google, Facebook or Apple account instead of a seed phrase. It uses zero-knowledge proofs, so your wallet is tied to that account without putting your personal information on the public record. That also means your wallet is only as safe as the account you sign in with: protect it with a strong password and two-step verification."
        },
        {
          id: "funds-security",
          question: "How secure are my funds?",
          answer: "Several things work together: 1) contributions sit in a per-cycle escrow contract rather than with a treasurer, 2) each cycle's recipient is fixed when the round opens, so the pot can only be claimed by that member, 3) you sign every transaction yourself — we hold no key that could sign for you, 4) the rotation order and every payment are recorded on chain for the whole circle to see, and 5) the contract code is public and auditable. What this does not do is remove risk: software can contain bugs, and a member who stops contributing can still leave your payout short. See our risk disclosure for what you are taking on."
        },
        {
          id: "what-if-member-leaves",
          question: "What if a member wants to leave the circle?",
          answer: "Before a circle starts, the admin can remove a member, and that member's security deposit is returned. Once the circle is running, the app has no way to leave it or hand your place to someone else, and nothing can force a member to keep paying; if someone stops, the rounds wait for them. If the whole group wants to stop, the admin can put it to a member vote, and a stopped circle returns each member's security deposit."
        },
        {
          id: "identity-verification",
          question: "Why am I asked to complete identity verification before contributing?",
          answer: "Some circles turn on an identity verification requirement — usually because the circle operates in a region where regulations require it, or because the admin wants an extra layer of trust between members. Verification is a one-time check arranged through your circle admin: once you're verified, an attestation is recorded on-chain against your account and your contributions and payouts go through normally until it expires. Njangi On-Chain never sees or stores your identity documents — checks are performed by licensed verification partners, and only the pass/fail attestation touches the blockchain. If you're seeing a verification prompt, ask your circle admin to start your verification."
        },
        {
          id: "network-or-app-down",
          question: "What if the network or the app goes down?",
          answer: "Your circle's money is not held by us and does not depend on our app being up: it sits in the escrow contract on a public network run by independent validators, and the record stays readable even if this website is unavailable. What this does not do is make your account recoverable if you lose access to the social account you signed in with — sign-in is currently one-way, so keep access to that account."
        }
      ]
    },
    {
      title: "Platform Features",
      faqs: [
        {
          id: "create-vs-join",
          question: "Should I create a new circle or join an existing one?",
          answer: "Create a new circle if you want to invite specific friends or family and set your own amount and schedule. Join a circle when someone you know sends you its invite link: there is no public list of circles to browse, and the organiser approves each member who asks to join."
        },
        {
          id: "circle-size-limits",
          question: "How many people can be in a circle?",
          answer: "The contract allows 3 to 20 members. On the Free plan a circle can have up to 3 members; a Premium subscription raises that to the full 20. Smaller circles come round faster but pool a smaller amount each turn; larger circles pool more but mean a longer wait between your turns. Most groups land somewhere in the middle."
        },
        {
          id: "contribution-frequency",
          question: "How often do I need to contribute?",
          answer: "Contribution frequency is set when creating or joining a circle. Common options include: weekly, bi-weekly, monthly, or quarterly. Most circles use monthly contributions as it aligns with salary cycles and gives everyone predictable payment schedules. The schedule is fixed when the circle is created, and tracked automatically."
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
          answer: "Rotating savings and credit associations exist in virtually every culture worldwide, each with their own name and traditions: Njangi (Cameroon), Tontine (French-speaking Africa), Sou Sou (Caribbean), ROSCA (Economics), Chama (Kenya), Hui (China), and dozens more. We honor all these traditions; the product runs the rotating format they share."
        },
        {
          id: "preserve-culture",
          question: "How does the platform preserve cultural traditions?",
          answer: "The app handles the money and the record; the meetings, the meals and the ceremonies stay with your group. You can give your circle the name your group already uses, switch the app between languages including English and French, and a member who collects their pot gets a short celebration on screen."
        },
        {
          id: "global-participation",
          question: "Can I join circles with people from other countries?",
          answer: "Yes — this is one of the main reasons the product exists. A circle can include family at home and relatives abroad, so a njangi no longer has to end at a border. A circle can settle in USDC, a digital dollar, so everyone pays the same agreed amount regardless of where they live."
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

      <MarketingShell legacy={false}>
        {/* ================= HERO ================= */}
        <header className="relative overflow-hidden">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(900px_460px_at_50%_-12%,rgba(232,176,75,0.10),transparent_64%)]"
          />
          <div className="relative mx-auto max-w-[980px] px-5 pb-16 pt-8 text-center sm:px-8 md:pb-24 md:pt-12">
            <Breadcrumbs
              className="flex justify-center"
              items={[{ label: 'Home', href: '/' }, { label: 'FAQ' }]}
            />
            <h1 className="type-hero mx-auto mt-12 max-w-[16ch] text-balance text-mist">
              Frequently Asked Questions
            </h1>
            <p className="type-intro mx-auto mt-6 max-w-[40rem] text-balance text-mist-2">
              Everything you need to know about Njangi On-Chain, how a savings circle works, and
              what happens to your money at each step.
            </p>
            <div className="mt-10 flex flex-col items-center justify-center gap-5 sm:flex-row sm:gap-8">
              <Link href="/" className={goldButtonClass}>
                Get Started
              </Link>
              <ChevronLink href="/learn">Learn the Basics</ChevronLink>
            </div>
          </div>
        </header>

        {/* ============ JUMP BAR (sticks under the global bar) ============ */}
        <nav
          aria-label="FAQ sections"
          className="sticky top-[52px] z-30 border-y border-white/[0.08] bg-black/75 backdrop-blur-xl backdrop-saturate-[1.8]"
        >
          <div className="mx-auto flex max-w-[980px] items-center gap-2 overflow-x-auto px-5 py-3 [scrollbar-width:none] sm:justify-center sm:px-8 [&::-webkit-scrollbar]:hidden">
            {faqCategories.map((category) => (
              <a
                key={category.title}
                href={`#${categoryAnchor(category.title)}`}
                className={`shrink-0 rounded-full bg-white/[0.06] px-4 py-2 text-[14px] text-mist-2 transition-colors duration-200 hover:bg-white/[0.12] hover:text-mist ${focusRing}`}
              >
                {category.title}
              </a>
            ))}
          </div>
        </nav>

        {/* ================= ANSWERS ================= */}
        <main className="mx-auto max-w-[860px] px-5 pb-8 pt-16 sm:px-8 md:pt-24">
          {faqCategories.map((category) => (
            <section
              key={category.title}
              id={categoryAnchor(category.title)}
              className="mb-20 scroll-mt-[132px] md:mb-28"
            >
              <h2 className="type-headline text-mist">{category.title}</h2>
              <div className="mt-8">
                <FaqList
                  items={category.faqs.map((item) => ({
                    id: item.id,
                    question: item.question,
                    answer: item.answer,
                  }))}
                  open={openFaqItems}
                  onToggle={toggleFaqItem}
                />
              </div>
            </section>
          ))}
        </main>

        {/* ================= STILL HAVE QUESTIONS ================= */}
        <section className="px-5 pb-24 sm:px-8 md:pb-32">
          <div className="relative mx-auto max-w-[980px] overflow-hidden rounded-[28px] bg-ink-surface px-7 py-14 text-center sm:px-12 md:py-20">
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 -top-32 mx-auto h-64 max-w-[640px] rounded-full"
              style={{ background: 'radial-gradient(closest-side, rgba(232,176,75,0.14), transparent)' }}
            />
            <h2 className="type-section relative text-balance text-mist">Still Have Questions?</h2>
            <p className="type-intro relative mx-auto mt-5 max-w-[36rem] text-balance text-mist-2">
              Can&rsquo;t find what you&rsquo;re looking for? We&rsquo;re here to help! Reach out to
              our community, or read more about how savings circles work.
            </p>
            <div className="relative mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row sm:gap-5">
              <a href={SUPPORT_MAILTO} className={goldButtonClass}>
                Contact Support
              </a>
              <Link href="/learn" className={quietButtonClass}>
                Educational Resources
              </Link>
            </div>
            <div className="relative mt-6">
              <a
                href="https://x.com/njangi_on_chain"
                target="_blank"
                rel="noopener noreferrer"
                className={`group inline-flex items-center gap-0.5 rounded text-[17px] tracking-[-0.022em] text-gold underline-offset-4 hover:underline ${focusRing}`}
              >
                Join Community
                <span aria-hidden className="transition-transform duration-200 group-hover:translate-x-0.5 rtl:rotate-180">
                  ›
                </span>
              </a>
            </div>
          </div>
        </section>

        {/* ================= RELATED ================= */}
        <section className="px-5 pb-24 sm:px-8 md:pb-32">
          <div className="mx-auto max-w-[1100px]">
            <div className="text-center">
              <h2 className="type-section text-balance text-mist">
                Learn More About Savings Circles
              </h2>
            </div>
            <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {RELATED.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`group flex flex-col rounded-[28px] bg-ink-surface p-7 transition-colors duration-200 hover:bg-[#1b1b1e] ${focusRing}`}
                >
                  <span className="text-[19px] font-semibold tracking-[0.012em] text-mist">
                    {item.title}
                  </span>
                  <span className="type-caption mt-2 flex-1 text-mist-3">{item.body}</span>
                  <span className="mt-6 inline-flex items-center gap-0.5 text-[15px] text-gold">
                    Read
                    <span aria-hidden className="transition-transform duration-200 group-hover:translate-x-0.5 rtl:rotate-180">
                      ›
                    </span>
                  </span>
                </Link>
              ))}
            </div>
          </div>
        </section>

        {/* ================= DISCLAIMER ================= */}
        <aside className="px-5 pb-16 sm:px-8">
          <p className="type-fine mx-auto max-w-[44rem] text-center text-mist-3">
            <strong className="font-semibold text-mist-2">Disclaimer:</strong> This content is for
            educational purposes only and does not constitute financial advice. Njangi On-Chain is
            coordination software for savings circles: it never holds your money, never offers an
            investment, and never pays a return. Take part only with an amount your group can commit
            to the schedule.
          </p>
        </aside>
      </MarketingShell>
    </>
  );
} 