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
import { useAuth } from '../contexts/AuthContext';
import { LoginButton } from '../components/LoginButton';
import { LegalFooter } from '../components/LegalFooter';
import { LocaleSwitcher } from '../components/ui/LocaleSwitcher';
import { useTranslation } from '../hooks/useTranslation';
import { getNetworkConfig, setCurrentNetwork } from '../services/network-config';
import { SUPPORT_EMAIL, SUPPORT_MAILTO } from '../lib/constants';

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
  'Iqub',
  'Kikoba',
  'Mujin',
  'Njangi',
  'Paluwagan',
  'Pandero',
  'ROSCA',
  'Samity',
  'Sou-sou',
  'Stokvel',
  'Tanda',
  'Tontine',
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
    tone: 'border-[#d8d1c5] bg-white text-[#4b5565]',
    items: [
      'Relationship-based coordination',
      'Cash or manual transfer collection',
      'Strong social trust, lighter operational tooling',
      'Limited visibility outside organizers and chat threads',
    ],
  },
  {
    title: 'Njangi On-Chain',
    tone: 'border-[#cfd7e3] bg-[#f3f6fb] text-[#334155]',
    items: [
      'Shared visibility for turns, contributions, and approvals',
      'Direct wallet settlement with self-custody',
      'Social sign-in through zkLogin',
      'A calmer operating layer for distributed communities',
    ],
  },
  {
    title: 'Banks and fintech apps',
    tone: 'border-[#d8d1c5] bg-white text-[#4b5565]',
    items: [
      'Built around individual accounts',
      'Provider-controlled custody and rules',
      'Geographic and product restrictions',
      'Little support for culturally specific circle workflows',
    ],
  },
];

const FAQ_ITEMS = [
  {
    id: 'what-is-njangi',
    question: 'What is a Njangi?',
    answer:
      'A Njangi is a rotating community savings structure where members contribute on a shared schedule and each member receives the pooled amount in turn. Similar systems exist globally under many different names.',
  },
  {
    id: 'why-onchain',
    question: 'Why put a savings circle on-chain?',
    answer:
      'The point is not novelty. The point is clarity. On-chain records make contributions, payout order, and settlement easier to verify, especially when members are distributed across cities or countries.',
  },
  {
    id: 'do-i-need-crypto',
    question: 'Do members need deep crypto experience?',
    answer:
      'No. zkLogin lowers the onboarding burden by letting members start with a familiar social account while still receiving a wallet tied to the selected network.',
  },
  {
    id: 'network-switching',
    question: 'What happens when I switch between testnet and mainnet?',
    answer:
      'Your wallet address changes because each network has its own state. The app clears the current session so the selected environment stays clean and consistent.',
  },
];

const socialLinkClass =
  'text-sm font-medium text-[#556070] transition-colors duration-200 hover:text-[#171923]';

