import Image from 'next/image';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { LegalFooter } from '../LegalFooter';
import { serifFont } from './fonts';
import { focusRing } from './ui';

export type FooterLink = { href: string; label: string; external?: boolean };

/**
 * Apple-style footer for the public site: brand lockup (+ optional one-line
 * description), a quiet link row, then a hairline and the fine print —
 * rights, the legal links, and an optional tagline.
 */
export default function SiteFooter({
  links,
  description,
  rights,
  tagline,
}: {
  links: FooterLink[];
  description?: ReactNode;
  rights: ReactNode;
  tagline?: ReactNode;
}) {
  const linkCls = `type-caption rounded py-2.5 text-mist-2 transition-colors duration-200 hover:text-mist ${focusRing}`;
  return (
    <footer className="border-t border-white/[0.08]">
      <div className="mx-auto max-w-[1100px] px-5 py-12 sm:px-8">
        <div className="flex flex-col gap-8 md:flex-row md:items-start md:justify-between">
          <div className="max-w-sm">
            <Link href="/" className={`inline-flex items-center gap-3 rounded-full ${focusRing}`}>
              <span className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-full bg-white/[0.06]">
                <Image
                  src="/njangi-on-chain-logo.png"
                  alt=""
                  width={72}
                  height={72}
                  className="h-full w-full object-contain"
                  unoptimized
                />
              </span>
              <span className="flex items-baseline gap-1.5">
                <span className={`${serifFont.className} text-[1.6rem] leading-none tracking-[-0.03em] text-mist`}>
                  Njangi
                </span>
                <span className="text-[0.58rem] font-semibold uppercase tracking-[0.3em] text-gold">
                  On-chain
                </span>
              </span>
              <span className="sr-only">Njangi On-Chain home</span>
            </Link>
            {description && <p className="type-caption mt-4 text-mist-3">{description}</p>}
          </div>

          <nav aria-label="Footer" className="flex flex-wrap items-center gap-x-7 gap-y-1">
            {links.map((link) =>
              link.href.startsWith('/') ? (
                <Link key={link.label} href={link.href} className={linkCls}>
                  {link.label}
                </Link>
              ) : (
                <a
                  key={link.label}
                  href={link.href}
                  {...(link.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                  className={linkCls}
                >
                  {link.label}
                </a>
              )
            )}
          </nav>
        </div>

        <div className="type-fine mt-8 flex flex-col gap-3 border-t border-white/[0.08] pt-6 text-mist-3 md:flex-row md:items-center md:justify-between">
          <p>{rights}</p>
          <LegalFooter tone="dark" className="text-[12px]" />
          {tagline && <p>{tagline}</p>}
        </div>
      </div>
    </footer>
  );
}
