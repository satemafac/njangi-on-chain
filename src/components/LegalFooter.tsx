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

export function LegalFooter({ className }: { className?: string }) {
  return (
    <nav
      aria-label="Legal"
      className={`flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-[#6b7280] ${className ?? ''}`}
    >
      {LEGAL_FOOTER_LINKS.map((link, index) => (
        <React.Fragment key={link.href}>
          {index > 0 && (
            <span aria-hidden="true" className="text-[#9ca3af]">
              ·
            </span>
          )}
          <Link
            href={link.href}
            className="underline-offset-4 transition-colors hover:text-[#111827] hover:underline"
          >
            {link.label}
          </Link>
        </React.Fragment>
      ))}
    </nav>
  );
}

export default LegalFooter;
