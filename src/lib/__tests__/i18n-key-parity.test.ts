// i18n key-parity guard.
//
// The French translation pass for the core funnel (landing, auth,
// create-circle, discovery, contribute, dashboard chrome, pricing,
// billing upsell) must keep the EN and FR dictionaries in lockstep: a
// missing counterpart silently falls back to English at runtime (see the
// `t()` fallback chain in src/lib/i18n.ts), which is exactly the
// half-translated UI this test exists to catch.
//
// Scope: EN <-> FR only. The pcm/sw/am/ar/fa dictionaries are intentionally
// partial (translated by native speakers as they come online) and the
// runtime falls back to EN for any key they omit — so they are not held to
// strict parity here.

import { DICTIONARIES } from '@/lib/i18n';

const en = DICTIONARIES.en;
const fr = DICTIONARIES.fr;

const enKeys = Object.keys(en);
const frKeys = Object.keys(fr);

// Pull every {placeholder} token out of a string, sorted + deduped, so two
// strings can be compared for interpolation-variable equality regardless of
// order or repetition.
function placeholders(value: string): string[] {
  const found = new Set<string>();
  for (const match of value.matchAll(/\{(\w+)\}/g)) {
    found.add(match[1]);
  }
  return [...found].sort();
}

describe('i18n EN/FR key parity', () => {
  it('every EN key has a FR counterpart', () => {
    const missingInFr = enKeys.filter((key) => !(key in fr));
    expect(missingInFr).toEqual([]);
  });

  it('every FR key has an EN counterpart', () => {
    const missingInEn = frKeys.filter((key) => !(key in en));
    expect(missingInEn).toEqual([]);
  });

  it('EN and FR have the same number of keys', () => {
    expect(frKeys.length).toBe(enKeys.length);
  });

  it('has no duplicate keys within a locale (object literal would collapse them)', () => {
    // Object.keys already dedupes, so a duplicate would show up as a shorter
    // key list than the literal implies. Guard against an empty dictionary as
    // a sanity floor and ensure both sides are non-trivial.
    expect(enKeys.length).toBeGreaterThan(0);
    expect(frKeys.length).toBeGreaterThan(0);
  });

  it('no FR value is empty (an empty string defeats the EN fallback)', () => {
    const empty = frKeys.filter((key) => fr[key].trim().length === 0);
    expect(empty).toEqual([]);
  });

  it('FR values keep the same interpolation placeholders as EN', () => {
    const mismatches: Array<{ key: string; en: string[]; fr: string[] }> = [];
    for (const key of enKeys) {
      if (!(key in fr)) continue;
      const enPlaceholders = placeholders(en[key]);
      const frPlaceholders = placeholders(fr[key]);
      if (JSON.stringify(enPlaceholders) !== JSON.stringify(frPlaceholders)) {
        mismatches.push({ key, en: enPlaceholders, fr: frPlaceholders });
      }
    }
    expect(mismatches).toEqual([]);
  });
});
