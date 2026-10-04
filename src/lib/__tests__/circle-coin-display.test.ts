/**
 * The join card printed every amount as "X SUI", so a USDC circle's
 * invitation quoted a coin its members never pay. It now shows the circle's
 * own coin, from its `auto_swap_enabled` flag, and no coin at all when the
 * flag could not be read.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { circleCoinFromConfig, formatUsdcFromCents } from '@/lib/circle-coin-display';

describe('circleCoinFromConfig', () => {
  it('maps SUI mode and USDC mode', () => {
    expect(circleCoinFromConfig(true)).toBe('SUI');
    expect(circleCoinFromConfig(false)).toBe('USDC');
    expect(circleCoinFromConfig('false')).toBe('USDC');
  });

  it('is null, never a guessed coin, when the flag was not read', () => {
    for (const unread of [undefined, null, '', 0, 1, 'yes']) {
      expect(circleCoinFromConfig(unread)).toBeNull();
    }
  });
});

describe('formatUsdcFromCents', () => {
  it('formats the USD cents a USDC circle charges', () => {
    expect(formatUsdcFromCents(30)).toBe('0.30 USDC');
    expect(formatUsdcFromCents('2500')).toBe('25.00 USDC');
    expect(formatUsdcFromCents(123456)).toBe('1,234.56 USDC');
    expect(formatUsdcFromCents(0)).toBe('0.00 USDC');
  });

  it('is null for anything that is not cents', () => {
    for (const bad of [undefined, null, -1, 1.5, 'abc', '12.5', Number.NaN]) {
      expect(formatUsdcFromCents(bad)).toBeNull();
    }
  });
});

describe('join page', () => {
  it('shows the circle’s coin instead of a fixed SUI line', () => {
    const source = readFileSync(join(process.cwd(), 'src/pages/circle/[id]/join/index.tsx'), 'utf8');
    // The old JSX text node printed "{formattedSui} SUI" for every circle;
    // the SUI line is now one branch of the coin choice.
    expect(source).not.toMatch(/[^$]\{formattedSui\} SUI/);
    expect(source).toContain("coin === 'USDC' ? usdc : coin === 'SUI' ? `${formattedSui} SUI` : null");
    expect(source).toContain('circleCoinFromConfig(');
  });
});

describe('create circle', () => {
  it('quotes a rotational circle in USDC, the coin a new circle runs in', () => {
    const source = readFileSync(join(process.cwd(), 'src/pages/create-circle.tsx'), 'utf8');
    expect(source).not.toContain('converted to SUI at current price');
    expect(source).not.toContain('SuiAmountDisplay');
    expect(source).toContain('(≈ {usdcFor(usd)} USDC)');
  });
});
