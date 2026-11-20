/**
 * NJA-3377 (refile of NJA-2809) — the FAQ "cost-to-use" answer, exact wording.
 *
 * Legal matter LC-T-8dfdc8c5 is decided "proceed with a condition": the
 * answer must not use the word "free" or say members never pay. It may say
 * the network fee can be covered for members of some circles (a Premium
 * admin's, on USDC contributions and payouts) and that otherwise members pay
 * it.
 *
 * src/pages/faq.tsx:52 still opens "Running a circle is free." — the exact
 * wording the condition rules out — and names neither the Premium coverage
 * nor the SUI fallback. The same `faqCategories` array feeds the visible
 * <FaqList> (faq.tsx:254-258) and the FAQPage JSON-LD (faq.tsx:186-193), so
 * the one string is published twice.
 *
 * The array is a `const` inside the FAQPage component, not an export, and
 * jest runs with testEnvironment 'node' here, so (as seo-invariants.test.ts
 * does) this reads the page source from disk rather than rendering it. No
 * network, RPC or wallet is involved. A source that no longer contains a
 * "cost-to-use" item fails loudly: it is not treated as an empty answer.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FAQ_PAGE = join(__dirname, '..', '..', 'pages', 'faq.tsx');

/** The wording approved under legal condition LC-T-8dfdc8c5, verbatim. */
const APPROVED_ANSWER =
  'Njangi On-Chain charges nothing to run a circle, and we take no cut of contributions or payouts. ' +
  'Each contribution or payout is a Sui network transaction with a small network fee (usually a few cents) that goes to the network, not to us. ' +
  "If your circle's admin has a Premium subscription, that fee can be covered for members on USDC contributions and payouts, within fair-use limits; SUI contributions, and any transaction that cannot be covered, fall back to the member paying the fee. " +
  'Premium also unlocks coordination features — larger circles, WhatsApp notifications and smart goals — and is paid by the circle admin; see the pricing page for what is included. ' +
  "Your circle's money is never behind a paywall.";

/** The `answer` string literal of the item whose id is "cost-to-use", unescaped. */
function costToUseAnswer(): string {
  const source = readFileSync(FAQ_PAGE, 'utf8');
  const match = source.match(
    /id:\s*"cost-to-use",\s*question:\s*"(?:[^"\\]|\\.)*",\s*answer:\s*"((?:[^"\\]|\\.)*)"/,
  );
  // A read that fails is not a fact: no item means no answer, not an empty one.
  expect(match).not.toBeNull();
  const raw = (match as RegExpMatchArray)[1];
  return raw
    .replace(/\\u([0-9a-fA-F]{4})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\(.)/g, '$1');
}

describe('FAQ cost-to-use answer (NJA-3377, legal condition LC-T-8dfdc8c5)', () => {
  it('does not use the word "free" and does not say members never pay', () => {
    const answer = costToUseAnswer();
    // faq.tsx:52 — "Running a circle is free." (fails on this commit)
    expect(answer).not.toMatch(/\bfree\b/i);
    expect(answer).not.toMatch(/never pay/i);
  });

  it('names the Premium coverage and the SUI fallback', () => {
    const answer = costToUseAnswer();
    expect(answer).toMatch(/Premium subscription/);
    expect(answer).toMatch(/fee can be covered for members/i);
    expect(answer).toMatch(/SUI contributions[^.]*fall back to the member paying the fee/i);
  });

  it('is exactly the wording the legal condition approved', () => {
    expect(costToUseAnswer()).toBe(APPROVED_ANSWER);
  });
});
