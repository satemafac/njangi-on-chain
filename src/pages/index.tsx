import React, { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import * as Dialog from '@radix-ui/react-dialog';
import { MotionConfig } from 'framer-motion';
import {
  ArrowRight,
  Check,
  Coins,
  Globe2,
  Shield,
  type LucideIcon,
  Users,
  Wallet,
  Waypoints,
  X,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { LoginButton } from '../components/LoginButton';
import { useTranslation } from '../hooks/useTranslation';
import { getNetworkConfig, setCurrentNetwork } from '../services/network-config';
import { SUPPORT_MAILTO } from '../lib/constants';
import {
  clearPostLoginDestination,
  rememberPostLoginDestination,
} from '../lib/post-login-redirect';
import { webApplication, website } from '../lib/structured-data';
import { Seo } from '../components/Seo';
import { Reveal, RevealItem } from '../components/landing/Reveal';
import KineticNames from '../components/landing/KineticNames';
import LandingHeader from '../components/landing/LandingHeader';
import HeroStage from '../components/landing/HeroStage';
import ScrollLitText from '../components/landing/ScrollLitText';
import ProofNumbers, { type Proof } from '../components/landing/ProofNumbers';
import RotationStory from '../components/landing/RotationStory';
import CircleMock from '../components/landing/CircleMock';
import FeatureBento, { type Feature } from '../components/landing/FeatureBento';
import NamesLight from '../components/landing/NamesLight';
import SiteFooter from '../components/landing/SiteFooter';
import { sansFont, serifFont } from '../components/landing/fonts';
import {
  ChevronLink,
  FaqList,
  eyebrowClass,
  focusRing,
  goldButtonClass,
  quietButtonClass,
  sectionBodyClass,
  sectionTitleClass,
} from '../components/landing/ui';

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

// Feature tiles and workflow steps reference i18n keys; the visible copy is
// resolved at render time via the active locale (EN/FR funnel translation).
const FEATURE_TILES: Array<{
  key: Feature['key'];
  icon: LucideIcon;
  titleKey: string;
  descriptionKey: string;
}> = [
  {
    key: 'ledger',
    icon: Shield,
    titleKey: 'landing.feature.sharedVisibility.title',
    descriptionKey: 'landing.feature.sharedVisibility.body',
  },
  {
    key: 'custody',
    icon: Wallet,
    titleKey: 'landing.feature.selfCustody.title',
    descriptionKey: 'landing.feature.selfCustody.body',
  },
  {
    key: 'borderless',
    icon: Globe2,
    titleKey: 'landing.feature.borderless.title',
    descriptionKey: 'landing.feature.borderless.body',
  },
  {
    key: 'friction',
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

  const proofItems: Proof[] = [
    circleCount !== null
      ? { label: t('landing.proof.liveCircles'), count: circleCount, suffix: '+' }
      : { label: t('landing.proof.liveCircles'), text: t('landing.proof.syncing') },
    { label: t('landing.proof.supportedAssets'), count: 6, suffix: '+' },
    { label: t('landing.proof.custodyLabel'), text: t('landing.proof.custodyValue') },
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

  const openSignIn = (intent: 'login' | 'start') => {
    if (intent === 'start') {
      // "Start a circle" means start a circle: the OAuth callback honours
      // this and skips the dashboard detour.
      rememberPostLoginDestination('/create-circle');
    } else {
      // A plain login lands on the dashboard: drop any "start a circle"
      // intent left by an earlier click.
      clearPostLoginDestination();
    }
    setIsAuthDialogOpen(true);
  };

  const scrollToHow = (e: React.MouseEvent<HTMLAnchorElement>) => {
    const target = document.getElementById('how');
    if (!target) return;
    e.preventDefault();
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    target.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
    history.replaceState(null, '', '#how');
  };

  const sheetClass = `apple ${sansFont.variable} sheet fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-[30rem] -translate-x-1/2 -translate-y-1/2 rounded-[24px] bg-[#1c1c1e] p-6 text-mist shadow-[0_40px_120px_-30px_rgba(0,0,0,0.9)] ring-1 ring-white/[0.08] focus:outline-none sm:p-8`;
  const sheetScrimClass = 'sheet-scrim fixed inset-0 z-50 bg-black/60 backdrop-blur-md';
  const sheetCloseClass = `absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-full bg-white/[0.08] text-mist-2 transition-colors duration-200 hover:bg-white/[0.14] hover:text-mist rtl:left-4 rtl:right-auto ${focusRing}`;

  return (
    <>
      {/* Title stays under 60 characters so Google stops truncating it, and
          leads with the brand so the site-name line has a clean signal. The
          description is deliberately concrete and names the traditions people
          actually search for — the previous one was abstract enough that Google
          discarded it and substituted its own snippet from the page's FAQ.

          The JSON-LD graph adds WebSite, which is Google's documented source
          for the site-name line above a result. With no WebSite node it falls
          back to the bare domain, which is why the SERP read
          "njangionchain.com". webApplication()'s publisher and Organization's
          logo now resolve by @id to a single square, opaque render — the old
          value pointed at njangi-on-chain-logo.png, a 2464x1536 transparent
          canvas whose mark occupies only 1054x1070, declared as 512x512. */}
      <Seo
        title="Njangi On-Chain — Rotating Savings Circles for the Diaspora"
        titleAbsolute
        description="Njangi, tontine, susu, esusu — the rotating savings circle your community already runs, now self-custodied and verifiable. No treasurer, no seed phrase."
        path="/"
        ogTitle="Njangi On-Chain — savings circles for the global diaspora"
        ogDescription="The rotating savings circle your community already trusts — njangi, esusu, tontine — now self-custodied, scheduled, and verifiable on-chain. No treasurer. No seed phrase."
        themeColor="#000000"
        jsonLd={[website(), webApplication()]}
      />

      <Head>
        {/* Not SEO: tell the browser this page is dark and paint html/body
            black, so iOS Safari tints the status bar / top safe-area to match
            instead of sampling the (globally white) body background. Scoped
            to the landing via next/head, so light app pages keep theirs. */}
        <meta name="color-scheme" content="dark" />
        <style>{`html,body{background-color:#000!important}`}</style>
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="Njangi On-Chain" />
      </Head>

      {/* reducedMotion="user": every framer animation on the page drops its
          movement for people who asked for less (opacity fades remain). */}
      <MotionConfig reducedMotion="user">
        <div
          className={`${sansFont.variable} apple relative min-h-screen overflow-x-clip bg-black text-mist`}
        >
          {/* Skip link — first focusable element for keyboard users */}
          <a
            href="#main"
            className="sr-only rounded-full focus:not-sr-only focus:fixed focus:left-4 focus:top-3 focus:z-[60] focus:bg-gold focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-[#1d1d1f]"
          >
            Skip to content
          </a>

          <Dialog.Root open={isNetworkSwitchModalOpen} onOpenChange={setIsNetworkSwitchModalOpen}>
            <Dialog.Portal>
              <Dialog.Overlay className={sheetScrimClass} />
              <Dialog.Content className={sheetClass}>
                <div className="pe-10">
                  <Dialog.Title className="text-[24px] font-semibold leading-tight tracking-[0.009em] text-mist">
                    {t('landing.networkSwitchTitle', {
                      network: pendingNetwork ? NETWORK_CONFIG[pendingNetwork].networkName : '',
                    })}
                  </Dialog.Title>
                  <Dialog.Description className="type-body mt-3 text-mist-2">
                    {t('landing.networkSwitchBody')}
                  </Dialog.Description>
                </div>

                <div className="mt-6 rounded-2xl bg-white/[0.05] p-5">
                  <ul className="type-caption space-y-2.5 text-mist-2">
                    <li className="flex gap-2.5">
                      <Check aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-gold" />
                      Generate a different wallet address for the same account.
                    </li>
                    <li className="flex gap-2.5">
                      <Check aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-gold" />
                      Require a fresh sign-in before continuing.
                    </li>
                    <li className="flex gap-2.5">
                      <Check aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-gold" />
                      Show circles and balances from the selected network only.
                    </li>
                  </ul>
                  <p className="type-caption mt-4 font-medium text-gold">
                    The wallet you use on{' '}
                    {pendingNetwork
                      ? NETWORK_CONFIG[pendingNetwork].networkName.toLowerCase()
                      : 'the selected network'}{' '}
                    is separate from the other environment.
                  </p>
                </div>

                <div className="mt-7 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
                  <button type="button" onClick={cancelNetworkSwitch} className={quietButtonClass}>
                    {t('landing.networkSwitchStay')}
                  </button>
                  <button type="button" onClick={confirmNetworkSwitch} className={goldButtonClass}>
                    {t('landing.networkSwitchConfirm', {
                      network: pendingNetwork ? NETWORK_CONFIG[pendingNetwork].networkName : '',
                    })}
                  </button>
                </div>

                <Dialog.Close asChild>
                  <button type="button" onClick={cancelNetworkSwitch} className={sheetCloseClass}>
                    <X className="h-4 w-4" />
                    <span className="sr-only">Close</span>
                  </button>
                </Dialog.Close>
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>

          <Dialog.Root open={isAuthDialogOpen} onOpenChange={setIsAuthDialogOpen}>
            <Dialog.Portal>
              <Dialog.Overlay className={sheetScrimClass} />
              <Dialog.Content className={sheetClass}>
                <div className="pe-10">
                  <Dialog.Title className="text-[24px] font-semibold leading-tight tracking-[0.009em] text-mist">
                    {t('landing.signInTitle')}
                  </Dialog.Title>
                  <Dialog.Description className="type-body mt-3 text-mist-2">
                    {t('landing.signInBody')}
                  </Dialog.Description>
                </div>

                <div className="mt-6">
                  {/* Stacked, full-width — how Apple lays out sign-in choices. */}
                  <LoginButton variant="landing" className="sm:!grid-cols-1" />
                </div>

                <div className="type-caption mt-6 flex flex-wrap items-center gap-x-5 gap-y-2 text-mist-3">
                  <span className="inline-flex items-center gap-1.5">
                    <Check aria-hidden className="h-4 w-4 text-gold" />
                    {t('landing.noSeedPhrase')}
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <Check aria-hidden className="h-4 w-4 text-gold" />
                    {t('landing.builtForCircles')}
                  </span>
                </div>

                <Dialog.Close asChild>
                  <button type="button" className={sheetCloseClass}>
                    <X className="h-4 w-4" />
                    <span className="sr-only">Close sign-in options</span>
                  </button>
                </Dialog.Close>
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>

          <LandingHeader
            signedIn={!!account}
            network={network}
            onSwitchNetwork={switchNetwork}
            onLogin={() => openSignIn('login')}
            t={t}
          />

          <main>
            {/* ===================== HERO ===================== */}
            <HeroStage id="main">
              <div className="mx-auto flex h-full max-w-[1100px] flex-col items-center px-5 pt-[calc(52px+8svh)] text-center sm:px-8 md:pt-[calc(52px+10svh)]">
                <p className="rise" style={{ '--d': '60ms' } as CSSProperties}>
                  <span className="sr-only">{t('landing.heritageAlso')}</span>
                  <span
                    className={`${serifFont.className} block text-[clamp(2.25rem,1.6rem+2vw,3.25rem)] leading-[1.2] tracking-[-0.01em]`}
                  >
                    <KineticNames
                      names={CULTURAL_NAMES}
                      className="text-gold-gradient text-center"
                      interval={1500}
                      settleOn="Njangi"
                    />
                  </span>
                </p>
                <p
                  className="rise type-eyebrow mt-2 text-balance text-mist-3"
                  style={{ '--d': '140ms' } as CSSProperties}
                >
                  {t('landing.eyebrow')}
                </p>
                <h1
                  className="rise mt-6 max-w-[21ch] text-balance text-mist type-hero"
                  style={{ '--d': '220ms', fontSize: 'clamp(2.25rem, 1.1rem + 4.2vw, 4.5rem)' } as CSSProperties}
                >
                  {t('landing.heroTitle')}
                </h1>
                <div
                  className="rise mt-10 flex flex-col items-center gap-5 sm:flex-row sm:gap-8"
                  style={{ '--d': '380ms' } as CSSProperties}
                >
                  {account ? (
                    <Link href="/dashboard" className={goldButtonClass}>
                      {t('nav.openDashboard')}
                      <ArrowRight aria-hidden className="h-4 w-4 rtl:rotate-180" />
                    </Link>
                  ) : (
                    <button type="button" onClick={() => openSignIn('start')} className={goldButtonClass}>
                      {t('landing.heroPrimaryCta')}
                    </button>
                  )}
                  <ChevronLink href="#how" onClick={scrollToHow}>
                    {t('landing.exploreHowItWorks')}
                  </ChevronLink>
                </div>
                <p
                  className="rise type-caption mt-7 max-w-[34rem] text-balance text-mist-3"
                  style={{ '--d': '480ms' } as CSSProperties}
                >
                  {t('landing.heroCtaReassure')}
                </p>
                <p
                  className="rise type-caption mt-2 inline-flex max-w-[34rem] items-start gap-2 text-start text-mist-2"
                  style={{ '--d': '540ms' } as CSSProperties}
                >
                  <span aria-hidden className="relative mt-[0.42em] flex h-2 w-2 shrink-0">
                    <span className="absolute inset-0 rounded-full bg-gold/70 [animation:ping_1.8s_cubic-bezier(0,0,0.2,1)_4]" />
                    <span className="relative h-2 w-2 rounded-full bg-gold" />
                  </span>
                  {t('landing.testnetNote')}
                </p>
              </div>
            </HeroStage>

            {/* ============ STATEMENT (reads at scroll pace) ============ */}
            <section className="px-5 pb-24 pt-28 sm:px-8 md:pb-36 md:pt-40">
              <ScrollLitText
                text={t('landing.heroSubtitle')}
                className="mx-auto max-w-[980px] text-balance text-[clamp(1.75rem,1.15rem+2.3vw,3rem)] font-semibold leading-[1.17] tracking-[-0.004em] text-mist"
              />
            </section>

            {/* ================= PROOF ================= */}
            <section aria-label="Njangi On-Chain at a glance" className="px-5 pb-28 sm:px-8 md:pb-44">
              <ProofNumbers items={proofItems} />
            </section>

            {/* ================= HOW IT WORKS ================= */}
            <section id="how" className="relative scroll-mt-10 pt-4">
              <Reveal className="mx-auto max-w-[980px] px-5 text-center sm:px-8">
                <RevealItem>
                  <p className={eyebrowClass}>{t('landing.workflow.eyebrow')}</p>
                </RevealItem>
                <RevealItem>
                  <h2 className={sectionTitleClass}>{t('landing.workflow.title')}</h2>
                </RevealItem>
                <RevealItem>
                  <p className={sectionBodyClass}>{t('landing.workflow.body')}</p>
                </RevealItem>
              </Reveal>
              <div className="mt-6 md:mt-10">
                <RotationStory
                  steps={WORKFLOW_STEPS.map((step) => ({
                    number: step.number,
                    title: t(step.titleKey),
                    body: t(step.descriptionKey),
                  }))}
                />
              </div>
            </section>

            {/* ============== INSIDE A LIVE CIRCLE ============== */}
            <section className="px-5 py-28 sm:px-8 md:py-40">
              <Reveal className="mx-auto max-w-[980px] text-center">
                <RevealItem>
                  <p className={eyebrowClass}>Circle operations</p>
                </RevealItem>
                <RevealItem>
                  <h2 className={sectionTitleClass}>Less noise. More clarity for members.</h2>
                </RevealItem>
                <RevealItem>
                  <p className={sectionBodyClass}>
                    Every contribution, turn, and approval lives in one shared view — so the circle
                    runs on the same facts instead of one organizer&apos;s memory.
                  </p>
                </RevealItem>
              </Reveal>
              <div className="mt-14 md:mt-20">
                <CircleMock
                  heading="What a cycle looks like"
                  badge="Example cycle"
                  caption="Illustrative example"
                  stats={previewStats}
                  rows={cycleSnapshot}
                />
              </div>
            </section>

            {/* =================== FEATURES =================== */}
            <section className="px-5 py-28 sm:px-8 md:py-40">
              <Reveal className="mx-auto max-w-[980px] text-center">
                <RevealItem>
                  <p className={eyebrowClass}>{t('landing.features.eyebrow')}</p>
                </RevealItem>
                <RevealItem>
                  <h2 className={sectionTitleClass}>{t('landing.features.title')}</h2>
                </RevealItem>
                <RevealItem>
                  <p className={sectionBodyClass}>{t('landing.features.body')}</p>
                </RevealItem>
              </Reveal>
              <div className="mt-14 md:mt-20">
                <FeatureBento
                  features={FEATURE_TILES.map((tile) => ({
                    key: tile.key,
                    icon: tile.icon,
                    title: t(tile.titleKey),
                    body: t(tile.descriptionKey),
                  }))}
                />
              </div>
            </section>

            {/* ================== COMPARISON ================== */}
            <section className="px-5 py-28 sm:px-8 md:py-40">
              <Reveal className="mx-auto max-w-[980px] text-center">
                <RevealItem>
                  <p className={eyebrowClass}>Why this shape matters</p>
                </RevealItem>
                <RevealItem>
                  <h2 className={sectionTitleClass}>
                    Positioned between informal coordination and generic fintech.
                  </h2>
                </RevealItem>
                <RevealItem>
                  <p className={sectionBodyClass}>
                    Traditional circles carry social strength. Modern financial apps carry
                    infrastructure. Njangi On-Chain keeps the first while borrowing only the useful
                    parts of the second.
                  </p>
                </RevealItem>
              </Reveal>

              <Reveal className="mx-auto mt-16 hidden max-w-[1100px] lg:block" amount={0.15}>
                <RevealItem>
                  <table className="w-full border-separate border-spacing-0 text-start">
                    <caption className="sr-only">
                      How a traditional circle, Njangi On-Chain, and banks or fintech apps compare
                    </caption>
                    <thead>
                      <tr>
                        <th
                          scope="col"
                          className="w-[20%] px-6 pb-6 pt-9 text-start align-bottom text-[12px] font-semibold uppercase tracking-[0.08em] text-mist-3"
                        >
                          Operating lens
                        </th>
                        <th
                          scope="col"
                          className="px-6 pb-6 pt-9 text-start align-bottom text-[19px] font-semibold tracking-[0.012em] text-mist-2"
                        >
                          Traditional circle
                        </th>
                        <th
                          scope="col"
                          className="rounded-t-[28px] bg-night-tile px-7 pb-6 pt-9 text-start align-bottom text-[19px] font-semibold tracking-[0.012em] text-gold"
                        >
                          Njangi On-Chain
                        </th>
                        <th
                          scope="col"
                          className="px-6 pb-6 pt-9 text-start align-bottom text-[19px] font-semibold tracking-[0.012em] text-mist-2"
                        >
                          Banks and fintech
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {COMPARISON_ROWS.map((row, index) => {
                        const last = index === COMPARISON_ROWS.length - 1;
                        return (
                          <tr key={row.label}>
                            <th
                              scope="row"
                              className="border-t border-white/[0.1] px-6 py-6 text-start align-top text-[15px] font-semibold tracking-[-0.01em] text-mist"
                            >
                              {row.label}
                            </th>
                            <td className="type-caption border-t border-white/[0.1] px-6 py-6 align-top text-mist-3">
                              {row.traditional}
                            </td>
                            <td
                              className={`border-t border-white/[0.07] bg-night-tile px-7 py-6 align-top text-[15px] leading-6 tracking-[-0.01em] text-mist ${
                                last ? 'rounded-b-[28px] pb-9' : ''
                              }`}
                            >
                              {row.onchain}
                            </td>
                            <td className="type-caption border-t border-white/[0.1] px-6 py-6 align-top text-mist-3">
                              {row.fintech}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </RevealItem>
              </Reveal>

              <Reveal className="mx-auto mt-14 grid max-w-[640px] gap-4 lg:hidden" amount={0.1}>
                {COMPARISON_CARDS.map((card) => (
                  <RevealItem key={card.title}>
                    <div
                      className={`rounded-[28px] p-7 sm:p-8 ${
                        card.highlight ? 'bg-night-tile ring-1 ring-gold/30' : 'bg-night-tile/60'
                      }`}
                    >
                      <h3 className={`type-tile ${card.highlight ? 'text-gold' : 'text-mist'}`}>
                        {card.title}
                      </h3>
                      <ul className="mt-5 space-y-3">
                        {card.items.map((item) => (
                          <li key={item} className="type-body flex items-start gap-3 text-mist-2">
                            {card.highlight ? (
                              <Check aria-hidden className="mt-[0.2em] h-4 w-4 shrink-0 text-gold" />
                            ) : (
                              <span aria-hidden className="mt-[0.6em] h-1.5 w-1.5 shrink-0 rounded-full bg-mist-4" />
                            )}
                            <span>{item}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </RevealItem>
                ))}
              </Reveal>
            </section>

            {/* =================== TRADITION =================== */}
            <section className="px-5 py-28 sm:px-8 md:py-40">
              <Reveal className="mx-auto max-w-[980px] text-center">
                <RevealItem>
                  <p className={eyebrowClass}>{t('landing.tradition.eyebrow')}</p>
                </RevealItem>
                <RevealItem>
                  <h2 className={sectionTitleClass}>{t('landing.tradition.title')}</h2>
                </RevealItem>
                <RevealItem>
                  <p className={sectionBodyClass}>{t('landing.tradition.body')}</p>
                </RevealItem>
              </Reveal>
              <div className="mt-14 md:mt-20">
                <NamesLight
                  names={CULTURAL_NAMES}
                  highlight="Njangi"
                  serifClassName={serifFont.className}
                />
              </div>
            </section>

            {/* ================= LAUNCH / WAITLIST ================= */}
            <section id="launch" className="scroll-mt-16 px-5 py-28 sm:px-8 md:py-40">
              <div className="relative mx-auto max-w-[1100px] overflow-hidden rounded-[32px] bg-night-tile px-6 py-16 text-center sm:px-12 md:py-24">
                <div
                  aria-hidden
                  className="pointer-events-none absolute inset-x-0 -top-40 mx-auto h-80 max-w-[720px] rounded-full"
                  style={{ background: 'radial-gradient(closest-side, rgba(232,176,75,0.16), transparent)' }}
                />
                <Reveal className="relative mx-auto max-w-[44rem]">
                  <RevealItem>
                    <p className={eyebrowClass}>{t('landing.launch.eyebrow')}</p>
                  </RevealItem>
                  <RevealItem>
                    <h2 className={sectionTitleClass}>{t('landing.launch.title')}</h2>
                  </RevealItem>
                  <RevealItem>
                    <p className={sectionBodyClass}>{t('landing.launch.body')}</p>
                  </RevealItem>
                </Reveal>

                <form
                  onSubmit={handleMainnetSignup}
                  className="relative mx-auto mt-10 flex max-w-[36rem] flex-col gap-3 sm:flex-row"
                >
                  <label htmlFor="mainnet-email" className="sr-only">
                    {t('landing.launch.emailPlaceholder')}
                  </label>
                  <input
                    id="mainnet-email"
                    type="email"
                    autoComplete="email"
                    placeholder={t('landing.launch.emailPlaceholder')}
                    value={signupEmail}
                    onChange={(e) => setSignupEmail(e.target.value)}
                    required
                    disabled={isSignupLoading}
                    className="h-12 w-full min-w-0 rounded-full bg-black/70 px-6 sm:w-auto sm:flex-1 text-[17px] tracking-[-0.022em] text-mist outline-none ring-1 ring-white/[0.14] transition-shadow duration-200 placeholder:text-mist-3 focus:ring-2 focus:ring-gold/80 disabled:cursor-not-allowed disabled:opacity-60"
                  />
                  <button type="submit" disabled={isSignupLoading} className={goldButtonClass}>
                    {isSignupLoading ? t('landing.launch.signingUp') : t('landing.launch.notifyButton')}
                  </button>
                </form>

                <div role="status" aria-live="polite" className="relative">
                  {signupMessage && (
                    <p
                      className={`type-caption mx-auto mt-4 inline-flex max-w-[36rem] items-center gap-2 rounded-full px-4 py-2 ${
                        showSignupSuccess
                          ? 'bg-[#30d158]/[0.12] text-[#30d158]'
                          : 'bg-[#ff453a]/[0.12] text-[#ff6961]'
                      }`}
                    >
                      {showSignupSuccess && <Check aria-hidden className="h-4 w-4" />}
                      {signupMessage}
                    </p>
                  )}
                </div>

                <p className="type-caption relative mx-auto mt-4 max-w-[36rem] text-mist-3">
                  {t('landing.launch.disclaimer')}
                </p>

                <ul className="relative mx-auto mt-14 grid max-w-[60rem] gap-6 border-t border-white/[0.08] pt-10 text-start sm:grid-cols-3">
                  {launchNotes.map((note) => (
                    <li key={note} className="type-caption flex items-start gap-3 text-mist-2">
                      <Check aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-gold" />
                      <span>{note}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </section>

            {/* ===================== FAQ ===================== */}
            <section className="px-5 py-28 sm:px-8 md:py-40">
              <div className="mx-auto max-w-[860px]">
                <Reveal className="text-center">
                  <RevealItem>
                    <p className={eyebrowClass}>{t('landing.faq.eyebrow')}</p>
                  </RevealItem>
                  <RevealItem>
                    <h2 className={sectionTitleClass}>{t('landing.faq.title')}</h2>
                  </RevealItem>
                  <RevealItem>
                    <p className={sectionBodyClass}>{t('landing.faq.body')}</p>
                  </RevealItem>
                </Reveal>

                <div className="mt-14">
                  <FaqList
                    items={FAQ_ITEMS.map((item) => ({
                      id: item.id,
                      question: t(item.questionKey),
                      answer: t(item.answerKey),
                    }))}
                    open={openFaqItems}
                    onToggle={toggleFaqItem}
                  />
                </div>

                <div className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row sm:gap-10">
                  <ChevronLink href="/learn">{t('landing.faq.learnLink')}</ChevronLink>
                  <ChevronLink href="/faq">{t('landing.faq.fullFaqLink')}</ChevronLink>
                </div>
              </div>
            </section>
          </main>

          <SiteFooter
            links={[
              { href: '/learn', label: t('nav.learn') },
              { href: '/faq', label: t('nav.faq') },
              { href: 'https://x.com/njangi_on_chain', label: 'X', external: true },
              { href: 'https://www.instagram.com/njangionchain', label: 'Instagram', external: true },
              { href: SUPPORT_MAILTO, label: 'Email' },
            ]}
            rights={t('landing.footer.rights', { year: new Date().getFullYear() })}
            tagline={t('landing.footer.tagline')}
          />
        </div>
      </MotionConfig>
    </>
  );
}
