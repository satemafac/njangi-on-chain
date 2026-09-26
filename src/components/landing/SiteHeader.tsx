import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import * as Dialog from '@radix-ui/react-dialog';
import { ArrowRight } from 'lucide-react';
import { sansFont, serifFont } from './fonts';
import { focusRing } from './ui';

export type SiteNavLink = { href: string; label: string };
export type SiteAction = { label: string; href?: string; onClick?: () => void };

type Props = {
  links: SiteNavLink[];
  /** The gold pill: a link (`href`) or a button (`onClick`). */
  primary: SiteAction;
  /** Desktop controls between the links and the primary action. */
  controls?: ReactNode;
  /** Extra rows for the mobile sheet; call `close` before acting. */
  sheetExtras?: (close: () => void) => ReactNode;
};

/** Stagger for the mobile sheet's rows (see `.rise` in globals.css). */
const sheetRise = (i: number) =>
  ({ '--d': `${40 + i * 50}ms`, '--rise': '-8px', animationDuration: '0.5s' }) as CSSProperties;

/** Scroll to an in-page anchor, honouring reduced motion. */
function goToAnchor(hash: string) {
  const el = document.getElementById(hash.replace(/^#/, ''));
  if (!el) return;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  history.replaceState(null, '', hash);
}

/**
 * Apple-style global bar for the public site: one 52px row, transparent at
 * the top of the page and frosted (blur + saturate) with a hairline once it
 * scrolls. Desktop carries links + controls inline; below `md` everything
 * folds into a full-screen sheet whose rows settle in with a short stagger.
 * Fixed-position — pages leave 52px at the top (or bleed a hero under it).
 */
export default function SiteHeader({ links, primary, controls, sheetExtras }: Props) {
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

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

  const close = () => setMenuOpen(false);

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
        <span className={`${serifFont.className} text-[1.5rem] leading-none tracking-[-0.03em] text-mist`}>
          Njangi
        </span>
        <span className="text-[0.58rem] font-semibold uppercase tracking-[0.3em] text-gold">
          On-chain
        </span>
      </span>
      <span className="sr-only">Njangi On-Chain home</span>
    </Link>
  );

  const action = (size: 'sm' | 'lg') => {
    const cls = `inline-flex items-center justify-center gap-1 rounded-full bg-gold font-medium text-[#1d1d1f] transition-colors duration-200 hover:bg-[#f0bd5e] active:scale-[0.97] ${
      size === 'lg' ? 'h-12 w-full text-[17px]' : 'h-8 px-3.5 text-[12px]'
    } ${focusRing}`;
    const content = (
      <>
        {primary.label}
        {size === 'lg' && <ArrowRight aria-hidden className="h-4 w-4 rtl:rotate-180" />}
      </>
    );
    return primary.href ? (
      <Link href={primary.href} onClick={close} className={cls}>
        {content}
      </Link>
    ) : (
      <button
        type="button"
        onClick={() => {
          close();
          primary.onClick?.();
        }}
        className={cls}
      >
        {content}
      </button>
    );
  };

  const navLink = (link: SiteNavLink, variant: 'bar' | 'sheet') => {
    const cls =
      variant === 'bar'
        ? `rounded text-[13px] text-mist-2 transition-colors duration-200 hover:text-mist ${focusRing}`
        : `block rounded py-2.5 text-[28px] font-semibold leading-tight tracking-[0.007em] text-mist ${focusRing}`;
    if (link.href.startsWith('#')) {
      return (
        <a
          href={link.href}
          onClick={(e) => {
            e.preventDefault();
            if (variant === 'sheet') {
              close();
              // Let the dialog release its scroll lock first.
              window.setTimeout(() => goToAnchor(link.href), 60);
            } else {
              goToAnchor(link.href);
            }
          }}
          className={cls}
        >
          {link.label}
        </a>
      );
    }
    return (
      <Link href={link.href} onClick={variant === 'sheet' ? close : undefined} className={cls}>
        {link.label}
      </Link>
    );
  };

  return (
    <header className="fixed inset-x-0 top-0 z-40">
      <div
        className={`border-b transition-[background-color,border-color,backdrop-filter] duration-500 ${
          scrolled
            ? 'border-white/[0.08] bg-black/70 backdrop-blur-xl backdrop-saturate-[1.8]'
            : 'border-transparent bg-transparent'
        }`}
      >
        <div className="mx-auto flex h-[52px] max-w-[1180px] items-center justify-between gap-6 px-5 sm:px-8">
          {wordmark()}

          <div className="hidden items-center gap-7 md:flex">
            <nav aria-label="Primary" className="flex items-center gap-6">
              {links.map((link) => (
                <span key={link.href}>{navLink(link, 'bar')}</span>
              ))}
            </nav>
            <div className="flex items-center gap-2.5">
              {controls}
              {action('sm')}
            </div>
          </div>

          <div className="flex items-center gap-1 md:hidden">
            {action('sm')}
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
                  className={`apple ${sansFont.variable} fixed inset-0 z-50 overflow-y-auto bg-black/[0.94] backdrop-blur-2xl focus:outline-none`}
                >
                  <Dialog.Title className="sr-only">Menu</Dialog.Title>
                  {/* The sheet carries its own bar so the close control lives
                      inside the dialog (focus trap + screen readers reach it). */}
                  <div className="flex h-[52px] items-center justify-between px-5 sm:px-8">
                    {wordmark(close)}
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
                      {/* Rows settle in with a short stagger — the CSS `.rise`
                          keyframes (globals.css), so the header never pulls
                          framer-motion into pages that don't otherwise use it;
                          the global reduced-motion rule makes it instant. */}
                      <ul className="flex flex-col">
                        {links.map((link, i) => (
                          <li key={link.href} className="rise" style={sheetRise(i)}>
                            {navLink(link, 'sheet')}
                          </li>
                        ))}
                      </ul>
                    </nav>

                    <div
                      className="rise mt-10 space-y-6 border-t border-white/[0.1] pt-8"
                      style={sheetRise(links.length)}
                    >
                      {sheetExtras?.(close)}
                      <div className="pt-2">{action('lg')}</div>
                    </div>
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
