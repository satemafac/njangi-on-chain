import Link from 'next/link';
import type { MouseEventHandler, ReactNode } from 'react';
import { ChevronRight, Plus } from 'lucide-react';

/*
 * Shared Apple-style controls for the public site (landing, /learn, /faq,
 * /pricing, /blog): pill buttons, chevron links, section type, and the FAQ
 * accordion. One definition so the pages cannot drift apart again.
 */

export const focusRing =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/80 focus-visible:ring-offset-2 focus-visible:ring-offset-black';

/** Primary action: solid gold pill, 17px, presses in rather than lifting. */
export const goldButtonClass = `inline-flex h-12 items-center justify-center gap-1.5 rounded-full bg-gold px-7 text-[17px] font-medium tracking-[-0.022em] text-[#1d1d1f] transition-[background-color,transform] duration-200 hover:bg-[#f0bd5e] active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-60 ${focusRing}`;

/** Secondary action: translucent pill. */
export const quietButtonClass = `inline-flex h-12 items-center justify-center gap-1.5 rounded-full bg-white/[0.1] px-6 text-[17px] font-medium tracking-[-0.022em] text-mist transition-[background-color,transform] duration-200 hover:bg-white/[0.16] active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-60 ${focusRing}`;

export const chevronLinkClass = `group inline-flex items-center gap-0.5 rounded text-[17px] tracking-[-0.022em] text-gold underline-offset-4 hover:underline ${focusRing}`;

export const eyebrowClass = 'type-eyebrow text-gold';
export const sectionTitleClass = 'type-section mt-3 text-balance text-mist';
export const sectionBodyClass = 'type-intro mx-auto mt-5 max-w-[42rem] text-balance text-mist-2';

/** Apple's "Learn more ›" link. In-page anchors render a plain <a>. */
export function ChevronLink({
  href,
  children,
  onClick,
  className = '',
}: {
  href: string;
  children: ReactNode;
  onClick?: MouseEventHandler<HTMLAnchorElement>;
  className?: string;
}) {
  const content = (
    <>
      {children}
      <ChevronRight
        aria-hidden
        className="h-[1.05em] w-[1.05em] transition-transform duration-200 group-hover:translate-x-0.5 rtl:rotate-180 rtl:group-hover:-translate-x-0.5"
        strokeWidth={2}
      />
    </>
  );
  const cls = `${chevronLinkClass} ${className}`;
  return href.startsWith('#') ? (
    <a href={href} onClick={onClick} className={cls}>
      {content}
    </a>
  ) : (
    <Link href={href} className={cls}>
      {content}
    </Link>
  );
}

export type FaqItem = { id: string; question: ReactNode; answer: ReactNode };

/**
 * Hairline accordion: large question, +/× disc, answer eased open by a
 * grid-rows transition. Collapsed answers stay in the DOM (search engines
 * read them; FAQPage markup must match visible text) but are `inert`, so
 * they drop out of the tab order and the accessibility tree while closed.
 */
export function FaqList({
  items,
  open,
  onToggle,
  idPrefix = 'faq',
}: {
  items: FaqItem[];
  open: Record<string, boolean>;
  onToggle: (id: string) => void;
  idPrefix?: string;
}) {
  return (
    <div className="border-b border-white/[0.1]">
      {items.map((item) => {
        const isOpen = !!open[item.id];
        return (
          <div key={item.id} className="border-t border-white/[0.1]">
            <h3>
              <button
                type="button"
                id={`${idPrefix}-q-${item.id}`}
                onClick={() => onToggle(item.id)}
                aria-expanded={isOpen}
                aria-controls={`${idPrefix}-panel-${item.id}`}
                className={`group flex w-full items-center justify-between gap-6 rounded-lg py-6 text-start ${focusRing}`}
              >
                <span className="text-[clamp(1.1875rem,1.08rem+0.45vw,1.5rem)] font-semibold leading-snug tracking-[0.009em] text-mist">
                  {item.question}
                </span>
                <span
                  aria-hidden
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/[0.08] text-mist-2 transition-colors duration-200 group-hover:bg-white/[0.14] group-hover:text-mist"
                >
                  <Plus
                    className={`h-4 w-4 transition-transform duration-300 ease-[cubic-bezier(0.25,0.1,0.25,1)] ${
                      isOpen ? 'rotate-45' : ''
                    }`}
                    strokeWidth={2.2}
                  />
                </span>
              </button>
            </h3>
            <div
              id={`${idPrefix}-panel-${item.id}`}
              role="region"
              aria-labelledby={`${idPrefix}-q-${item.id}`}
              inert={!isOpen}
              className={`grid transition-[grid-template-rows,opacity] duration-500 ease-[cubic-bezier(0.28,0.11,0.32,1)] ${
                isOpen ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
              }`}
            >
              <div className="overflow-hidden">
                <div className="type-body max-w-[46rem] pb-7 text-mist-2">{item.answer}</div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
