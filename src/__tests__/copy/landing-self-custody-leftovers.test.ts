/**
 * NJA-3572 (follows NJA-3447 / PR #166): the landing hero was reworded, but
 * five other places still call contributions or the pot self-custodied, or say
 * no one holds it / Njangi never holds it. Under legal matter LC-T-e1ac6dc3 the
 * copy must describe the escrow plainly (each contribution is held by the
 * circle's escrow contract until the member whose turn it is collects it; each
 * member signs their own transactions), make no new promises ("fixed" order,
 * "nobody can", "never holds", "no one") and point to the FAQ on the
 * contract's upgrade key.
 *
 * The nine values, pinned exactly:
 *   - src/components/Seo.tsx DEFAULT_DESCRIPTION (imported)
 *   - src/pages/index.tsx <Seo description / ogDescription> and the
 *     'Njangi On-Chain' comparison item
 *   - src/pages/learn/index.tsx PlainStat value / label
 *   - src/lib/i18n.ts EN + FR landing.feature.selfCustody.title / .body
 *     (keys unchanged; pcm/sw/am/ar/fa have no landing.* keys and fall back to
 *     EN; 'pricing.free.feature.zklogin' is out of scope because a member's
 *     own wallet IS self-custodied)
 *
 * jest runs with testEnvironment 'node' and testMatch collects only .test.ts,
 * so the two pages are read as source (same technique as copy-guards.test.ts)
 * and nothing is rendered. The dictionaries use FLAT keys that contain dots;
 * toHaveProperty reads a dotted key as a nested path and can never match them,
 * so keys are read with bracket access and checked with
 * Object.prototype.hasOwnProperty.call.
 */
import { readFileSync } from 'fs';
import path from 'path';

import { DEFAULT_DESCRIPTION } from '../../components/Seo';
import { DICTIONARIES } from '../../lib/i18n';

// Seo.tsx imports next/head for the component; only its exported constant is
// under test here, so the Head component is stubbed.
jest.mock('next/head', () => ({ __esModule: true, default: () => null }));

const EXPECTED_DESCRIPTION =
  "Njangi, tontine, susu, esusu — the rotating savings circle your community already runs, now with each contribution held by the circle's escrow contract until the member whose turn it is collects it. No treasurer, no seed phrase.";
const EXPECTED_OG_DESCRIPTION =
  "The rotating savings circle your community already trusts — njangi, esusu, tontine — now on a schedule, with each contribution held by the circle's escrow contract until the member whose turn it is collects it. No treasurer. No seed phrase.";
const EXPECTED_COMPARISON_ITEM =
  "Contributions held by the circle's escrow contract until the member whose turn it is collects them";
const EXPECTED_STAT_VALUE = 'Escrow contract';
const EXPECTED_STAT_LABEL =
  "Contributions sit in each circle's escrow contract until the member whose turn it is collects them. Our FAQ explains who holds the contract's upgrade key.";

const FEATURE_KEYS = ['landing.feature.selfCustody.title', 'landing.feature.selfCustody.body'] as const;

const EXPECTED_EN: Record<(typeof FEATURE_KEYS)[number], string> = {
  'landing.feature.selfCustody.title': 'The pot sits in an escrow contract, not with a treasurer',
  'landing.feature.selfCustody.body':
    "Members contribute from their own wallets and sign their own transactions. Each contribution is held by the circle's escrow contract until the member whose turn it is collects it, so no treasurer holds the cash. Our FAQ explains how the escrow contract works and who holds its upgrade key.",
};

const EXPECTED_FR: Record<(typeof FEATURE_KEYS)[number], string> = {
  'landing.feature.selfCustody.title': 'La cagnotte est dans un contrat de séquestre, pas chez un trésorier',
  'landing.feature.selfCustody.body':
    "Les membres cotisent depuis leur propre portefeuille et signent leurs propres transactions. Chaque cotisation est gardée par le contrat de séquestre du cercle jusqu'à ce que le membre dont c'est le tour la récupère : aucun trésorier ne détient l'argent. Notre FAQ explique le fonctionnement du contrat de séquestre et qui détient sa clé de mise à jour.",
};

// Wording the legal decision ruled out, checked case-insensitively on every
// one of the nine values. One list for both locales so a locale borrowing the
// other's wording is caught too.
const BANNED = ['self-custod', 'autodétenu', 'fixed', 'fixe', 'nobody', 'no one', 'never'];

