/**
 * NJA-2821 — Learn page: 'Emergency fund for penalties'.
 *
 * src/pages/learn/what-is-njangi.tsx lists 'Emergency fund for penalties'
 * under the Financial requirements for a member. Nothing in the app collects
 * penalties: both create-circle builders always send NO_PENALTY_RULES
 * (src/lib/zklogin-tx-builders.ts, NJA-2593), so the line asks members to set
 * money aside for a charge the product never makes.
 *
 * Source-text assertion rather than a render test: jest runs
 * `testEnvironment: 'node'` and `testMatch` only collects `.test.ts`, so the
 * page cannot be mounted here. Same technique as
 * src/lib/__tests__/copy-guards.test.ts. The page is read by relative path and
 * readFileSync throws if it is missing or unreadable — a failed read must not
 * pass as "no penalty line".
 */
import { readFileSync } from 'fs';
import path from 'path';

const PAGE = path.resolve(__dirname, '../../pages/learn/what-is-njangi.tsx');

/** Comments explaining the rule must not trip it. */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('learn/what-is-njangi requirements copy (NJA-2821)', () => {
  const source = stripComments(readFileSync(PAGE, 'utf8'));

  it('is reading the Financial requirements column of the page', () => {
    // Guards that the file and block still exist, so the assertions below are
    // about the right text and not vacuously true.
    expect(source).toContain("title: 'Financial'");
    expect(source).toContain('Security deposit (at least half of one contribution)');
  });

  it('does not tell members to keep an emergency fund for penalties', () => {
    expect(source).not.toContain('Emergency fund for penalties');
  });

  it('the Financial requirements list has no penalty point at all', () => {
    const financial = source.match(/title:\s*'Financial',\s*points:\s*\[([\s\S]*?)\]/);
    expect(financial).not.toBeNull();
    // Nothing in the app collects penalties (NO_PENALTY_RULES, NJA-2593).
    expect(financial![1]).not.toMatch(/penalt/i);
  });
});
