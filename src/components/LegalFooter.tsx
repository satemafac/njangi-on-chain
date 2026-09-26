// LegalFooter — compact legal link row (Terms · Privacy · Risk Disclosure ·
// Data Deletion) shared by the landing footer and the /legal pages.

import React from 'react';
import Link from 'next/link';

const LEGAL_FOOTER_LINKS: Array<{ href: string; label: string }> = [
  { href: '/legal/terms', label: 'Terms' },
  { href: '/legal/privacy', label: 'Privacy' },
  { href: '/legal/risk', label: 'Risk Disclosure' },
  { href: '/legal/data-deletion', label: 'Data Deletion' },
];

export function LegalFooter({
  className,
  tone = 'light',
}: {
  className?: string;
  /** 'dark' for black surfaces (the landing): hover lightens instead of
   *  darkening, which on black would make the link vanish. */
  tone?: 'light' | 'dark';
}) {
  const dark = tone === 'dark';
  return (
    <nav
      aria-label="Legal"
      className={`flex flex-wrap items-center gap-x-2 gap-y-1 ${
        dark ? 'text-mist-3' : 'text-sm text-[#6b7280]'
      } ${className ?? ''}`}
    >
      {LEGAL_FOOTER_LINKS.map((link, index) => (
        <React.Fragment key={link.href}>
          {index > 0 && (
            <span aria-hidden="true" className={dark ? 'text-mist-4' : 'text-[#9ca3af]'}>
              ·
            </span>
          )}
          <Link
            href={link.href}
            className={`underline-offset-4 transition-colors hover:underline ${
              dark ? 'hover:text-mist' : 'hover:text-[#111827]'
            }`}
          >
            {link.label}
          </Link>
        </React.Fragment>
      ))}
    </nav>
  );
}

export default LegalFooter;