export default function Home() {
  const router = useRouter();
  const { account } = useAuth();
  const { t } = useTranslation();
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
          setCircleCount(3);
        }
      } catch (error) {
        console.error('Error fetching circle count:', error);
        setCircleCount(3);
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
      label: t('landing.proof.currentEnvironment'),
      value: currentNetworkName,
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

  const sectionEyebrowClass =
    'text-[11px] font-semibold uppercase tracking-[0.28em] text-[#717784]';
  const sectionTitleClass =
    'mt-4 text-3xl font-semibold tracking-[-0.04em] text-[#171923] sm:text-4xl md:text-[2.75rem] md:leading-[1.05]';
  const sectionBodyClass =
    'mt-4 max-w-2xl text-base leading-7 text-[#596170] sm:text-lg';
  const shellCardClass =
    'rounded-[30px] border border-[#ddd5c9] bg-white/88 shadow-[0_30px_90px_-62px_rgba(15,23,42,0.42)] backdrop-blur';
  const mutedCardClass = 'rounded-[24px] border border-[#e9e1d6] bg-[#fbfaf7]';
  const topNavPrimaryActionClass =
    'inline-flex items-center gap-2 rounded-full bg-[#1d2533] px-4 py-2.5 text-sm font-semibold text-white shadow-[0_18px_44px_-34px_rgba(15,23,42,0.45)] transition-all duration-200 hover:-translate-y-0.5 hover:bg-[#101723]';

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
        <meta property="og:image" content={`${baseUrl}/njangi-on-chain-logo.png`} />
        <meta property="og:image:width" content="1200" />
        <meta property="og:image:height" content="630" />
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
        <meta property="twitter:image" content={`${baseUrl}/njangi-on-chain-logo.png`} />
        <meta property="twitter:site" content="@njangi_on_chain" />
        <meta property="twitter:creator" content="@njangi_on_chain" />

        <meta name="theme-color" content="#f6f3ee" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
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
        className={`${bodyFont.className} relative min-h-screen overflow-hidden bg-[#f6f3ee] text-[#171923]`}
      >
        <div className="pointer-events-none absolute inset-x-0 top-0 h-[680px] bg-[radial-gradient(circle_at_top_left,_rgba(108,122,147,0.18),_transparent_36%),radial-gradient(circle_at_85%_10%,_rgba(218,204,178,0.34),_transparent_26%),linear-gradient(180deg,_rgba(255,255,255,0.58)_0%,_rgba(246,243,238,0)_72%)]" />

        <Dialog.Root
          open={isNetworkSwitchModalOpen}
          onOpenChange={setIsNetworkSwitchModalOpen}
        >
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-50 bg-[#14161c]/45 backdrop-blur-sm" />
            <Dialog.Content
              className={`fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 -translate-y-1/2 rounded-[28px] border border-[#dfd6ca] bg-[#fbfaf7] p-6 shadow-[0_28px_80px_-40px_rgba(15,23,42,0.45)] sm:p-7 ${bodyFont.className}`}
            >
              <div className="pr-10">
                <Dialog.Title className="text-xl font-semibold tracking-[-0.03em] text-[#171923]">
                  {t('landing.networkSwitchTitle', {
                    network: pendingNetwork
                      ? NETWORK_CONFIG[pendingNetwork].networkName
                      : '',
                  })}
                </Dialog.Title>
                <Dialog.Description className="mt-3 text-sm leading-6 text-[#5d6674]">
                  {t('landing.networkSwitchBody')}
                </Dialog.Description>
              </div>

              <div className={`${mutedCardClass} mt-6 p-4`}>
                <ul className="space-y-2 text-sm leading-6 text-[#4b5565]">
                  <li>Generate a different wallet address for the same account.</li>
                  <li>Require a fresh sign-in before continuing.</li>
                  <li>Show circles and balances from the selected network only.</li>
                </ul>
                <p className="mt-4 text-sm font-medium text-[#8a5a21]">
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
                  className="rounded-full border border-[#d5ccbf] bg-white px-5 py-3 text-sm font-semibold text-[#334155] transition-colors duration-200 hover:bg-[#f6f3ee]"
                >
                  {t('landing.networkSwitchStay')}
                </button>
                <button
                  type="button"
                  onClick={confirmNetworkSwitch}
                  className="rounded-full bg-[#1d2533] px-5 py-3 text-sm font-semibold text-white transition-colors duration-200 hover:bg-[#101723]"
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
                  className="absolute right-5 top-5 rounded-full border border-[#e5ddd2] bg-white p-2 text-[#667085] transition-colors duration-200 hover:text-[#171923]"
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
            <Dialog.Overlay className="fixed inset-0 z-50 bg-[#14161c]/45 backdrop-blur-sm" />
            <Dialog.Content
              className={`fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 -translate-y-1/2 rounded-[28px] border border-[#dfd6ca] bg-[#fbfaf7] p-5 shadow-[0_28px_80px_-40px_rgba(15,23,42,0.45)] sm:p-7 ${bodyFont.className}`}
            >
              <div className="pr-10">
                <Dialog.Title className="text-xl font-semibold tracking-[-0.03em] text-[#171923]">
                  {t('landing.signInTitle')}
                </Dialog.Title>
                <Dialog.Description className="mt-3 text-sm leading-6 text-[#5d6674]">
                  {t('landing.signInBody')}
                </Dialog.Description>
              </div>

              <div className={`${mutedCardClass} mt-6 p-4 sm:p-5`}>
                <LoginButton variant="landing" />
              </div>

              <div className="mt-5 flex flex-wrap items-center gap-4 text-sm text-[#667085]">
                <span className="inline-flex items-center gap-2">
                  <BadgeCheck className="h-4 w-4 text-[#71839a]" />
                  {t('landing.noSeedPhrase')}
                </span>
                <span className="inline-flex items-center gap-2">
                  <BadgeCheck className="h-4 w-4 text-[#71839a]" />
                  {t('landing.builtForCircles')}
                </span>
              </div>

              <Dialog.Close asChild>
                <button
                  type="button"
                  className="absolute right-5 top-5 rounded-full border border-[#e5ddd2] bg-white p-2 text-[#667085] transition-colors duration-200 hover:text-[#171923]"
                >
                  <X className="h-4 w-4" />
                  <span className="sr-only">Close sign-in options</span>
                </button>
              </Dialog.Close>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>

        <div className="relative">
          <header className="border-b border-[#e6ddd1]/90">
            <div className="mx-auto flex max-w-7xl flex-col gap-5 px-4 py-5 sm:px-6 lg:flex-row lg:items-center lg:justify-between lg:px-8">
              <Link href="/" className="flex min-w-0 items-center gap-4">
                <span className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-full border border-[#dfd7cb] bg-white shadow-[0_18px_40px_-34px_rgba(15,23,42,0.4)]">
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
                    className={`${wordmarkFont.className} block truncate text-[2rem] leading-none tracking-[-0.05em] text-[#111827] sm:text-[2.25rem]`}
                  >
                    Njangi
                  </span>
                  <span className="mt-1 block truncate pl-1 text-[0.72rem] font-semibold uppercase tracking-[0.42em] text-[#65748b]">
                    On-chain
                  </span>
                </span>
              </Link>

              <div className="flex flex-col gap-3 sm:items-end">
                <nav className="flex flex-wrap items-center gap-5 text-sm font-medium text-[#556070]">
                  <Link href="/learn" className={socialLinkClass}>
                    {t('nav.learn')}
                  </Link>
                  <Link href="/faq" className={socialLinkClass}>
                    {t('nav.faq')}
                  </Link>
                  <Link href="#launch" className={socialLinkClass}>
                    {t('nav.mainnetUpdates')}
                  </Link>
                  <LocaleSwitcher compact />
                </nav>

                <div className="flex flex-wrap items-center gap-3">
                  <div className="inline-flex items-center rounded-full border border-[#d7cec1] bg-white/85 p-1 shadow-[0_16px_36px_-30px_rgba(15,23,42,0.4)]">
                    <button
                      type="button"
                      onClick={() => switchNetwork('testnet')}
                      className={`rounded-full px-4 py-2 text-sm font-semibold transition-colors duration-200 ${
                        network === 'testnet'
                          ? 'bg-[#1d2533] text-white'
                          : 'text-[#5d6674] hover:text-[#171923]'
                      }`}
                    >
                      {t('nav.testnet')}
                    </button>
                    <button
                      type="button"
                      onClick={() => switchNetwork('mainnet')}
                      className={`rounded-full px-4 py-2 text-sm font-semibold transition-colors duration-200 ${
                        network === 'mainnet'
                          ? 'bg-[#1d2533] text-white'
                          : 'text-[#5d6674] hover:text-[#171923]'
                      }`}
                    >
                      {t('nav.mainnet')}
                    </button>
                  </div>

                  <div className="inline-flex items-center gap-2 rounded-full border border-[#e3dbcf] bg-[#f9f6f0] px-3 py-2 text-sm text-[#5b6572]">
                    <CircleDot className="h-4 w-4 text-[#6b7b92]" />
                    {t('nav.viewing', { network: currentNetworkName })}
                  </div>

                  {account ? (
                    <Link href="/dashboard" className={topNavPrimaryActionClass}>
                      {t('nav.openDashboard')}
                      <ArrowRight className="h-4 w-4" />
                    </Link>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setIsAuthDialogOpen(true)}
                      className={topNavPrimaryActionClass}
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
            <section className="px-4 pb-18 pt-14 sm:px-6 sm:pt-18 lg:px-8 lg:pb-24 lg:pt-20">
              <div className="mx-auto max-w-7xl">
                <div className="grid gap-12 lg:grid-cols-[minmax(0,1.05fr)_minmax(360px,0.95fr)] lg:items-start">
                  <div className="max-w-2xl">
                    <span className={sectionEyebrowClass}>
                      {t('landing.eyebrow')}
                    </span>
                    <h1 className="mt-5 text-[2.9rem] font-semibold leading-[0.94] tracking-[-0.055em] text-[#171923] sm:text-[4.1rem] md:text-[4.7rem]">
                      {t('landing.heroTitle')}
                    </h1>
                    <p className="mt-6 max-w-xl text-lg leading-8 text-[#56606f] sm:text-xl">
                      {t('landing.heroSubtitle')}
                    </p>

                    <div className={`${shellCardClass} mt-9 p-5 sm:p-6`}>
                      <p className="text-sm font-semibold uppercase tracking-[0.22em] text-[#6f7887]">
                        {t('landing.heroCardTitle')}
                      </p>
                      <p className="mt-3 max-w-2xl text-sm leading-6 text-[#5f6674] sm:text-base">
                        {t('landing.heroCardBody')}
                      </p>
                      <LoginButton variant="landing" className="mt-5" />
                      <div className="mt-5 flex flex-wrap items-center gap-4 text-sm text-[#667085]">
                        <span className="inline-flex items-center gap-2">
                          <BadgeCheck className="h-4 w-4 text-[#71839a]" />
                          {t('landing.noSeedPhrase')}
                        </span>
                        <span className="inline-flex items-center gap-2">
                          <BadgeCheck className="h-4 w-4 text-[#71839a]" />
                          {t('landing.builtForCircles')}
                        </span>
                      </div>
                    </div>

                    <div className="mt-7 flex flex-wrap items-center gap-4">
                      <Link
                        href="/learn"
                        className="inline-flex items-center gap-2 rounded-full border border-[#d7cec1] bg-white px-5 py-3 text-sm font-semibold text-[#1f2937] shadow-[0_16px_40px_-32px_rgba(15,23,42,0.45)] transition-all duration-200 hover:-translate-y-0.5 hover:bg-[#fbfaf7]"
                      >
                        {t('landing.exploreHowItWorks')}
                        <ArrowRight className="h-4 w-4" />
                      </Link>
                      <Link
                        href="#launch"
                        className="inline-flex items-center gap-2 text-sm font-semibold text-[#556070] transition-colors duration-200 hover:text-[#171923]"
                      >
                        {t('landing.joinReleaseList')}
                        <ArrowRight className="h-4 w-4" />
                      </Link>
                    </div>

                    <div className="mt-10 grid gap-4 sm:grid-cols-3">
                      {proofItems.map((item) => (
                        <div key={item.label} className={`${mutedCardClass} p-4`}>
                          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-[#7a818e]">
                            {item.label}
                          </p>
                          <p className="mt-3 text-2xl font-semibold tracking-[-0.04em] text-[#171923]">
                            {item.value}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className={`${shellCardClass} p-6 sm:p-7`}>
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-[#717784]">
                          Circle operations
                        </p>
                        <h2 className="mt-3 text-2xl font-semibold tracking-[-0.04em] text-[#171923]">
                          Less noise. More clarity for members.
                        </h2>
                      </div>
                      <div className="rounded-full border border-[#d6dde8] bg-[#f3f6fb] px-3 py-2 text-sm font-medium text-[#51627b]">
                        Live on {currentNetworkName}
                      </div>
                    </div>

                    <div className="mt-6 grid gap-3 sm:grid-cols-2">
                      {previewStats.map((stat) => (
                        <div key={stat.label} className={`${mutedCardClass} p-4`}>
                          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[#7a818e]">
                            {stat.label}
                          </p>
                          <p className="mt-3 text-xl font-semibold tracking-[-0.04em] text-[#171923]">
                            {stat.value}
                          </p>
                          <p className="mt-2 text-sm leading-6 text-[#626b78]">
                            {stat.caption}
                          </p>
                        </div>
                      ))}
                    </div>

                    <div className={`${mutedCardClass} mt-4 p-5`}>
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-sm font-semibold text-[#1f2937]">
                          A typical cycle snapshot
                        </p>
                        <span className="text-xs font-medium uppercase tracking-[0.2em] text-[#768090]">
                          Synced
                        </span>
                      </div>
                      <div className="mt-4 space-y-3">
                        <div className="flex items-start gap-3 rounded-2xl border border-[#ebe3d7] bg-white px-4 py-3">
                          <Coins className="mt-0.5 h-4 w-4 text-[#7385a0]" />
                          <div>
                            <p className="text-sm font-semibold text-[#1f2937]">
                              Contribution due
                            </p>
                            <p className="mt-1 text-sm leading-6 text-[#5d6674]">
                              Members see the amount, deadline, and payment path
                              without waiting for a reminder thread.
                            </p>
                          </div>
                        </div>
                        <div className="flex items-start gap-3 rounded-2xl border border-[#ebe3d7] bg-white px-4 py-3">
                          <Waypoints className="mt-0.5 h-4 w-4 text-[#7385a0]" />
                          <div>
                            <p className="text-sm font-semibold text-[#1f2937]">
                              Payout order
                            </p>
                            <p className="mt-1 text-sm leading-6 text-[#5d6674]">
                              Rotation rules stay visible, reducing ambiguity
                              around who is next and when the handoff happens.
                            </p>
                          </div>
                        </div>
                        <div className="flex items-start gap-3 rounded-2xl border border-[#ebe3d7] bg-white px-4 py-3">
                          <Shield className="mt-0.5 h-4 w-4 text-[#7385a0]" />
                          <div>
                            <p className="text-sm font-semibold text-[#1f2937]">
                              Audit trail
                            </p>
                            <p className="mt-1 text-sm leading-6 text-[#5d6674]">
                              Approvals, contributions, and state changes stay
                              visible to the circle instead of living in one
                              organizer&apos;s notes.
                            </p>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </section>

            <section className="px-4 py-18 sm:px-6 lg:px-8 lg:py-24">
              <div className="mx-auto max-w-7xl">
                <div className="max-w-2xl">
                  <span className={sectionEyebrowClass}>
                    {t('landing.features.eyebrow')}
                  </span>
                  <h2 className={sectionTitleClass}>
                    {t('landing.features.title')}
                  </h2>
                  <p className={sectionBodyClass}>
                    {t('landing.features.body')}
                  </p>
                </div>

                <div className="mt-12 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                  {FEATURE_CARDS.map(({ icon: Icon, titleKey, descriptionKey }) => (
                    <div key={titleKey} className={`${shellCardClass} p-6`}>
                      <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-[#e4dbcf] bg-[#f8f5ef] text-[#66748b]">
                        <Icon className="h-5 w-5" />
                      </div>
                      <h3 className="mt-6 text-xl font-semibold tracking-[-0.03em] text-[#171923]">
                        {t(titleKey)}
                      </h3>
                      <p className="mt-3 text-sm leading-6 text-[#5f6674] sm:text-base">
                        {t(descriptionKey)}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            </section>

            <section className="px-4 py-18 sm:px-6 lg:px-8 lg:py-24">
              <div className="mx-auto max-w-7xl">
                <div className="grid gap-10 lg:grid-cols-[0.92fr_1.08fr] lg:items-start">
                  <div>
                    <span className={sectionEyebrowClass}>{t('landing.workflow.eyebrow')}</span>
                    <h2 className={sectionTitleClass}>
                      {t('landing.workflow.title')}
                    </h2>
                    <p className={sectionBodyClass}>
                      {t('landing.workflow.body')}
                    </p>
                  </div>

                  <div className="grid gap-4 md:grid-cols-3">
                    {WORKFLOW_STEPS.map((step) => (
                      <div key={step.number} className={`${shellCardClass} p-6`}>
                        <p className="text-sm font-semibold uppercase tracking-[0.24em] text-[#7a818e]">
                          {step.number}
                        </p>
                        <h3 className="mt-5 text-lg font-semibold tracking-[-0.03em] text-[#171923]">
                          {t(step.titleKey)}
                        </h3>
                        <p className="mt-3 text-sm leading-6 text-[#5f6674]">
                          {t(step.descriptionKey)}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </section>

            <section className="px-4 py-18 sm:px-6 lg:px-8 lg:py-24">
              <div className="mx-auto max-w-7xl">
                <div className="max-w-3xl">
                  <span className={sectionEyebrowClass}>Why this shape matters</span>
                  <h2 className={sectionTitleClass}>
                    Positioned between informal coordination and generic fintech.
                  </h2>
                  <p className={sectionBodyClass}>
                    Traditional circles carry social strength. Modern financial
                    apps carry infrastructure. Njangi On-Chain is designed to
                    keep the first while borrowing only the useful parts of the
                    second.
                  </p>
                </div>

                <div className={`${shellCardClass} mt-12 hidden overflow-hidden lg:block`}>
                  <div className="grid grid-cols-[0.9fr_1fr_1.05fr_1fr] border-b border-[#ece4d8] bg-[#fbfaf7]">
                    <div className="px-6 py-4 text-xs font-semibold uppercase tracking-[0.22em] text-[#7a818e]">
                      Operating lens
                    </div>
                    <div className="px-6 py-4 text-xs font-semibold uppercase tracking-[0.22em] text-[#7a818e]">
                      Traditional circle
                    </div>
                    <div className="bg-[#f3f6fb] px-6 py-4 text-xs font-semibold uppercase tracking-[0.22em] text-[#51627b]">
                      Njangi On-Chain
                    </div>
                    <div className="px-6 py-4 text-xs font-semibold uppercase tracking-[0.22em] text-[#7a818e]">
                      Banks and fintech
                    </div>
                  </div>

                  {COMPARISON_ROWS.map((row, index) => (
                    <div
                      key={row.label}
                      className={`grid grid-cols-[0.9fr_1fr_1.05fr_1fr] ${
                        index !== 0 ? 'border-t border-[#ece4d8]' : ''
                      }`}
                    >
                      <div className="px-6 py-5 text-sm font-semibold text-[#1f2937]">
                        {row.label}
                      </div>
                      <div className="px-6 py-5 text-sm leading-6 text-[#596170]">
                        {row.traditional}
                      </div>
                      <div className="bg-[#f3f6fb] px-6 py-5 text-sm font-medium leading-6 text-[#334155]">
                        {row.onchain}
                      </div>
                      <div className="px-6 py-5 text-sm leading-6 text-[#596170]">
                        {row.fintech}
                      </div>
                    </div>
                  ))}
                </div>

                <div className="mt-12 grid gap-4 lg:hidden">
                  {COMPARISON_CARDS.map((card) => (
                    <div
                      key={card.title}
                      className={`rounded-[28px] border p-6 shadow-[0_24px_70px_-58px_rgba(15,23,42,0.42)] ${card.tone}`}
                    >
                      <h3 className="text-xl font-semibold tracking-[-0.03em]">
                        {card.title}
                      </h3>
                      <ul className="mt-5 space-y-3 text-sm leading-6">
                        {card.items.map((item) => (
                          <li key={item} className="flex items-start gap-3">
                            <span className="mt-2 h-1.5 w-1.5 rounded-full bg-current" />
                            <span>{item}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </div>
            </section>

            <section id="launch" className="px-4 py-18 sm:px-6 lg:px-8 lg:py-24">
              <div className="mx-auto max-w-7xl">
                <div className={`${shellCardClass} p-7 sm:p-9 lg:p-10`}>
                  <div className="grid gap-10 lg:grid-cols-[0.95fr_1.05fr] lg:items-start">
                    <div className="max-w-xl">
                      <span className={sectionEyebrowClass}>{t('landing.launch.eyebrow')}</span>
                      <h2 className={sectionTitleClass}>
                        {t('landing.launch.title')}
                      </h2>
                      <p className={sectionBodyClass}>
                        {t('landing.launch.body')}
                      </p>

                      <div className="mt-8 space-y-3">
                        {launchNotes.map((note) => (
                          <div
                            key={note}
                            className="flex items-start gap-3 rounded-2xl border border-[#e7dfd4] bg-[#fbfaf7] px-4 py-3"
                          >
                            <BadgeCheck className="mt-0.5 h-4 w-4 text-[#70819a]" />
                            <p className="text-sm leading-6 text-[#596170]">{note}</p>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className={`${mutedCardClass} p-6 sm:p-7`}>
                      <div className="inline-flex items-center gap-2 rounded-full border border-[#e4dbcf] bg-white px-3 py-2 text-sm font-medium text-[#556070]">
                        <Mail className="h-4 w-4 text-[#70819a]" />
                        {t('landing.launch.eyebrow')}
                      </div>

                      <form
                        onSubmit={handleMainnetSignup}
                        className="mt-6 flex flex-col gap-3"
                      >
                        <input
                          type="email"
                          placeholder={t('landing.launch.emailPlaceholder')}
                          value={signupEmail}
                          onChange={(e) => setSignupEmail(e.target.value)}
                          required
                          disabled={isSignupLoading}
                          className="w-full rounded-2xl border border-[#d8d0c4] bg-white px-5 py-4 text-base text-[#171923] outline-none transition-colors duration-200 placeholder:text-[#8a93a1] focus:border-[#9aa7b9] disabled:cursor-not-allowed disabled:bg-[#f7f4ee]"
                        />
                        <button
                          type="submit"
                          disabled={isSignupLoading}
                          className="inline-flex items-center justify-center rounded-2xl bg-[#1d2533] px-5 py-4 text-sm font-semibold text-white transition-colors duration-200 hover:bg-[#101723] disabled:cursor-not-allowed disabled:opacity-60"
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
                              ? 'border-[#b6d8c0] bg-[#edf7ef] text-[#24553a]'
                              : 'border-[#e5c5c5] bg-[#fdf1f1] text-[#7b3636]'
                          }`}
                        >
                          {signupMessage}
                        </div>
                      )}

                      <p className="mt-4 text-sm leading-6 text-[#667085]">
                        {t('landing.launch.disclaimer')}
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </section>

            <section className="px-4 py-18 sm:px-6 lg:px-8 lg:py-24">
              <div className="mx-auto max-w-4xl">
                <div className="text-center">
                  <span className={sectionEyebrowClass}>{t('landing.faq.eyebrow')}</span>
                  <h2 className={sectionTitleClass}>{t('landing.faq.title')}</h2>
                  <p className={`${sectionBodyClass} mx-auto`}>
                    {t('landing.faq.body')}
                  </p>
                </div>

                <div className="mt-12 space-y-4">
                  {FAQ_ITEMS.map((item) => (
                    <div key={item.id} className={`${shellCardClass} overflow-hidden`}>
                      <button
                        type="button"
                        onClick={() => toggleFaqItem(item.id)}
                        aria-expanded={openFaqItems[item.id]}
                        className="flex w-full items-center justify-between gap-4 px-6 py-5 text-left sm:px-7"
                      >
                        <span className="text-lg font-semibold tracking-[-0.03em] text-[#171923]">
                          {item.question}
                        </span>
                        <ChevronDown
                          className={`h-5 w-5 shrink-0 text-[#6b7280] transition-transform duration-200 ${
                            openFaqItems[item.id] ? 'rotate-180' : ''
                          }`}
                        />
                      </button>
                      {openFaqItems[item.id] && (
                        <div className="border-t border-[#ece4d8] px-6 pb-6 pt-4 sm:px-7">
                          <p className="text-sm leading-7 text-[#5f6674] sm:text-base">
                            {item.answer}
                          </p>
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                <div className="mt-8 flex flex-col items-center justify-center gap-3 text-sm font-semibold sm:flex-row">
                  <Link
                    href="/learn"
                    className="inline-flex items-center gap-2 text-[#556070] transition-colors duration-200 hover:text-[#171923]"
                  >
                    {t('landing.faq.learnLink')}
                    <ArrowRight className="h-4 w-4" />
                  </Link>
                  <Link
                    href="/faq"
                    className="inline-flex items-center gap-2 text-[#556070] transition-colors duration-200 hover:text-[#171923]"
                  >
                    {t('landing.faq.fullFaqLink')}
                    <ArrowRight className="h-4 w-4" />
                  </Link>
                </div>
              </div>
            </section>

            <section className="px-4 pb-20 sm:px-6 lg:px-8 lg:pb-24">
              <div className="mx-auto max-w-7xl">
                <div className={`${shellCardClass} p-7 sm:p-9`}>
                  <div className="max-w-3xl">
                    <span className={sectionEyebrowClass}>{t('landing.tradition.eyebrow')}</span>
                    <h2 className={sectionTitleClass}>{t('landing.tradition.title')}</h2>
                    <p className={sectionBodyClass}>
                      {t('landing.tradition.body')}
                    </p>
                  </div>

                  <div className="mt-8 flex flex-wrap gap-3">
                    {CULTURAL_NAMES.map((name) => (
                      <span
                        key={name}
                        className="rounded-full border border-[#ddd5ca] bg-[#fbfaf7] px-4 py-2 text-sm font-medium text-[#556070]"
                      >
                        {name}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            </section>
          </main>

          <footer className="border-t border-[#e6ddd1]/90 bg-[#f1ece4]/80">
            <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
              <div className="flex flex-col gap-8 lg:flex-row lg:items-start lg:justify-between">
                <div className="flex items-center gap-4">
                  <span className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-full border border-[#dfd7cb] bg-white">
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
                      className={`${wordmarkFont.className} text-[1.9rem] leading-none tracking-[-0.05em] text-[#111827]`}
                    >
                      Njangi
                    </p>
                    <p className="mt-1 text-[0.7rem] font-semibold uppercase tracking-[0.42em] text-[#65748b]">
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

              <div className="mt-8 flex flex-col gap-2 border-t border-[#ddd5c9] pt-4 text-sm text-[#6b7280] sm:flex-row sm:items-center sm:justify-between">
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
