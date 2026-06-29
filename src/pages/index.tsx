import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Head from 'next/head';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/router';
import * as Dialog from '@radix-ui/react-dialog';
import { Instrument_Serif, Manrope } from 'next/font/google';
import {
  ArrowRight,
  BadgeCheck,
  ChevronDown,
  CircleDot,
  Coins,
  Globe2,
  Mail,
  Shield,
  type LucideIcon,
  Users,
  Wallet,
  Waypoints,
  X,
} from 'lucide-react';
import dynamic from 'next/dynamic';
import { useAuth } from '../contexts/AuthContext';
import { LoginButton } from '../components/LoginButton';
import { LegalFooter } from '../components/LegalFooter';
import { LocaleSwitcher } from '../components/ui/LocaleSwitcher';
import { useTranslation } from '../hooks/useTranslation';
import { getNetworkConfig, setCurrentNetwork } from '../services/network-config';
import { SUPPORT_EMAIL, SUPPORT_MAILTO } from '../lib/constants';
import { Reveal, RevealItem } from '../components/landing/Reveal';
import TiltCard from '../components/landing/TiltCard';
import KineticNames from '../components/landing/KineticNames';
import { useSmoothScroll } from '../components/landing/useSmoothScroll';

// WebGL scenes are browser-only and lazy: keep them out of SSR + the critical
// path so first paint (and the CSS gradient fallback) never blocks on them, and
// the lazy chunk never collapses hero height (min-h reserved on the section).
const DiasporaMeridian = dynamic(
  () => import('../components/landing/DiasporaMeridian'),
  { ssr: false, loading: () => null }
);
const AmbientField = dynamic(
  () => import('../components/landing/AmbientField'),
  { ssr: false, loading: () => null }
);

declare global {
  interface Window {
    CURRENT_NETWORK_CONFIG?: {
      rpcUrl: string;
      packageId: string;
      usdcAddress: string;
      networkName: string;
      enoki: {
        apiKey: string | undefined;
        baseUrl: string;
        graphqlUrl: string;
      };
    };
  }
}

const wordmarkFont = Instrument_Serif({
  subsets: ['latin'],
  weight: '400',
  display: 'swap',
});

const bodyFont = Manrope({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  display: 'swap',
});

const CULTURAL_NAMES = [
  'Adaji',
  'Ajoh',
  'Asue',
  'Arisan',
  'Cadena',
  'Chama',
  'Chit Funds',
  'Cundina',
  'Equb',
  'Esusu',
  'Hagbad',
  'Hui',
  'Idir',
  'Kikoba',
  'Mujin',
  'Njangi',
  'Paluwagan',
  'Pandero',
  'Gameya',
  'Samity',
  'Sou-sou',
  'Stokvel',
  'Tanda',
  'Tontine',
  'Xitique',
];

// Feature cards and workflow steps reference i18n keys; the visible copy is
// resolved at render time via the active locale (EN/FR funnel translation).
const FEATURE_CARDS: Array<{
  icon: LucideIcon;
  titleKey: string;
  descriptionKey: string;
}> = [
  {
    icon: Shield,
    titleKey: 'landing.feature.sharedVisibility.title',
    descriptionKey: 'landing.feature.sharedVisibility.body',
  },
  {
    icon: Wallet,
    titleKey: 'landing.feature.selfCustody.title',
    descriptionKey: 'landing.feature.selfCustody.body',
  },
  {
    icon: Globe2,
    titleKey: 'landing.feature.borderless.title',
    descriptionKey: 'landing.feature.borderless.body',
  },
  {
    icon: Users,
    titleKey: 'landing.feature.culturalContinuity.title',
    descriptionKey: 'landing.feature.culturalContinuity.body',
  },
];

const WORKFLOW_STEPS = [
  {
    number: '01',
    titleKey: 'landing.workflow.step1.title',
    descriptionKey: 'landing.workflow.step1.body',
  },
  {
    number: '02',
    titleKey: 'landing.workflow.step2.title',
    descriptionKey: 'landing.workflow.step2.body',
  },
  {
    number: '03',
    titleKey: 'landing.workflow.step3.title',
    descriptionKey: 'landing.workflow.step3.body',
  },
];

const COMPARISON_ROWS = [
  {
    label: 'Membership',
    traditional: 'Relationship-based and manually coordinated',
    onchain: 'Invites, approvals, and member roles in one shared system',
    fintech: 'Institution-owned accounts for individuals',
  },
  {
    label: 'Visibility',
    traditional: 'Personal notes, chat history, and memory',
    onchain: 'A shared, auditable record of each contribution and turn',
    fintech: 'Platform ledger, not a group view',
  },
  {
    label: 'Settlement',
    traditional: 'Cash or fragmented bank transfers',
    onchain: 'Direct wallet settlement in supported on-chain assets',
    fintech: 'Custodial balances and domestic rails',
  },
  {
    label: 'Access',
    traditional: 'Local or in-person participation',
    onchain: 'Borderless participation with social sign-in',
    fintech: 'Country, product, or provider restrictions',
  },
  {
    label: 'Control',
    traditional: 'Organizer-driven coordination',
    onchain: 'Member oversight with smart-contract rules',
    fintech: 'Provider controlled custody and policies',
  },
  {
    label: 'Cultural fit',
    traditional: 'Strong tradition, low operational tooling',
    onchain: 'Tradition preserved with clearer operational guardrails',
    fintech: 'Generic financial workflows',
  },
];

const COMPARISON_CARDS = [
  {
    title: 'Traditional circle',
    highlight: false,
    items: [
      'Relationship-based coordination',
      'Cash or manual transfer collection',
      'Strong social trust, lighter operational tooling',
      'Limited visibility outside organizers and chat threads',
    ],
  },
  {
    title: 'Njangi On-Chain',
    highlight: true,
    items: [
      'Shared visibility for turns, contributions, and approvals',
      'Direct wallet settlement with self-custody',
      'Social sign-in through zkLogin',
      'A calmer operating layer for distributed communities',
    ],
  },
  {
    title: 'Banks and fintech apps',
    highlight: false,
    items: [
      'Built around individual accounts',
      'Provider-controlled custody and rules',
      'Geographic and product restrictions',
      'Little support for culturally specific circle workflows',
    ],
  },
];

// FAQ copy is resolved via i18n (EN/FR) at render time; ids drive accordion state.
const FAQ_ITEMS = [
  { id: 'what-is-njangi', questionKey: 'landing.faq.q1', answerKey: 'landing.faq.a1' },
  { id: 'why-onchain', questionKey: 'landing.faq.q2', answerKey: 'landing.faq.a2' },
  { id: 'do-i-need-crypto', questionKey: 'landing.faq.q3', answerKey: 'landing.faq.a3' },
  { id: 'network-switching', questionKey: 'landing.faq.q4', answerKey: 'landing.faq.a4' },
];

const socialLinkClass =
  'inline-flex items-center py-2.5 text-sm font-medium text-[#cfc8ba] transition-colors duration-200 hover:text-[#f6d99a] focus-visible:outline-none focus-visible:underline focus-visible:underline-offset-4';

