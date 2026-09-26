import { useEffect, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import * as Dialog from '@radix-ui/react-dialog';
import { motion, useReducedMotion } from 'framer-motion';
import { ArrowRight } from 'lucide-react';
import { LocaleSwitcher } from '../ui/LocaleSwitcher';
import { EASE_APPLE } from './motion';

type Network = 'testnet' | 'mainnet';

type Props = {
  signedIn: boolean;
  network: Network;
  onSwitchNetwork: (network: Network) => void;
  onLogin: () => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
  /** className of the brand serif (next/font), for the wordmark. */
  serifClassName: string;
  /** next/font variable class(es) the portalled menu needs (it renders
   *  outside the page root, so it can't inherit them). */
  fontVariables?: string;
};

const NAV_LINKS: Array<{ href: string; key: string }> = [
  { href: '/learn', key: 'nav.learn' },
  { href: '/faq', key: 'nav.faq' },
  { href: '#launch', key: 'nav.mainnetUpdates' },
];

const focusRing =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/80 focus-visible:ring-offset-2 focus-visible:ring-offset-black';

/** Scroll to an in-page anchor, honouring reduced motion. */
function goToAnchor(hash: string) {
  const el = document.getElementById(hash.replace(/^#/, ''));
  if (!el) return;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  history.replaceState(null, '', hash);
}

/**
 * Apple-style global bar: one 52px row, transparent over the hero and
 * frosted (blur + saturate) with a hairline once the page moves. Desktop
 * carries the links + controls inline; below `md` everything folds into a
 * full-screen menu whose items settle in with a short stagger.
 */
export default function LandingHeader({
  signedIn,
  network,
  onSwitchNetwork,
  onLogin,
  t,
  serifClassName,
  fontVariables = '',
}: Props) {
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const reduce = useReducedMotion();

  useEffect(() => {
    let frame = 0;
    const read = () => {
      frame = 0;
      setScrolled(window.scrollY > 8);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(read);
    };
    read();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  // The menu is a phone surface; if the window widens past it, close it.
  useEffect(() => {
    if (!menuOpen) return;
    const query = window.matchMedia('(min-width: 768px)');
    const onChange = () => query.matches && setMenuOpen(false);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [menuOpen]);

  const wordmark = (onNavigate?: () => void) => (
    <Link
      href="/"
      onClick={onNavigate}
      className={`flex shrink-0 items-center gap-2.5 rounded-full ${focusRing}`}
    >
      <span className="flex h-8 w-8 items-center justify-center overflow-hidden rounded-full bg-white/[0.06]">
        <Image
          src="/njangi-on-chain-logo.png"
          alt=""
          width={64}
          height={64}
          className="h-full w-full object-contain"
          priority
          unoptimized
        />
      </span>
      <span className="flex items-baseline gap-1.5">
        <span className={`${serifClassName} text-[1.5rem] leading-none tracking-[-0.03em] text-mist`}>
          Njangi
        </span>
        <span className="text-[0.58rem] font-semibold uppercase tracking-[0.3em] text-gold">
          On-chain
        </span>
      </span>
      <span className="sr-only">Njangi On-Chain home</span>
    </Link>
  );

  const networkControl = (size: 'sm' | 'lg') => (
    <div
      role="group"
      aria-label={t('nav.viewing', { network: network === 'testnet' ? t('nav.testnet') : t('nav.mainnet') })}
      className={`inline-flex items-center rounded-full bg-white/[0.08] p-[3px] ${
        size === 'lg' ? 'h-11 w-full' : 'h-8'
      }`}
    >
      {(['testnet', 'mainnet'] as const).map((value) => {
        const selected = network === value;
        return (
          <button
            key={value}
            type="button"
            aria-pressed={selected}
            onClick={() => {
              if (!selected) {
                setMenuOpen(false);
                onSwitchNetwork(value);
              }
            }}
            className={`inline-flex h-full flex-1 items-center justify-center gap-1.5 rounded-full px-3 font-medium transition-colors duration-200 ${
              size === 'lg' ? 'text-[15px]' : 'text-[12px]'
            } ${
              selected
                ? 'bg-white/[0.16] text-mist'
                : 'text-mist-3 hover:text-mist'
            } ${focusRing}`}
          >
            {selected && <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-gold" />}
            {value === 'testnet' ? t('nav.testnet') : t('nav.mainnet')}
          </button>
        );
      })}
    </div>
  );

  const primaryAction = (size: 'sm' | 'lg') =>
    signedIn ? (
      <Link
        href="/dashboard"
        className={`inline-flex items-center justify-center gap-1 rounded-full bg-gold font-medium text-[#1d1d1f] transition-colors duration-200 hover:bg-[#f0bd5e] active:scale-[0.97] ${
          size === 'lg' ? 'h-12 w-full text-[17px]' : 'h-8 px-3.5 text-[12px]'
        } ${focusRing}`}
      >
        {t('nav.openDashboard')}
        {size === 'lg' && <ArrowRight className="h-4 w-4" />}
      </Link>
    ) : (
      <button
        type="button"
        onClick={() => {
          setMenuOpen(false);
          onLogin();
        }}
        className={`inline-flex items-center justify-center gap-1 rounded-full bg-gold font-medium text-[#1d1d1f] transition-colors duration-200 hover:bg-[#f0bd5e] active:scale-[0.97] ${
          size === 'lg' ? 'h-12 w-full text-[17px]' : 'h-8 px-3.5 text-[12px]'
        } ${focusRing}`}
      >
        {t('nav.login')}
        {size === 'lg' && <ArrowRight className="h-4 w-4" />}
      </button>
    );

  const bar = scrolled;

  return (
    <header className="fixed inset-x-0 top-0 z-40">
      <div
        className={`border-b transition-[background-color,border-color,backdrop-filter] duration-500 ${
          bar
            ? 'border-white/[0.08] bg-black/70 backdrop-blur-xl backdrop-saturate-[1.8]'
            : 'border-transparent bg-transparent'
        }`}
      >
        <div className="mx-auto flex h-[52px] max-w-[1180px] items-center justify-between gap-6 px-5 sm:px-8">
          {wordmark()}

          <div className="hidden items-center gap-7 md:flex">
            <nav aria-label="Primary" className="flex items-center gap-6">
              {NAV_LINKS.map((link) =>
                link.href.startsWith('#') ? (
                  <a
                    key={link.href}
                    href={link.href}
                    onClick={(e) => {
                      e.preventDefault();
                      goToAnchor(link.href);
                    }}
                    className={`rounded text-[13px] text-mist-2 transition-colors duration-200 hover:text-mist ${focusRing}`}
                  >
                    {t(link.key)}
                  </a>
                ) : (
                  <Link
                    key={link.href}
                    href={link.href}
                    className={`rounded text-[13px] text-mist-2 transition-colors duration-200 hover:text-mist ${focusRing}`}
                  >
                    {t(link.key)}
                  </Link>
                )
              )}
            </nav>
            <div className="flex items-center gap-2.5">
              <LocaleSwitcher compact variant="glass" />
              {networkControl('sm')}
              {primaryAction('sm')}
            </div>
          </div>

          <div className="flex items-center gap-1 md:hidden">
            {primaryAction('sm')}
            <Dialog.Root open={menuOpen} onOpenChange={setMenuOpen}>
              <Dialog.Trigger asChild>
                <button
                  type="button"
                  className={`relative -mr-2.5 flex h-11 w-11 items-center justify-center rounded-full ${focusRing}`}
                  aria-label="Open menu"
                >
                  {/* Two bars — Apple's menu glyph (the sheet's close is the X). */}
                  <span aria-hidden className="absolute h-[1.5px] w-[17px] -translate-y-[3.5px] rounded-full bg-mist" />
                  <span aria-hidden className="absolute h-[1.5px] w-[17px] translate-y-[3.5px] rounded-full bg-mist" />
                </button>
              </Dialog.Trigger>
              <Dialog.Portal>
                <Dialog.Content
                  aria-describedby={undefined}
                  className={`apple ${fontVariables} fixed inset-0 z-50 overflow-y-auto bg-black/[0.94] backdrop-blur-2xl focus:outline-none`}
                >
                  <Dialog.Title className="sr-only">Menu</Dialog.Title>
                  {/* The sheet carries its own bar so the close control lives
                      inside the dialog (focus trap + screen readers reach it). */}
                  <div className="flex h-[52px] items-center justify-between px-5 sm:px-8">
                    {wordmark(() => setMenuOpen(false))}
                    <Dialog.Close asChild>
                      <button
                        type="button"
                        className={`relative -mr-2.5 flex h-11 w-11 items-center justify-center rounded-full ${focusRing}`}
                        aria-label="Close menu"
                      >
                        <span aria-hidden className="absolute h-[1.5px] w-[17px] rotate-45 rounded-full bg-mist" />
                        <span aria-hidden className="absolute h-[1.5px] w-[17px] -rotate-45 rounded-full bg-mist" />
                      </button>
                    </Dialog.Close>
                  </div>
                  <div className="px-8 pb-12 pt-4">
                  <nav aria-label="Primary">
                    <ul className="flex flex-col">
                      {NAV_LINKS.map((link, i) => (
                        <motion.li
                          key={link.href}
                          initial={reduce ? false : { opacity: 0, y: -8 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ duration: 0.5, delay: 0.04 + i * 0.05, ease: EASE_APPLE }}
                        >
                          {link.href.startsWith('#') ? (
                            <a
                              href={link.href}
                              onClick={(e) => {
                                e.preventDefault();
                                setMenuOpen(false);
                                // Let the dialog release its scroll lock first.
                                window.setTimeout(() => goToAnchor(link.href), 60);
                              }}
                              className={`block rounded py-2.5 text-[28px] font-semibold leading-tight tracking-[0.007em] text-mist ${focusRing}`}
                            >
                              {t(link.key)}
                            </a>
                          ) : (
                            <Link
                              href={link.href}
                              onClick={() => setMenuOpen(false)}
                              className={`block rounded py-2.5 text-[28px] font-semibold leading-tight tracking-[0.007em] text-mist ${focusRing}`}
                            >
                              {t(link.key)}
                            </Link>
                          )}
                        </motion.li>
                      ))}
                    </ul>
                  </nav>

                  <motion.div
                    initial={reduce ? false : { opacity: 0, y: -8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.5, delay: 0.22, ease: EASE_APPLE }}
                    className="mt-10 space-y-6 border-t border-white/[0.1] pt-8"
                  >
                    <div className="flex items-center justify-between gap-4">
                      <span className="text-[13px] text-mist-3">Language</span>
                      <LocaleSwitcher compact variant="glass" />
                    </div>
                    <div className="space-y-3">
                      <span className="block text-[13px] text-mist-3">
                        {t('nav.viewing', {
                          network: network === 'testnet' ? t('nav.testnet') : t('nav.mainnet'),
                        })}
                      </span>
                      {networkControl('lg')}
                    </div>
                    <div className="pt-2">{primaryAction('lg')}</div>
                  </motion.div>
                  </div>
                </Dialog.Content>
              </Dialog.Portal>
            </Dialog.Root>
          </div>
        </div>
      </div>
    </header>
  );
}
