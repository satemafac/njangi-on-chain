/**
 * NJA-2810 — FAQ: the currencies answer lists SUI as a contribution currency.
 *
 * src/pages/faq.tsx (`currencies-supported`, "What currencies can I use?")
 * answers "Two: USDC and SUI." The mainnet create form offers USDC only
 * (src/lib/create-circle-coin.ts, CREATE_CIRCLE_COINS_BY_NETWORK.mainnet is
 * ['USDC']); SUI pays network fees and nothing else. The same answer is
 * emitted as FAQPage JSON-LD, so the claim also reaches search engines.
 *
 * Source-text assertion rather than a render test: jest runs
 * `testEnvironment: 'node'` and `testMatch` only collects `.test.ts`, so the
 * page cannot be mounted here (same technique as
 * src/__tests__/learn/what-is-njangi-penalty-copy.test.ts). The page is read
 * by relative path; readFileSync throws if it is missing or unreadable, and
 * the answer block must be found before anything is asserted about it — a
 * failed or partial read never passes as "SUI is not listed".
 */
import { readFileSync } from 'fs';
import path from 'path';

const PAGE = path.resolve(__dirname, '../../pages/faq.tsx');

/** Comments explaining the rule must not trip it. */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/**
 * The answer string of the `currencies-supported` FAQ item, or null when the
 * block is not where expected (then the guard below fails, by design).
 */
const currenciesAnswer = (source: string): string | null => {
  const match = source.match(
    /id:\s*["']currencies-supported["'],\s*question:\s*["']What currencies can I use\?["'],\s*answer:\s*(["'`])((?:(?!\1)[^\\]|\\.)*)\1/,
  );
  return match ? match[2] : null;
};

/** Sentences of the answer that name the coin SUI (upper case; the network is written "Sui"). */
const sentencesNamingSui = (answer: string): string[] =>
  answer.split(/(?<=[.!?])\s+/).filter((sentence) => /\bSUI\b/.test(sentence));

describe('faq "What currencies can I use?" answer (NJA-2810)', () => {
  const source = stripComments(readFileSync(PAGE, 'utf8'));
  const answer = currenciesAnswer(source);

  it('is reading the currencies-supported item of the FAQ page', () => {
    // Guards that the file and block still exist, so the assertions below are
    // about the right text and not vacuously true.
    expect(source).toContain('id: "currencies-supported"');
    expect(answer).not.toBeNull();
  });

  it('does not list SUI beside USDC as a currency a circle can contribute in', () => {
    expect(answer).not.toBeNull();
    // "USDC and SUI" / "USDC or SUI" presents SUI as a second contribution
    // currency; mainnet circles settle in USDC only (create-circle-coin.ts).
    expect(answer!).not.toMatch(/\bUSDC\b\s+(and|or)\s+\bSUI\b/);
    expect(answer!).not.toMatch(/\bSUI\b\s+(and|or)\s+\bUSDC\b/);
    // Nor a count of two currencies.
    expect(answer!).not.toMatch(/\bTwo\b/);
  });

  it('says circles settle in USDC, and names SUI only for network fees', () => {
    expect(answer).not.toBeNull();
    expect(answer!).toContain('USDC');
    // The coin may be mentioned, but only in a sentence about fees (gas).
    for (const sentence of sentencesNamingSui(answer!)) {
      expect(sentence).toMatch(/fees?|gas/);
    }
  });

  it('keeps the warning about other assets and other networks', () => {
    expect(answer).not.toBeNull();
    expect(answer!).toMatch(/any other asset/);
    expect(answer!).toMatch(/network other than Sui/);
  });
});