export default function Home() {
  const router = useRouter();
  const { account } = useAuth();
  const { t } = useTranslation();

  // Lenis smooth scroll (skips itself under prefers-reduced-motion).
  useSmoothScroll();

  const [isAuthDialogOpen, setIsAuthDialogOpen] = useState(false);
  const [openFaqItems, setOpenFaqItems] = useState<Record<string, boolean>>({
    'what-is-njangi': true,
  });

  const [signupEmail, setSignupEmail] = useState('');
  const [isSignupLoading, setIsSignupLoading] = useState(false);
  const [signupMessage, setSignupMessage] = useState('');
  const [showSignupSuccess, setShowSignupSuccess] = useState(false);
  const [circleCount, setCircleCount] = useState<number | null>(null);

  const NETWORK_CONFIG = useMemo(() => {
    const testnet = getNetworkConfig('testnet');
    const mainnet = getNetworkConfig('mainnet');

    return {
      testnet: {
        rpcUrl: testnet.rpcUrl,
        packageId: testnet.packageId,
        usdcAddress: testnet.coinTypes.USDC,
        networkName: 'Testnet',
        enoki: {
          // The Enoki private key is server-only (used solely by
          // /api/zkLogin). The browser config carries an empty key so it is
          // never inlined into the client bundle.
          apiKey: '',
          baseUrl: 'https://api.enoki.mystenlabs.com/v1',
          graphqlUrl: testnet.graphqlUrl,
        },
      },
      mainnet: {
        rpcUrl: mainnet.rpcUrl,
        packageId: mainnet.packageId,
        usdcAddress: mainnet.coinTypes.USDC,
        networkName: 'Mainnet',
        enoki: {
          // Server-only key — see the testnet note; never exposed client-side.
          apiKey: '',
          baseUrl: 'https://api.enoki.mystenlabs.com/v1',
          graphqlUrl: mainnet.graphqlUrl,
        },
      },
    };
  }, []);

  const [network, setNetwork] = useState<'testnet' | 'mainnet'>('testnet');
  const [isNetworkSwitchModalOpen, setIsNetworkSwitchModalOpen] = useState(false);
  const [pendingNetwork, setPendingNetwork] = useState<'testnet' | 'mainnet' | null>(null);

  const toggleFaqItem = (id: string) => {
    setOpenFaqItems((prev) => ({
      ...prev,
      [id]: !prev[id],
    }));
  };

  const switchNetwork = useCallback((newNetwork: 'testnet' | 'mainnet') => {
    setPendingNetwork(newNetwork);
    setIsNetworkSwitchModalOpen(true);
  }, []);

  const confirmNetworkSwitch = useCallback(() => {
    if (!pendingNetwork) return;

    const config = NETWORK_CONFIG[pendingNetwork];

    setNetwork(pendingNetwork);

    if (typeof window !== 'undefined') {
      localStorage.setItem('sui-network', pendingNetwork);
    }

    setCurrentNetwork(pendingNetwork);

    if (typeof window !== 'undefined') {
      window.CURRENT_NETWORK_CONFIG = config;
    }

    if (typeof window !== 'undefined') {
      const zkLoginKeys = Object.keys(localStorage).filter(
        (key) => key.includes('zklogin') || key.includes('enoki')
      );
      zkLoginKeys.forEach((key) => localStorage.removeItem(key));
    }

    setIsNetworkSwitchModalOpen(false);
    setPendingNetwork(null);

    setTimeout(() => {
      window.location.reload();
    }, 500);
  }, [NETWORK_CONFIG, pendingNetwork]);

  const cancelNetworkSwitch = useCallback(() => {
    setIsNetworkSwitchModalOpen(false);
    setPendingNetwork(null);
  }, []);

  useEffect(() => {
    const fetchCircleCount = async () => {
      try {
        const response = await fetch('/api/circle-stats');
        const data = await response.json();

        if (data.success && data.data?.circleCount !== undefined) {
          setCircleCount(data.data.circleCount);
        } else {
          // Honest fallback: leave null so the stat shows "Syncing", never a
          // fabricated count.
          setCircleCount(null);
        }
      } catch (error) {
        console.error('Error fetching circle count:', error);
        setCircleCount(null);
      }
    };

    fetchCircleCount();
  }, []);

  const handleMainnetSignup = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!signupEmail.trim()) {
      setSignupMessage('Please enter your email address');
      return;
    }

    setIsSignupLoading(true);
    setSignupMessage('');

    try {
      const response = await fetch('/api/mainnet-signup', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: signupEmail.trim(),
          userAddress: account?.userAddr,
          signupSource: 'homepage',
        }),
      });

      const data = await response.json();

      if (data.success) {
        setSignupMessage(data.message || 'Successfully signed up.');
        setShowSignupSuccess(true);
        setSignupEmail('');

        setTimeout(() => {
          setShowSignupSuccess(false);
          setSignupMessage('');
        }, 5000);
      } else {
        setSignupMessage(data.message || 'Failed to sign up. Please try again.');
      }
    } catch (error) {
      console.error('Error signing up for mainnet:', error);
      setSignupMessage('Network error. Please try again.');
    } finally {
      setIsSignupLoading(false);
    }
  };

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const savedNetwork = localStorage.getItem('sui-network') as
        | 'testnet'
        | 'mainnet'
        | null;

      if (savedNetwork && savedNetwork !== network && NETWORK_CONFIG[savedNetwork]) {
        const config = NETWORK_CONFIG[savedNetwork];
        setNetwork(savedNetwork);
        setCurrentNetwork(savedNetwork);
        window.CURRENT_NETWORK_CONFIG = config;
        console.log(`Loaded network preference: ${savedNetwork}`);
      } else {
        setCurrentNetwork(network);
        window.CURRENT_NETWORK_CONFIG = NETWORK_CONFIG[network];
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.CURRENT_NETWORK_CONFIG = NETWORK_CONFIG[network];
    }
  }, [NETWORK_CONFIG, network]);

  useEffect(() => {
    const { returnUrl } = router.query;
    if (returnUrl && typeof returnUrl === 'string') {
      const decodedUrl = decodeURIComponent(returnUrl);
      if (decodedUrl.startsWith('/')) {
        localStorage.setItem('redirectAfterLogin', decodedUrl);
        console.log('Stored redirect URL:', decodedUrl);
      }
    }
  }, [router.query]);

  useEffect(() => {
    if (account) {
      const redirectUrl = localStorage.getItem('redirectAfterLogin');
      if (redirectUrl) {
        localStorage.removeItem('redirectAfterLogin');
        console.log('Redirecting to stored URL:', redirectUrl);
        router.push(redirectUrl);
      } else {
        router.push('/dashboard');
      }
    }
  }, [account, router]);

  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'https://njangionchain.com';
  const currentNetworkName = NETWORK_CONFIG[network].networkName;

  const proofItems = [
    {
      label: t('landing.proof.liveCircles'),
      value: circleCount !== null ? `${circleCount}+` : t('landing.proof.syncing'),
    },
    {
      label: t('landing.proof.supportedAssets'),
      value: '6+',
    },
    {
      label: t('landing.proof.custodyLabel'),
      value: t('landing.proof.custodyValue'),
    },
  ];

  const previewStats = [
    {
      label: 'Members in view',
      value: '12',
      caption: 'Roles, approvals, and turns tracked in one place',
    },
    {
      label: 'Next payout',
      value: '4 days',
      caption: 'Schedule clarity without spreadsheet follow-up',
    },
    {
      label: 'Payment modes',
      value: 'Direct + swap',
      caption: 'Contribute from what members already hold',
    },
    {
      label: 'History',
      value: 'Auditable',
      caption: 'Every state change leaves a visible trail',
    },
  ];

  const launchNotes = [
    'Current experience is optimized for testnet exploration and live workflow validation.',
    'Early subscribers get the clearest signal on mainnet readiness and rollout timing.',
    'You will only hear from us when there is something materially useful to share.',
  ];

  const cycleSnapshot = [
    {
      icon: Coins,
      title: 'Contribution due',
      body: 'Members see the amount, deadline, and payment path without waiting for a reminder thread.',
    },
    {
      icon: Waypoints,
      title: 'Payout order',
      body: 'Rotation rules stay visible, reducing ambiguity around who is next and when the handoff happens.',
    },
    {
      icon: Shield,
      title: 'Audit trail',
      body: 'Approvals, contributions, and state changes stay visible to the circle instead of one organizer’s notes.',
    },
  ];

  const sectionEyebrowClass =
    'text-[11px] font-semibold uppercase tracking-[0.32em] text-[#E8B04B]';
  const sectionTitleClass = `${wordmarkFont.className} mt-4 text-[clamp(2rem,3.8vw,2.9rem)] font-normal leading-[1.08] tracking-[-0.01em] text-[#f5f1e8]`;
  const sectionBodyClass =
    'mt-4 max-w-2xl text-base leading-7 text-[#a8a294] sm:text-lg';
  const glassCardClass =
    'rounded-3xl border border-[#2a2620] bg-[#13121a]/85 shadow-[0_20px_60px_-30px_rgba(0,0,0,0.85)] backdrop-blur-sm';
  const mutedCardClass = 'rounded-2xl border border-[#221f29] bg-[#13121a]/60';
  const goldButtonClass =
    'inline-flex items-center justify-center gap-2 rounded-full bg-gradient-to-r from-[#f6d99a] via-[#E8B04B] to-[#C8902F] px-6 py-3 text-sm font-semibold text-[#1a1304] shadow-[0_14px_44px_-14px_rgba(232,176,75,0.6)] transition-transform duration-200 hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f6d99a] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0a0c]';
  const ghostButtonClass =
    'inline-flex items-center justify-center gap-2 rounded-full border border-[#C8902F]/55 bg-white/[0.03] px-6 py-3 text-sm font-semibold text-[#f6d99a] backdrop-blur transition-colors duration-200 hover:border-[#E8B04B] hover:bg-[#E8B04B]/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f6d99a] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0a0c]';
  const chipClass =
    'inline-flex items-center gap-2 rounded-full border border-[#2a2620] bg-[#13121a]/70 px-4 py-2 text-sm font-medium text-[#cfc8ba]';

  return (
    <>
      <Head>
        <title>Njangi On-Chain | Secure Community Savings Circles on Sui</title>
        <meta
          name="title"
          content="Njangi On-Chain | Secure Community Savings Circles on Sui"
        />
        <meta
          name="description"
          content="Run culturally grounded savings circles with clearer rules, auditable contributions, and low-friction onboarding through zkLogin on Sui."
        />
        <meta
          name="keywords"
          content="Njangi, ROSCA, Tontine, blockchain savings, Sui blockchain, zkLogin, community savings, USDC, USDT, SUI, BTC"
        />
        <meta name="robots" content="index, follow" />
        <meta name="language" content="English" />
        <meta name="author" content="Njangi On-Chain" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />

        <meta property="og:type" content="website" />
        <meta property="og:url" content={`${baseUrl}/`} />
        <meta
          property="og:title"
          content="Njangi On-Chain | Secure Community Savings Circles"
        />
        <meta
          property="og:description"
          content="A calmer, more accountable way to run community savings circles with zkLogin onboarding and transparent on-chain coordination."
        />
        <meta property="og:image" content={`${baseUrl}/og.png?v=2`} />
        <meta property="og:image:width" content="1200" />
        <meta property="og:image:height" content="630" />
        <meta
          property="og:image:alt"
          content="Njangi On-Chain — a 3D globe of diaspora savings circles linked across the world"
        />
        <meta property="og:site_name" content="Njangi On-Chain" />
        <meta property="og:locale" content="en_US" />

        <meta property="twitter:card" content="summary_large_image" />
        <meta property="twitter:url" content={`${baseUrl}/`} />
        <meta
          property="twitter:title"
          content="Njangi On-Chain | Secure Community Savings Circles"
        />
        <meta
          property="twitter:description"
          content="Run savings circles with transparent structure, cultural continuity, and low-friction social sign-in on Sui."
        />
        <meta property="twitter:image" content={`${baseUrl}/og.png?v=2`} />
        <meta property="twitter:site" content="@njangi_on_chain" />
        <meta property="twitter:creator" content="@njangi_on_chain" />

        <meta name="theme-color" content="#0a0a0c" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="Njangi On-Chain" />

        <link rel="canonical" href={`${baseUrl}/`} />

        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              '@context': 'https://schema.org',
              '@type': 'WebApplication',
              name: 'Njangi On-Chain',
              description: 'Secure, transparent savings circles on Sui blockchain',
              url: `${baseUrl}/`,
              applicationCategory: 'FinanceApplication',
              operatingSystem: 'Web',
              offers: {
                '@type': 'Offer',
                price: '0',
                priceCurrency: 'USD',
              },
              publisher: {
                '@type': 'Organization',
                name: 'Njangi On-Chain',
                url: `${baseUrl}/`,
                logo: {
                  '@type': 'ImageObject',
                  url: `${baseUrl}/njangi-on-chain-logo.png`,
                  width: 512,
                  height: 512,
                },
                sameAs: [
                  'https://x.com/njangi_on_chain',
                  'https://www.instagram.com/njangionchain',
                ],
              },
              featureList: [
                'Shared circle visibility',
                'Direct on-chain settlement',
                'zkLogin authentication',
                'Multi-asset support',
                'Smart contract transparency',
              ],
              supportedPaymentMethod: [
                'Cryptocurrency',
                'USDC',
                'USDT',
                'SUI',
                'Bitcoin',
              ],
            }),
          }}
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              '@context': 'https://schema.org',
              '@type': 'Organization',
              name: 'Njangi On-Chain',
              alternateName: 'Njangi',
              url: `${baseUrl}/`,
              logo: `${baseUrl}/njangi-on-chain-logo.png`,
              description:
                'A blockchain-native operating layer for community savings circles',
              foundingDate: '2024',
              industry: 'Financial Technology',
              sameAs: [
                'https://x.com/njangi_on_chain',
                'https://www.instagram.com/njangionchain',
              ],
              contactPoint: {
                '@type': 'ContactPoint',
                email: SUPPORT_EMAIL,
                contactType: 'Customer Service',
              },
            }),
          }}
        />
      </Head>

      <div
        className={`${bodyFont.className} relative min-h-screen overflow-x-clip bg-[#0a0a0c] text-[#f3efe6]`}
      >
        {/* Skip link — first focusable element for keyboard users */}
        <a
          href="#main"
          className="sr-only rounded-full focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[60] focus:bg-[#E8B04B] focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-[#1a1304]"
        >
          Skip to content
        </a>

        {/* Ambient depth field (desktop only) + base glow, behind all content */}
        <div
          aria-hidden
          className="pointer-events-none fixed inset-0"
          style={{
            zIndex: 0,
            background:
              'radial-gradient(1100px circle at 82% -8%, rgba(232,176,75,0.10), transparent 55%), radial-gradient(900px circle at 0% 100%, rgba(77,162,255,0.06), transparent 55%)',
          }}
        />
        <AmbientField />

        <Dialog.Root
          open={isNetworkSwitchModalOpen}
          onOpenChange={setIsNetworkSwitchModalOpen}
        >
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-50 bg-[#05050a]/70 backdrop-blur-sm" />
            <Dialog.Content
              className={`fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 -translate-y-1/2 rounded-3xl border border-[#2a2620] bg-[#13121a] p-6 shadow-[0_40px_120px_-40px_rgba(0,0,0,0.9)] sm:p-7 ${bodyFont.className}`}
            >
              <div className="pr-10">
                <Dialog.Title
                  className={`${wordmarkFont.className} text-2xl tracking-[-0.02em] text-[#f5f1e8]`}
                >
                  {t('landing.networkSwitchTitle', {
                    network: pendingNetwork
                      ? NETWORK_CONFIG[pendingNetwork].networkName
                      : '',
                  })}
                </Dialog.Title>
                <Dialog.Description className="mt-3 text-sm leading-6 text-[#a8a294]">
                  {t('landing.networkSwitchBody')}
                </Dialog.Description>
              </div>

              <div className={`${mutedCardClass} mt-6 p-4`}>
                <ul className="space-y-2 text-sm leading-6 text-[#cfc8ba]">
                  <li>Generate a different wallet address for the same account.</li>
                  <li>Require a fresh sign-in before continuing.</li>
                  <li>Show circles and balances from the selected network only.</li>
                </ul>
                <p className="mt-4 text-sm font-medium text-[#E8B04B]">
                  The wallet you use on{' '}
                  {pendingNetwork
                    ? NETWORK_CONFIG[pendingNetwork].networkName.toLowerCase()
                    : 'the selected network'}{' '}
                  is separate from the other environment.
                </p>
              </div>

              <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
                <button
                  type="button"
                  onClick={cancelNetworkSwitch}
                  className="rounded-full border border-[#2a2620] bg-white/[0.03] px-5 py-3 text-sm font-semibold text-[#f3efe6] transition-colors duration-200 hover:bg-white/[0.07] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f6d99a] focus-visible:ring-offset-2 focus-visible:ring-offset-[#13121a]"
                >
                  {t('landing.networkSwitchStay')}
                </button>
                <button
                  type="button"
                  onClick={confirmNetworkSwitch}
                  className={goldButtonClass}
                >
                  {t('landing.networkSwitchConfirm', {
                    network: pendingNetwork
                      ? NETWORK_CONFIG[pendingNetwork].networkName
                      : '',
                  })}
                </button>
              </div>

              <Dialog.Close asChild>
                <button
                  type="button"
                  onClick={cancelNetworkSwitch}
                  className="absolute right-5 top-5 rounded-full border border-[#2a2620] bg-white/[0.03] p-3 text-[#a8a294] transition-colors duration-200 hover:text-[#f5f1e8] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f6d99a]"
                >
                  <X className="h-4 w-4" />
                  <span className="sr-only">Close</span>
                </button>
              </Dialog.Close>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>

        <Dialog.Root open={isAuthDialogOpen} onOpenChange={setIsAuthDialogOpen}>
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-50 bg-[#05050a]/70 backdrop-blur-sm" />
            <Dialog.Content
              className={`fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 -translate-y-1/2 rounded-3xl border border-[#2a2620] bg-[#13121a] p-5 shadow-[0_40px_120px_-40px_rgba(0,0,0,0.9)] sm:p-7 ${bodyFont.className}`}
            >
              <div className="pr-10">
                <Dialog.Title
                  className={`${wordmarkFont.className} text-2xl tracking-[-0.02em] text-[#f5f1e8]`}
                >
                  {t('landing.signInTitle')}
                </Dialog.Title>
                <Dialog.Description className="mt-3 text-sm leading-6 text-[#a8a294]">
                  {t('landing.signInBody')}
                </Dialog.Description>
              </div>

              <div className={`${mutedCardClass} mt-6 p-4 sm:p-5`}>
                <LoginButton variant="landing" />
              </div>

              <div className="mt-5 flex flex-wrap items-center gap-4 text-sm text-[#a8a294]">
                <span className="inline-flex items-center gap-2">
                  <BadgeCheck className="h-4 w-4 text-[#E8B04B]" />
                  {t('landing.noSeedPhrase')}
                </span>
                <span className="inline-flex items-center gap-2">
                  <BadgeCheck className="h-4 w-4 text-[#E8B04B]" />
                  {t('landing.builtForCircles')}
                </span>
              </div>

              <Dialog.Close asChild>
                <button
                  type="button"
                  className="absolute right-5 top-5 rounded-full border border-[#2a2620] bg-white/[0.03] p-3 text-[#a8a294] transition-colors duration-200 hover:text-[#f5f1e8] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f6d99a]"
                >
                  <X className="h-4 w-4" />
                  <span className="sr-only">Close sign-in options</span>
                </button>
              </Dialog.Close>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>

        <div className="relative z-10">
          <header className="sticky top-0 z-30 border-b border-[#2a2620]/80 bg-[#0a0a0c]/70 backdrop-blur-md">
            <div className="mx-auto flex max-w-6xl flex-col gap-4 px-5 py-4 sm:px-8 lg:flex-row lg:items-center lg:justify-between">
              <Link href="/" className="flex min-w-0 items-center gap-3">
                <span className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-full border border-white/10 bg-white/[0.04]">
                  <Image
                    src="/njangi-on-chain-logo.png"
                    alt="Njangi On-Chain"
                    width={80}
                    height={80}
                    className="h-full w-full scale-[2.25] object-contain"
                    priority
                    unoptimized
                  />
                </span>
                <span className="min-w-0">
                  <span
                    className={`${wordmarkFont.className} block truncate text-[1.9rem] leading-none tracking-[-0.04em] text-[#f5f1e8]`}
                  >
                    Njangi
                  </span>
                  <span className="mt-1 block truncate pl-0.5 text-[0.62rem] font-semibold uppercase tracking-[0.42em] text-[#E8B04B]">
                    On-chain
                  </span>
                </span>
              </Link>

              <div className="flex flex-col gap-3 sm:items-end">
                <nav className="flex flex-wrap items-center gap-5 text-sm font-medium">
                  <Link href="/learn" className={socialLinkClass}>
                    {t('nav.learn')}
                  </Link>
                  <Link href="/faq" className={socialLinkClass}>
                    {t('nav.faq')}
                  </Link>
                  <Link href="#launch" className={socialLinkClass}>
                    {t('nav.mainnetUpdates')}
                  </Link>
                  <LocaleSwitcher compact variant="dark" />
                </nav>

                <div className="flex flex-wrap items-center gap-3">
                  <div className="inline-flex items-center rounded-full border border-[#2a2620] bg-[#13121a]/70 p-1">
                    <button
                      type="button"
                      aria-pressed={network === 'testnet'}
                      onClick={() => switchNetwork('testnet')}
                      className={`inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-sm font-semibold transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f6d99a] ${
                        network === 'testnet'
                          ? 'bg-[#E8B04B] text-[#1a1304]'
                          : 'text-[#a8a294] hover:text-[#f5f1e8]'
                      }`}
                    >
                      {network === 'testnet' && <BadgeCheck className="h-3.5 w-3.5" />}
                      {t('nav.testnet')}
                    </button>
                    <button
                      type="button"
                      aria-pressed={network === 'mainnet'}
                      onClick={() => switchNetwork('mainnet')}
                      className={`inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-sm font-semibold transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f6d99a] ${
                        network === 'mainnet'
                          ? 'bg-[#E8B04B] text-[#1a1304]'
                          : 'text-[#a8a294] hover:text-[#f5f1e8]'
                      }`}
                    >
                      {network === 'mainnet' && <BadgeCheck className="h-3.5 w-3.5" />}
                      {t('nav.mainnet')}
                    </button>
                  </div>

                  <div className="hidden items-center gap-2 rounded-full border border-[#2a2620] bg-[#13121a]/60 px-3 py-2 text-sm text-[#a8a294] sm:inline-flex">
                    <CircleDot className="h-4 w-4 text-[#4DA2FF]" />
                    {t('nav.viewing', { network: currentNetworkName })}
                  </div>

                  {account ? (
                    <Link href="/dashboard" className={goldButtonClass}>
                      {t('nav.openDashboard')}
                      <ArrowRight className="h-4 w-4" />
                    </Link>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setIsAuthDialogOpen(true)}
                      className={goldButtonClass}
                    >
                      {t('nav.login')}
                      <ArrowRight className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </div>
            </div>
          </header>

          <main>
            {/* ===================== HERO ===================== */}
            <section
              id="main"
              className="relative flex min-h-[100svh] items-center overflow-hidden"
            >
              {/* genuine 3D scene + CSS fallback behind it */}
              <div className="absolute inset-0">
                <div
                  aria-hidden
                  className="absolute inset-0"
                  style={{
                    background:
                      'radial-gradient(820px circle at 72% 44%, rgba(232,176,75,0.18), transparent 62%), #0a0a0c',
                  }}
                />
                <DiasporaMeridian />
              </div>

              {/* legibility scrim — darkened on BOTH sides so copy reads in LTR + RTL */}
              <div
                aria-hidden
                className="pointer-events-none absolute inset-0"
                style={{
                  background:
                    'linear-gradient(90deg, rgba(10,10,12,0.92) 0%, rgba(10,10,12,0.55) 34%, rgba(10,10,12,0.22) 50%, rgba(10,10,12,0.5) 66%, rgba(10,10,12,0.9) 100%)',
                }}
              />
              <div
                aria-hidden
                className="pointer-events-none absolute inset-0"
                style={{
                  background:
                    'linear-gradient(180deg, rgba(10,10,12,0.5) 0%, transparent 22%, transparent 62%, rgba(10,10,12,0.95) 100%)',
                }}
              />

              <div className="relative z-20 mx-auto w-full max-w-6xl px-5 py-24 sm:px-8">
                <div className="max-w-2xl">
                  <Reveal>
                    <RevealItem>
                      <p className={sectionEyebrowClass}>{t('landing.eyebrow')}</p>
                    </RevealItem>
                    <RevealItem>
                      <p
                        className={`${wordmarkFont.className} mt-5 flex flex-wrap items-baseline gap-x-3 text-2xl text-[#EDE4D3] sm:text-[1.75rem]`}
                      >
                        <span className="sr-only">{t('landing.heritageAlso')}</span>
                        <KineticNames
                          names={CULTURAL_NAMES}
                          className="text-gold-gradient"
                          interval={1900}
                        />
                        <span className="text-base font-normal tracking-[0.04em] text-[#8b8578] sm:text-lg">
                          one tradition, many names
                        </span>
                      </p>
                    </RevealItem>
                    <RevealItem>
                      <h1
                        className={`${wordmarkFont.className} mt-4 text-[clamp(2.5rem,6vw,4.6rem)] font-normal leading-[1.02] tracking-[-0.01em] text-[#f8f4ec]`}
                      >
                        {t('landing.heroTitle')}
                      </h1>
                    </RevealItem>
                    <RevealItem>
                      <p className="mt-6 max-w-xl text-lg leading-8 text-[#cfc8ba] sm:text-xl">
                        {t('landing.heroSubtitle')}
                      </p>
                    </RevealItem>
                    <RevealItem>
                      <div className="mt-9 flex flex-wrap items-center gap-3">
                        {account ? (
                          <Link href="/dashboard" className={goldButtonClass}>
                            {t('nav.openDashboard')}
                            <ArrowRight className="h-4 w-4" />
                          </Link>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setIsAuthDialogOpen(true)}
                            className={goldButtonClass}
                          >
                            {t('landing.heroPrimaryCta')}
                            <ArrowRight className="h-4 w-4" />
                          </button>
                        )}
                        <Link href="#how" className={ghostButtonClass}>
                          {t('landing.exploreHowItWorks')}
                        </Link>
                      </div>
                      <p className="mt-3 text-sm leading-6 text-[#8b8578]">
                        {t('landing.heroCtaReassure')}
                      </p>
                    </RevealItem>
                    <RevealItem>
                      <div className="mt-7 flex flex-wrap gap-3">
                        <span className={chipClass}>
                          <BadgeCheck className="h-4 w-4 text-[#E8B04B]" />
                          {t('landing.noSeedPhrase')}
                        </span>
                        <span className={chipClass}>
                          <BadgeCheck className="h-4 w-4 text-[#E8B04B]" />
                          {t('landing.builtForCircles')}
                        </span>
                      </div>
                    </RevealItem>
                    <RevealItem>
                      <p className="mt-6 max-w-md text-sm leading-6 text-[#f6d99a]">
                        {t('landing.testnetNote')}
                      </p>
                    </RevealItem>
                    <RevealItem>
                      <dl className="mt-10 grid max-w-lg grid-cols-3 gap-3">
                        {proofItems.map((item) => (
                          <div key={item.label} className={`${mutedCardClass} p-4`}>
                            <dt className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#8b8578]">
                              {item.label}
                            </dt>
                            <dd className="mt-2 text-xl font-semibold tracking-[-0.02em] text-[#f5f1e8]">
                              {item.value}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    </RevealItem>
                  </Reveal>
                </div>
              </div>

              <div
                aria-hidden
                className="pointer-events-none absolute bottom-6 left-1/2 z-20 -translate-x-1/2 text-[#8b8578]"
              >
                <ChevronDown className="h-6 w-6 animate-bounce" />
              </div>
            </section>

            {/* ============== INSIDE A LIVE CIRCLE ============== */}
            <section className="relative px-5 py-20 sm:px-8 md:py-28">
              <div className="mx-auto max-w-6xl">
                <Reveal className="grid gap-10 lg:grid-cols-[0.9fr_1.1fr] lg:items-center">
                  <RevealItem className="min-w-0">
                    <p className={sectionEyebrowClass}>Circle operations</p>
                    <h2 className={sectionTitleClass}>
                      Less noise. More clarity for members.
                    </h2>
                    <p className={sectionBodyClass}>
                      Every contribution, turn, and approval lives in one shared
                      view — so the circle runs on the same facts instead of one
                      organizer&apos;s memory.
                    </p>
                    <p className="mt-8 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#8b8578]">
                      Illustrative example
                    </p>
                    <div className="mt-3 grid grid-cols-2 gap-3">
                      {previewStats.map((stat) => (
                        <div key={stat.label} className={`${mutedCardClass} p-4`}>
                          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#8b8578]">
                            {stat.label}
                          </p>
                          <p className="mt-2 text-lg font-semibold tracking-[-0.02em] text-[#f5f1e8]">
                            {stat.value}
                          </p>
                          <p className="mt-2 text-sm leading-6 text-[#a8a294]">
                            {stat.caption}
                          </p>
                        </div>
                      ))}
                    </div>
                  </RevealItem>

                  <RevealItem className="min-w-0">
                    <TiltCard>
                      <div className={`${glassCardClass} bg-weave relative overflow-hidden p-6 md:p-8`}>
                        <div className="flex items-center justify-between gap-3">
                          <p className="text-sm font-semibold text-[#f5f1e8]">
                            What a cycle looks like
                          </p>
                          <span className="inline-flex items-center gap-2 rounded-full border border-[#2a2620] px-3 py-1 text-xs font-medium uppercase tracking-[0.18em] text-[#8b8578]">
                            Example cycle
                          </span>
                        </div>
                        <div className="mt-5 space-y-3">
                          {cycleSnapshot.map((row) => (
                            <div
                              key={row.title}
                              className="flex items-start gap-3 rounded-2xl border border-[#221f29] bg-[#0d0c12]/70 px-4 py-3"
                            >
                              <row.icon className="mt-0.5 h-4 w-4 shrink-0 text-[#E8B04B]" />
                              <div>
                                <p className="text-sm font-semibold text-[#f5f1e8]">
                                  {row.title}
                                </p>
                                <p className="mt-1 text-sm leading-6 text-[#a8a294]">
                                  {row.body}
                                </p>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </TiltCard>
                  </RevealItem>
                </Reveal>
              </div>
            </section>

            {/* ================= HOW IT WORKS ================= */}
            <section id="how" className="relative px-5 py-20 sm:px-8 md:py-28">
              <div className="mx-auto max-w-6xl">
                <Reveal className="max-w-2xl">
                  <RevealItem>
                    <p className={sectionEyebrowClass}>{t('landing.workflow.eyebrow')}</p>
                  </RevealItem>
                  <RevealItem>
                    <h2 className={sectionTitleClass}>{t('landing.workflow.title')}</h2>
                  </RevealItem>
                  <RevealItem>
                    <p className={sectionBodyClass}>{t('landing.workflow.body')}</p>
                  </RevealItem>
                </Reveal>

                <Reveal className="mt-12 grid gap-4 md:grid-cols-3">
                  {WORKFLOW_STEPS.map((step) => (
                    <RevealItem key={step.number} className="h-full">
                      <TiltCard className="h-full">
                        <div className={`${glassCardClass} bg-weave relative h-full overflow-hidden p-6 md:p-7`}>
                          <p className="text-sm font-semibold tracking-[0.24em] text-[#E8B04B]">
                            {step.number}
                          </p>
                          <h3 className="mt-5 text-lg font-semibold tracking-[-0.02em] text-[#f5f1e8]">
                            {t(step.titleKey)}
                          </h3>
                          <p className="mt-3 text-sm leading-6 text-[#a8a294]">
                            {t(step.descriptionKey)}
                          </p>
                        </div>
                      </TiltCard>
                    </RevealItem>
                  ))}
                </Reveal>
              </div>
            </section>

            {/* =================== FEATURES =================== */}
            <section className="relative px-5 py-20 sm:px-8 md:py-28">
              <div className="mx-auto max-w-6xl">
                <Reveal className="max-w-2xl">
                  <RevealItem>
                    <p className={sectionEyebrowClass}>{t('landing.features.eyebrow')}</p>
                  </RevealItem>
                  <RevealItem>
                    <h2 className={sectionTitleClass}>{t('landing.features.title')}</h2>
                  </RevealItem>
                  <RevealItem>
                    <p className={sectionBodyClass}>{t('landing.features.body')}</p>
                  </RevealItem>
                </Reveal>

                <Reveal className="mt-12 grid gap-4 sm:grid-cols-2">
                  {FEATURE_CARDS.map(({ icon: Icon, titleKey, descriptionKey }) => (
                    <RevealItem key={titleKey} className="h-full">
                      <TiltCard className="h-full">
                        <div className={`${glassCardClass} bg-weave relative h-full overflow-hidden p-6 md:p-7`}>
                          <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-[#2a2620] bg-[#E8B04B]/10 text-[#E8B04B]">
                            <Icon className="h-5 w-5" />
                          </div>
                          <h3 className="mt-6 text-xl font-semibold tracking-[-0.02em] text-[#f5f1e8]">
                            {t(titleKey)}
                          </h3>
                          <p className="mt-3 text-sm leading-6 text-[#a8a294] sm:text-base">
                            {t(descriptionKey)}
                          </p>
                        </div>
                      </TiltCard>
                    </RevealItem>
                  ))}
                </Reveal>
              </div>
            </section>

            {/* ================== COMPARISON ================== */}
            <section className="relative px-5 py-20 sm:px-8 md:py-28">
              <div className="mx-auto max-w-6xl">
                <Reveal className="max-w-3xl">
                  <RevealItem>
                    <p className={sectionEyebrowClass}>Why this shape matters</p>
                  </RevealItem>
                  <RevealItem>
                    <h2 className={sectionTitleClass}>
                      Positioned between informal coordination and generic fintech.
                    </h2>
                  </RevealItem>
                  <RevealItem>
                    <p className={sectionBodyClass}>
                      Traditional circles carry social strength. Modern financial
                      apps carry infrastructure. Njangi On-Chain keeps the first
                      while borrowing only the useful parts of the second.
                    </p>
                  </RevealItem>
                </Reveal>

                <div className={`${glassCardClass} mt-12 hidden overflow-hidden lg:block`}>
                  <div className="grid grid-cols-[0.9fr_1fr_1.05fr_1fr] border-b border-[#2a2620] bg-[#0d0c12]/70">
                    <div className="px-6 py-4 text-xs font-semibold uppercase tracking-[0.22em] text-[#8b8578]">
                      Operating lens
                    </div>
                    <div className="px-6 py-4 text-xs font-semibold uppercase tracking-[0.22em] text-[#8b8578]">
                      Traditional circle
                    </div>
                    <div className="border-t-2 border-[#C8902F] bg-[#E8B04B]/[0.06] px-6 py-4 text-xs font-semibold uppercase tracking-[0.22em] text-[#E8B04B]">
                      Njangi On-Chain
                    </div>
                    <div className="px-6 py-4 text-xs font-semibold uppercase tracking-[0.22em] text-[#8b8578]">
                      Banks and fintech
                    </div>
                  </div>

                  {COMPARISON_ROWS.map((row, index) => (
                    <div
                      key={row.label}
                      className={`grid grid-cols-[0.9fr_1fr_1.05fr_1fr] ${
                        index !== 0 ? 'border-t border-[#221f29]' : ''
                      }`}
                    >
                      <div className="px-6 py-5 text-sm font-semibold text-[#f5f1e8]">
                        {row.label}
                      </div>
                      <div className="px-6 py-5 text-sm leading-6 text-[#a8a294]">
                        {row.traditional}
                      </div>
                      <div className="bg-[#E8B04B]/[0.06] px-6 py-5 text-sm font-medium leading-6 text-[#f3efe6]">
                        {row.onchain}
                      </div>
                      <div className="px-6 py-5 text-sm leading-6 text-[#a8a294]">
                        {row.fintech}
                      </div>
                    </div>
                  ))}
                </div>

                <div className="mt-12 grid gap-4 lg:hidden">
                  {COMPARISON_CARDS.map((card) => (
                    <div
                      key={card.title}
                      className={`rounded-3xl border p-6 ${
                        card.highlight
                          ? 'border-[#C8902F]/60 bg-[#E8B04B]/[0.06] text-[#f3efe6]'
                          : 'border-[#2a2620] bg-[#13121a]/70 text-[#a8a294]'
                      }`}
                    >
                      <h3
                        className={`text-xl font-semibold tracking-[-0.02em] ${
                          card.highlight ? 'text-[#E8B04B]' : 'text-[#f5f1e8]'
                        }`}
                      >
                        {card.title}
                      </h3>
                      <ul className="mt-5 space-y-3 text-sm leading-6">
                        {card.items.map((item) => (
                          <li key={item} className="flex items-start gap-3">
                            <span className="mt-2 h-1.5 w-1.5 rounded-full bg-[#E8B04B]" />
                            <span>{item}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </div>
            </section>

            {/* =================== TRADITION =================== */}
            <section className="relative overflow-hidden px-5 py-20 sm:px-8 md:py-28">
              <div
                aria-hidden
                className="bg-rings pointer-events-none absolute inset-0"
              />
              <div className="relative mx-auto max-w-4xl text-center">
                <Reveal>
                  <RevealItem>
                    <p className={sectionEyebrowClass}>{t('landing.tradition.eyebrow')}</p>
                  </RevealItem>
                  <RevealItem>
                    <h2
                      className={`${wordmarkFont.className} mt-4 text-[clamp(2rem,4vw,3rem)] font-normal leading-[1.06] tracking-[-0.01em] text-[#f5f1e8]`}
                    >
                      {t('landing.tradition.title')}
                    </h2>
                  </RevealItem>
                  <RevealItem>
                    <p className={`${sectionBodyClass} mx-auto`}>
                      {t('landing.tradition.body')}
                    </p>
                  </RevealItem>
                </Reveal>

                <Reveal className="mt-10 flex flex-wrap justify-center gap-2.5">
                  {CULTURAL_NAMES.map((name) => (
                    <RevealItem key={name}>
                      <span className="rounded-full border border-[#2a2620] bg-[#13121a]/70 px-4 py-2 text-sm font-medium text-[#EDE4D3]">
                        {name}
                      </span>
                    </RevealItem>
                  ))}
                </Reveal>
              </div>
            </section>

            {/* ================= LAUNCH / WAITLIST ================= */}
            <section id="launch" className="relative px-5 py-20 sm:px-8 md:py-28">
              <div className="mx-auto max-w-6xl">
                <div className="relative overflow-hidden rounded-3xl border border-[#2a2620]/40 bg-[#13121a]/70 p-7 shadow-[0_20px_60px_-30px_rgba(0,0,0,0.85)] backdrop-blur-sm sm:p-9 lg:p-10">
                  <div aria-hidden className="bg-rings pointer-events-none absolute inset-0" />
                  {/* Soft corner vignette — the card melts into the page at the
                      edges while the center stays fully readable. */}
                  <div
                    aria-hidden
                    className="pointer-events-none absolute inset-0"
                    style={{
                      background:
                        'radial-gradient(125% 115% at 50% 42%, transparent 46%, rgba(10,10,12,0.82) 100%)',
                    }}
                  />
                  <div className="relative grid gap-10 lg:grid-cols-[0.95fr_1.05fr] lg:items-start">
                    <Reveal className="min-w-0 max-w-xl">
                      <RevealItem>
                        <p className={sectionEyebrowClass}>{t('landing.launch.eyebrow')}</p>
                      </RevealItem>
                      <RevealItem>
                        <h2 className={sectionTitleClass}>{t('landing.launch.title')}</h2>
                      </RevealItem>
                      <RevealItem>
                        <p className={sectionBodyClass}>{t('landing.launch.body')}</p>
                      </RevealItem>
                      <RevealItem>
                        <div className="mt-8 space-y-3">
                          {launchNotes.map((note) => (
                            <div
                              key={note}
                              className="flex items-start gap-3 rounded-2xl border border-[#221f29] bg-[#0d0c12]/70 px-4 py-3"
                            >
                              <BadgeCheck className="mt-0.5 h-4 w-4 shrink-0 text-[#E8B04B]" />
                              <p className="text-sm leading-6 text-[#a8a294]">{note}</p>
                            </div>
                          ))}
                        </div>
                      </RevealItem>
                    </Reveal>

                    <div className={`${mutedCardClass} min-w-0 p-6 sm:p-7`}>
                      <div className="inline-flex items-center gap-2 rounded-full border border-[#2a2620] bg-[#0d0c12]/70 px-3 py-2 text-sm font-medium text-[#a8a294]">
                        <Mail className="h-4 w-4 text-[#E8B04B]" />
                        {t('landing.launch.eyebrow')}
                      </div>

                      <form
                        onSubmit={handleMainnetSignup}
                        className="mt-6 flex flex-col gap-3"
                      >
                        <label htmlFor="mainnet-email" className="sr-only">
                          {t('landing.launch.emailPlaceholder')}
                        </label>
                        <input
                          id="mainnet-email"
                          type="email"
                          placeholder={t('landing.launch.emailPlaceholder')}
                          value={signupEmail}
                          onChange={(e) => setSignupEmail(e.target.value)}
                          required
                          disabled={isSignupLoading}
                          className="w-full rounded-xl border border-[#2a2620] bg-[#0d0c12] px-5 py-4 text-base text-[#f3efe6] outline-none transition-colors duration-200 placeholder:text-[#a89e8d] focus:border-[#E8B04B] focus-visible:ring-2 focus-visible:ring-[#f6d99a] disabled:cursor-not-allowed disabled:opacity-60"
                        />
                        <button
                          type="submit"
                          disabled={isSignupLoading}
                          className={`${goldButtonClass} w-full py-4 disabled:cursor-not-allowed disabled:opacity-60`}
                        >
                          {isSignupLoading
                            ? t('landing.launch.signingUp')
                            : t('landing.launch.notifyButton')}
                        </button>
                      </form>

                      {signupMessage && (
                        <div
                          className={`mt-4 rounded-2xl border px-4 py-3 text-sm ${
                            showSignupSuccess
                              ? 'border-[#2e6b46] bg-[#102a1c] text-[#7ee2a8]'
                              : 'border-[#6b2e2e] bg-[#2a1010] text-[#f0a8a8]'
                          }`}
                        >
                          {signupMessage}
                        </div>
                      )}

                      <p className="mt-4 text-sm leading-6 text-[#8b8578]">
                        {t('landing.launch.disclaimer')}
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </section>

            {/* ===================== FAQ ===================== */}
            <section className="relative px-5 py-20 sm:px-8 md:py-28">
              <div className="mx-auto max-w-4xl">
                <Reveal className="text-center">
                  <RevealItem>
                    <p className={sectionEyebrowClass}>{t('landing.faq.eyebrow')}</p>
                  </RevealItem>
                  <RevealItem>
                    <h2 className={sectionTitleClass}>{t('landing.faq.title')}</h2>
                  </RevealItem>
                  <RevealItem>
                    <p className={`${sectionBodyClass} mx-auto`}>{t('landing.faq.body')}</p>
                  </RevealItem>
                </Reveal>

                <div className="mt-12 space-y-4">
                  {FAQ_ITEMS.map((item) => (
                    <div key={item.id} className={`${glassCardClass} overflow-hidden`}>
                      <button
                        type="button"
                        id={`faq-q-${item.id}`}
                        onClick={() => toggleFaqItem(item.id)}
                        aria-expanded={openFaqItems[item.id]}
                        aria-controls={`faq-panel-${item.id}`}
                        className="flex w-full items-center justify-between gap-4 px-6 py-5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#f6d99a] sm:px-7"
                      >
                        <span className="text-lg font-semibold tracking-[-0.02em] text-[#f5f1e8]">
                          {t(item.questionKey)}
                        </span>
                        <ChevronDown
                          className={`h-5 w-5 shrink-0 text-[#E8B04B] transition-transform duration-200 ${
                            openFaqItems[item.id] ? 'rotate-180' : ''
                          }`}
                        />
                      </button>
                      <div
                        id={`faq-panel-${item.id}`}
                        role="region"
                        aria-labelledby={`faq-q-${item.id}`}
                        hidden={!openFaqItems[item.id]}
                        className="border-t border-[#221f29] px-6 pb-6 pt-4 sm:px-7"
                      >
                        <p className="text-sm leading-7 text-[#a8a294] sm:text-base">
                          {t(item.answerKey)}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="mt-8 flex flex-col items-center justify-center gap-3 text-sm font-semibold sm:flex-row">
                  <Link
                    href="/learn"
                    className="inline-flex items-center gap-2 py-2.5 text-[#cfc8ba] transition-colors duration-200 hover:text-[#f6d99a] focus-visible:outline-none focus-visible:underline focus-visible:underline-offset-4"
                  >
                    {t('landing.faq.learnLink')}
                    <ArrowRight className="h-4 w-4" />
                  </Link>
                  <Link
                    href="/faq"
                    className="inline-flex items-center gap-2 py-2.5 text-[#cfc8ba] transition-colors duration-200 hover:text-[#f6d99a] focus-visible:outline-none focus-visible:underline focus-visible:underline-offset-4"
                  >
                    {t('landing.faq.fullFaqLink')}
                    <ArrowRight className="h-4 w-4" />
                  </Link>
                </div>
              </div>
            </section>
          </main>

          <footer className="relative border-t border-[#2a2620] bg-[#0a0a0c]/80">
            <div className="bg-weave pointer-events-none absolute inset-0" aria-hidden />
            <div className="relative mx-auto max-w-6xl px-5 py-10 sm:px-8">
              <div className="flex flex-col gap-8 lg:flex-row lg:items-start lg:justify-between">
                <div className="flex items-center gap-4">
                  <span className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-full border border-white/10 bg-white/[0.04]">
                    <Image
                      src="/njangi-on-chain-logo.png"
                      alt="Njangi On-Chain"
                      width={72}
                      height={72}
                      className="h-full w-full scale-[2.2] object-contain"
                      unoptimized
                    />
                  </span>
                  <div>
                    <p
                      className={`${wordmarkFont.className} text-[1.9rem] leading-none tracking-[-0.04em] text-[#f5f1e8]`}
                    >
                      Njangi
                    </p>
                    <p className="mt-1 text-[0.62rem] font-semibold uppercase tracking-[0.42em] text-[#E8B04B]">
                      On-chain
                    </p>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
                  <Link href="/learn" className={socialLinkClass}>
                    {t('nav.learn')}
                  </Link>
                  <Link href="/faq" className={socialLinkClass}>
                    {t('nav.faq')}
                  </Link>
                  <a
                    href="https://x.com/njangi_on_chain"
                    target="_blank"
                    rel="noopener noreferrer"
                    className={socialLinkClass}
                  >
                    X
                  </a>
                  <a
                    href="https://www.instagram.com/njangionchain"
                    target="_blank"
                    rel="noopener noreferrer"
                    className={socialLinkClass}
                  >
                    Instagram
                  </a>
                  <a href={SUPPORT_MAILTO} className={socialLinkClass}>
                    Email
                  </a>
                </div>
              </div>

              <div className="mt-8 flex flex-col gap-2 border-t border-[#221f29] pt-4 text-sm text-[#8b8578] sm:flex-row sm:items-center sm:justify-between">
                <p>{t('landing.footer.rights', { year: new Date().getFullYear() })}</p>
                <LegalFooter />
                <p>{t('landing.footer.tagline')}</p>
              </div>
            </div>
          </footer>
        </div>
      </div>
    </>
  );
}
