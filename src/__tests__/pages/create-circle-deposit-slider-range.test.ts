/**
 * Create circle: the security-deposit slider's upper end (NJA-2599).
 *
 * The slider under "More settings" caps each currency at a fixed figure
 * (getCurrencyMaximum in src/pages/create-circle.tsx: USD 1000, GBP 800,
 * XAF 600,000, ...), while the "Custom Amount" input beside it has no
 * maximum. None of those figures is derived from the circle: a contribution
 * above the cap cannot have its deposit raised past it by the slider, and a
 * USD 20 contribution gets a USD 1,000 range around a USD 10 default. The
 * slider's range must follow the circle's own contribution amount; the
 * minimum stays at half a contribution (deriveSecurityDeposit).
 *
 * Source-text assertions because jest runs `testEnvironment: 'node'` with
 * `testMatch: ['**\/__tests__\/**\/*.test.ts']`: no jsdom and `.tsx` is not
 * matched. Same technique as src/lib/__tests__/copy-guards.test.ts.
 */
import { readFileSync } from 'fs';
import path from 'path';

/** Comments explain the rule; they must not trip it. */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const page = stripComments(
  readFileSync(path.resolve(__dirname, '../../pages/create-circle.tsx'), 'utf8'),
);

/** The <Slider.Root> whose value is the security deposit. */
const depositSlider = (page.match(/<Slider\.Root[\s\S]*?<\/Slider\.Root>/g) ?? []).find(
  (block) => block.includes('securityDepositLocal'),
);

describe('create circle: security-deposit slider range (NJA-2599)', () => {
  it('keeps no fixed per-currency maximum', () => {
    // The per-currency map and its lookup.
    expect(page).not.toMatch(/getCurrencyMaximum/);

    // The figures themselves, as currency entries. The increment map keeps
    // its own entries (USD: 20, XAF: 12000, ...); these patterns do not
    // match those.
    for (const entry of [
      /\bUSD:\s*1000\b/,
      /\bEUR:\s*1000\b/,
      /\bGBP:\s*800\b/,
      /\bCAD:\s*1300\b/,
      /\bNGN:\s*500000\b/,
      /\bZAR:\s*15000\b/,
      /\bGHS:\s*12500\b/,
      /\bKES:\s*125000\b/,
      /\bEGP:\s*25000\b/,
      /\bMAD:\s*10000\b/,
      /\bXAF:\s*600000\b/,
    ]) {
      expect(page).not.toMatch(entry);
    }
  });

  it("derives the slider's upper end from the contribution amount", () => {
    // The minimum is untouched: the deposit still defaults to half a
    // contribution.
    expect(page).toMatch(/deriveSecurityDeposit\(/);

    expect(depositSlider).toBeDefined();
    const maxExpr = /\bmax=\{([^}]*)\}/.exec(depositSlider ?? '')?.[1]?.trim() ?? '';
    expect(maxExpr).not.toBe('');

    // Not keyed on the currency alone.
    expect(maxExpr).not.toMatch(/getCurrencyMaximum/);

    // Either the expression reads the contribution itself, or it names a
    // helper or const whose definition does. Which rule (2x, 3x, ...) is
    // the founder's call at approval; that it follows the contribution is
    // not.
    const readsContribution = (text: string): boolean => /contributionAmountLocal/.test(text);
    let follows = readsContribution(maxExpr);
    if (!follows && /^[A-Za-z_$][\w$]*$/.test(maxExpr)) {
      const definition =
        new RegExp(`(?:const|let|function)\\s+${maxExpr}\\b[\\s\\S]{0,600}`).exec(page)?.[0] ?? '';
      follows = readsContribution(definition);
    }
    expect(follows).toBe(true);
  });
});