const en = DICTIONARIES.en;
const fr = DICTIONARIES.fr;
const has = (dict: Record<string, string>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(dict, key);

const SRC = path.resolve(__dirname, '..', '..');
const landing = readFileSync(path.join(SRC, 'pages', 'index.tsx'), 'utf8');
const learn = readFileSync(path.join(SRC, 'pages', 'learn', 'index.tsx'), 'utf8');

/** The source from the first `start` through the next `end`; throws if either is missing. */
function slice(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  if (from === -1) throw new Error(`"${start}" not found`);
  const to = source.indexOf(end, from + start.length);
  if (to === -1) throw new Error(`"${end}" not found after "${start}"`);
  return source.slice(from, to + end.length);
}

/** The value of a double-quoted JSX attribute; throws if the attribute is missing. */
function attr(block: string, name: string): string {
  const match = new RegExp(`\\b${name}="([^"]*)"`).exec(block);
  if (!match) throw new Error(`attribute ${name}="..." not found in: ${block}`);
  return match[1];
}

/** A TSX literal may escape an apostrophe; compare on the text a reader sees. */
const unescapeQuotes = (source: string): string =>
  source.replace(/\\'/g, "'").replace(/&apos;|&#39;/g, "'");

const seoBlock = slice(landing, '<Seo', '/>');
const comparisonBlock = slice(landing, "title: 'Njangi On-Chain'", ']');
const statBlock = slice(learn, '<PlainStat', '/>');

describe('self-custody wording left after #166 (NJA-3572)', () => {
  it('Seo DEFAULT_DESCRIPTION describes the escrow', () => {
    expect(DEFAULT_DESCRIPTION).toBe(EXPECTED_DESCRIPTION);
  });

  it('the landing <Seo> description is the same text', () => {
    expect(attr(seoBlock, 'description')).toBe(EXPECTED_DESCRIPTION);
  });

  it('the landing <Seo> ogDescription describes the escrow', () => {
    expect(attr(seoBlock, 'ogDescription')).toBe(EXPECTED_OG_DESCRIPTION);
  });

  it("the 'Njangi On-Chain' comparison item describes the escrow", () => {
    expect(unescapeQuotes(comparisonBlock)).toContain(EXPECTED_COMPARISON_ITEM);
    expect(comparisonBlock).not.toContain('Direct wallet settlement with self-custody');
  });

  it('the learn PlainStat names the escrow contract and points to the FAQ', () => {
    expect(statBlock).toMatch(new RegExp(`\\bvalue=\\{?["']${EXPECTED_STAT_VALUE}["']\\}?`));
    expect(unescapeQuotes(statBlock)).toContain(EXPECTED_STAT_LABEL);
    expect(statBlock).not.toContain('Self-custodied');
    expect(statBlock).not.toContain('No operator function can move member funds');
  });

  it('defines the feature keys as flat dotted keys in both dictionaries', () => {
    for (const key of FEATURE_KEYS) {
      expect(has(en, key)).toBe(true);
      expect(has(fr, key)).toBe(true);
    }
  });

  it.each(FEATURE_KEYS)('EN %s is exactly the approved text', (key) => {
    expect(en[key]).toBe(EXPECTED_EN[key]);
  });

  it.each(FEATURE_KEYS)('FR %s is exactly the approved text', (key) => {
    expect(fr[key]).toBe(EXPECTED_FR[key]);
  });

  // The nine values as they are on this commit, by name.
  const actual: ReadonlyArray<[string, string]> = [
    ['Seo DEFAULT_DESCRIPTION', DEFAULT_DESCRIPTION],
    ['index.tsx <Seo description>', attr(seoBlock, 'description')],
    ['index.tsx <Seo ogDescription>', attr(seoBlock, 'ogDescription')],
    ["index.tsx 'Njangi On-Chain' comparison items", comparisonBlock],
    ['learn/index.tsx <PlainStat>', statBlock],
    ...FEATURE_KEYS.map((key): [string, string] => [`en ${key}`, en[key]]),
    ...FEATURE_KEYS.map((key): [string, string] => [`fr ${key}`, fr[key]]),
  ];

  it.each(actual)('%s makes no ruled-out claim', (name, value) => {
    expect(typeof value).toBe('string');
    for (const word of BANNED) {
      // The failure message names the value and the word.
      expect(`${name} contains "${word}": ${value.toLowerCase().includes(word)}`).toBe(
        `${name} contains "${word}": false`,
      );
    }
  });
});
