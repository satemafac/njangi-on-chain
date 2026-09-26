// ProseBlocks — the structured pieces a long-form page sets inside the
// `.prose-apple` reading column (BlogPost, LearnGuide).
//
// Everything else in an article body is plain semantic HTML styled by
// `.prose-apple` in globals.css. These cover what prose can't: a row of cited
// figures, a comparison, an aside, a definition list, a numbered process. Each
// sets its own type with utility classes, which outrank the column's
// zero-specificity `:where()` rules, so nothing here inherits paragraph
// margins or list bullets by accident.

import Link from 'next/link';
import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

import { ChevronLink, goldButtonClass } from '../landing/ui';

/** A row of cited figures set off from the prose (SourcedStat children). */
export function Figures({ children, note }: { children: ReactNode; note?: ReactNode }) {
  return (
    <div className="my-12 rounded-[28px] bg-ink-surface p-7 sm:p-9">
      <div className="grid gap-9 sm:grid-cols-[repeat(auto-fit,minmax(180px,1fr))]">{children}</div>
      {note && <p className="type-caption mt-6 text-mist-3">{note}</p>}
    </div>
  );
}

/** Two (or more) short lists compared side by side; `highlight` marks ours. */
export function SideBySide({
  columns,
}: {
  columns: { title: ReactNode; points: ReactNode[]; highlight?: boolean }[];
}) {
  return (
    <div className="my-10 grid gap-4 sm:grid-cols-2">
      {columns.map((col, i) => (
        <div
          key={i}
          className={`rounded-[22px] p-6 sm:p-7 ${
            col.highlight ? 'bg-gold/[0.08] ring-1 ring-gold/25' : 'bg-ink-surface'
          }`}
        >
          <div className={`text-[17px] font-semibold tracking-[-0.01em] ${col.highlight ? 'text-gold' : 'text-mist'}`}>
            {col.title}
          </div>
          <ul className="m-0 mt-4 list-none space-y-2.5 p-0">
            {col.points.map((point, j) => (
              <li key={j} className="type-caption m-0 flex gap-2.5 p-0 text-mist-2">
                <span aria-hidden className="mt-[0.6em] h-1 w-1 shrink-0 rounded-full bg-current opacity-60" />
                <span>{point}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** An aside in the reading column — a note, a warning, a set of links. */
export function Callout({
  icon: Icon,
  title,
  tone = 'plain',
  children,
}: {
  icon?: LucideIcon;
  title?: ReactNode;
  tone?: 'plain' | 'gold';
  children: ReactNode;
}) {
  return (
    <aside
      className={`my-10 rounded-[22px] p-6 sm:p-7 ${tone === 'gold' ? 'bg-gold/[0.08]' : 'bg-ink-surface'}`}
    >
      {(Icon || title) && (
        <div className="flex items-center gap-2.5 text-[17px] font-semibold tracking-[-0.01em] text-mist">
          {Icon && <Icon aria-hidden className="h-[18px] w-[18px] shrink-0 text-gold" strokeWidth={2} />}
          {title}
        </div>
      )}
      <div className={`type-body text-mist-2 [&_strong]:font-semibold [&_strong]:text-mist ${Icon || title ? 'mt-3' : ''}`}>
        {children}
      </div>
    </aside>
  );
}

/** Short answers to the questions a page exists for ("X meaning", "X in
 *  English"): a hairline-divided definition list in one tile. */
export function Definitions({ children }: { children: ReactNode }) {
  return (
    <dl className="my-10 divide-y divide-white/[0.08] rounded-[22px] bg-ink-surface px-6 sm:px-8">{children}</dl>
  );
}

export function Definition({ term, children }: { term: ReactNode; children: ReactNode }) {
  return (
    <div className="py-6">
      <dt className="text-[14px] font-semibold tracking-[-0.005em] text-gold">{term}</dt>
      <dd className="m-0 mt-2 text-[17px] leading-[1.6] tracking-[-0.01em] text-cream-muted">{children}</dd>
    </div>
  );
}

type Point = { title: ReactNode; body: ReactNode };

/** Named points under a hairline — characteristics, problems and fixes. */
export function KeyPoints({ items, columns = 2 }: { items: Point[]; columns?: 2 | 3 }) {
  return (
    <ul
      className={`my-8 grid list-none gap-x-8 gap-y-7 p-0 sm:grid-cols-2 ${columns === 3 ? 'lg:grid-cols-3' : ''}`}
    >
      {items.map((item, i) => (
        <li key={i} className="m-0 border-t border-white/[0.12] p-0 pt-4">
          <p className="m-0 text-[17px] font-semibold tracking-[-0.01em] text-mist">{item.title}</p>
          <p className="type-caption m-0 mt-1.5 text-mist-3">{item.body}</p>
        </li>
      ))}
    </ul>
  );
}

/** A numbered process. The number is drawn, so titles carry no "1." prefix. */
export function Steps({ items }: { items: Point[] }) {
  return (
    <ol className="my-8 list-none space-y-6 p-0">
      {items.map((item, i) => (
        <li key={i} className="m-0 flex gap-4 p-0">
          <span
            aria-hidden
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gold/[0.14] text-[14px] font-semibold tabular-nums text-gold"
          >
            {i + 1}
          </span>
          <div className="min-w-0 pt-1">
            <p className="m-0 text-[17px] font-semibold tracking-[-0.01em] text-mist">{item.title}</p>
            <p className="type-caption m-0 mt-1.5 text-mist-3">{item.body}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

/** Small named tiles — the same practice under other names, regions, roles. */
export function TermGrid({ items }: { items: Point[] }) {
  return (
    <ul className="my-8 grid list-none gap-3 p-0 sm:grid-cols-2">
      {items.map((item, i) => (
        <li key={i} className="m-0 rounded-[18px] bg-ink-surface p-5">
          <p className="m-0 text-[17px] font-semibold tracking-[-0.01em] text-mist">{item.title}</p>
          <p className="type-caption m-0 mt-1 text-mist-3">{item.body}</p>
        </li>
      ))}
    </ul>
  );
}

/** A call to action inside the reading column: a gold pill, optionally with
 *  a secondary chevron link beside it (the hero's pattern). */
export function ProseAction({
  href,
  children,
  secondary,
}: {
  href: string;
  children: ReactNode;
  secondary?: { label: string; href: string };
}) {
  return (
    <div className="my-10 flex flex-col items-start gap-5 sm:flex-row sm:items-center sm:gap-8">
      <Link href={href} className={`${goldButtonClass} no-underline`}>
        {children}
      </Link>
      {secondary && (
        <ChevronLink href={secondary.href} className="no-underline hover:underline">
          {secondary.label}
        </ChevronLink>
      )}
    </div>
  );
}

/** A code sketch. It scrolls inside its own box: the page shell clips
 *  horizontal overflow, so a bare <pre> would lose its long lines on a phone. */
export function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="my-10 overflow-x-auto rounded-[22px] bg-ink-surface p-6 font-mono text-[13px] leading-[1.7] tracking-normal text-mist-2 sm:p-7">
      <code>{children}</code>
    </pre>
  );
}
