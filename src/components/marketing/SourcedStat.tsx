// SourcedStat — renders a figure with its citation attached.
//
// The point is that there is no way to display a number here without also
// displaying where it came from and what year it describes. The stat blocks
// this replaces were four big numbers with a caption each and no provenance,
// which is how invented figures survived on these pages for so long.
//
// For a claim that is true by construction rather than measured — "no operator
// function can move member funds" — use <PlainStat>, which deliberately has no
// number to attribute.

import type { SourcedFact } from '@/content/sourced-facts';

export function SourcedStat({ fact }: { fact: SourcedFact }) {
  return (
    <div className="flex flex-col">
      <div className="text-3xl font-bold text-gold">{fact.value}</div>
      <div className="mt-2 text-sm leading-6 text-sand">{fact.label}</div>
      <a
        href={fact.url}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-2 text-xs text-sand-dim underline-offset-4 transition-colors hover:text-gold-hi hover:underline"
      >
        {fact.source}, {fact.year}
      </a>
    </div>
  );
}

/**
 * A claim about how the product works, not a measurement. No source line,
 * because there is nothing external to cite — it either holds in the contract
 * or it does not.
 */
export function PlainStat({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-col">
      <div className="text-3xl font-bold text-cream">{value}</div>
      <div className="mt-2 text-sm leading-6 text-sand">{label}</div>
    </div>
  );
}
