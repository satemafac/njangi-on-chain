/**
 * The single-word copy rules (scripts/lib/copy-guard.ts): the written policy
 * bans "invest(ment)", "returns" and "earn" in user-facing copy
 * (docs/compliance-roadmap-cex-dex-non-kyc.md §A3), while check:copy only
 * matched phrases. These pin what the words catch, what their ordinary senses
 * leave alone, and that code and comments are never read as copy.
 */
import { spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  extractMarkdownText,
  extractUserFacingText,
  findBareWordViolations,
} from '../../../scripts/lib/copy-guard';

const repoRoot = path.resolve(__dirname, '../../..');

const inTsx = (source: string) =>
  findBareWordViolations(extractUserFacingText('Example.tsx', source)).map((finding) => finding.phrase);

const asCopy = (copy: string) => inTsx(`export const copy = ${JSON.stringify(copy)};`);

describe('banned single words', () => {
  it.each([
    'Invest in Bitcoin with your circle.',
    'A smart investment for your family.',
    'Our investors love it.',
    'Earn more every month.',
    'Members earned 5% last year.',
    'Steady returns, every cycle.',
    'Great returns on your savings.',
    'Get a better return.',
  ])('flags %p', (copy) => {
    expect(asCopy(copy)).toHaveLength(1);
  });

  it.each([
    'Learn how a njangi works.',
    'Your returned deposit is in your wallet.',
    'Return to the dashboard and open the invitation again.',
    'Are you sure you want to return the security deposit?',
    'This stops the circle and returns tracked funds to their recorded owners.',
    'Deposit returns and member removals are handled in the Members table.',
    'No paid security deposits are available to return.',
    'Manage deposits above for a batch return.',
    'They repay it in return for organising the group.',
    'Members earn in dirhams or riyals.',
    'It is the group that knows what you earn.',
    'It never holds your money, never offers an investment, and never pays a return.',
    'It is not financial advice, custody, or a guarantee of returns.',
  ])('leaves the ordinary sense alone: %p', (copy) => {
    expect(asCopy(copy)).toEqual([]);
  });

  // The owner's rule: nothing may read as Njangi holding members' money.
  it.each([
    'USDC-only treasury',
    'Treasury Health',
    'Your deposit sits in the circle vault.',
    'Two vaults, one per coin.',
  ])('flags custody wording: %p', (copy) => {
    expect(asCopy(copy)).toHaveLength(1);
  });

  it.each([
    'House of Commons Treasury Committee, Thirteenth Report of Session 2006-07',
    "OFAC, part of the U.S. Department of the Treasury, publishes the list.",
    'The list is downloaded from treasury.gov every week.',
    'HM Treasury publishes the UK list.',
  ])('allows the proper nouns of citations and sanctions copy: %p', (copy) => {
    expect(asCopy(copy)).toEqual([]);
  });

  it('allows a return label whose object is interpolated', () => {
    expect(inTsx('const label = `Return ${count} Deposits`;')).toEqual([]);
    expect(inTsx('const el = <button>Return {count} deposits</button>;')).toEqual([]);
  });

  it('reads JSX text and attributes as copy', () => {
    expect(inTsx('const el = <p>Watch your <b>savings</b> earn more.</p>;')).toHaveLength(1);
    expect(inTsx('const el = <input placeholder="Invest now" />;')).toHaveLength(1);
  });

  it('never reads code, comments, imports, types, keys or logging as copy', () => {
    const source = `
      import invest from './invest';
      // This returns null when nothing earns interest.
      /** Returns the investment amount. */
      type Kind = 'investment' | 'returns';
      const map = { 'earn.key': 'Save together' };
      export function f(x: number) {
        console.log('returns the investment', x);
        if (x > 1) return x;
        return 0;
      }
      const shader = \`float hash(vec2 p) { return fract(sin(p.x)); }\`;
    `;
    expect(inTsx(source)).toEqual([]);
  });

  it('reads markdown prose without its code', () => {
    const md = ['Members earn more here.', '', '```tsx', 'return (<App />);', '```', 'Use `return x` in code.'].join('\n');
    const findings = findBareWordViolations(extractMarkdownText(md));
    expect(findings).toEqual([expect.objectContaining({ line: 1 })]);
  });

  it('reports the line of a match inside multi-line copy', () => {
    const findings = findBareWordViolations(
      extractUserFacingText('Example.tsx', 'const el = (\n  <p>\n    Save together.\n    Invest wisely.\n  </p>\n);'),
    );
    expect(findings).toEqual([expect.objectContaining({ line: 4 })]);
  });
});

describe('check-marketing-copy.mjs', () => {
  // Runs the real script against a scratch tree (it takes the root as its
  // first argument) so the CI behaviour itself is pinned: app copy fails the
  // build, the served legal documents only warn.
  function run(files: Record<string, string>): { status: number | null; output: string } {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'check-copy-'));
    try {
      for (const [rel, content] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        writeFileSync(path.join(dir, rel), content);
      }
      const result = spawnSync(process.execPath, [path.join(repoRoot, 'scripts/check-marketing-copy.mjs'), dir], {
        encoding: 'utf8',
      });
      return { status: result.status, output: `${result.stdout}${result.stderr}` };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('fails the build on a banned word in app copy', () => {
    const { status, output } = run({ 'src/pages/promo.tsx': 'export const c = <p>Invest in Bitcoin.</p>;' });
    expect(status).toBe(1);
    expect(output).toContain('src/pages/promo.tsx:1');
    expect(output).toContain('investment vocabulary');
  });

  it('only warns about the served legal documents', () => {
    const { status, output } = run({
      'src/pages/ok.tsx': 'export const c = <p>Save together.</p>;',
      'docs/legal-drafts/terms-of-service.en.md': '# Terms\n\nMembers can earn more.\n',
      'docs/legal-drafts/ACCEPTANCE-GATE-SPEC.md': 'Members can earn more.\n',
    });
    expect(status).toBe(0);
    expect(output).toContain('report-only: 1 finding(s) in docs/legal-drafts');
    expect(output).toContain('docs/legal-drafts/terms-of-service.en.md:3');
    expect(output).not.toContain('ACCEPTANCE-GATE-SPEC');
    expect(output).toContain('0 violations');
  });
});

describe('the scanned app copy', () => {
  it('finds the one reviewed educational use in the regulators article, so the guard is live', () => {
    const rel = 'src/pages/blog/how-regulators-treat-savings-circles.tsx';
    const source = readFileSync(path.join(repoRoot, rel), 'utf8');
    const phrases = findBareWordViolations(extractUserFacingText(rel, source)).map((f) => f.phrase);
    expect(phrases).toEqual([expect.stringContaining('described as an investment')]);
  });
});
