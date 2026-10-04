// circle-coin-display.ts — which coin a circle's members pay in, for pages
// that show a circle's amounts before anyone has joined (the join card).
//
// A circle settles in SUI or in the network's USDC, decided by its
// `auto_swap_enabled` config flag (src/lib/circle-settlement.ts). New
// circles start in USDC mode. The join card used to print every amount as
// "X SUI", so a USDC circle's invitation quoted a coin its members never pay.

export type CircleCoin = 'SUI' | 'USDC';

/**
 * The circle's coin from its config flag: `true` is SUI mode, `false` USDC
 * mode. Anything else (the config could not be read) is null, and the page
 * shows no coin amount rather than guess one.
 */
export function circleCoinFromConfig(autoSwapEnabled: unknown): CircleCoin | null {
  if (autoSwapEnabled === true || autoSwapEnabled === 'true') return 'SUI';
  if (autoSwapEnabled === false || autoSwapEnabled === 'false') return 'USDC';
  return null;
}

/**
 * A USDC amount from the circle's stored USD cents, the value the contract
 * charges a USDC circle (cents × 10^4 base units): 30 → "0.30 USDC".
 * Null when the cents are not a non-negative integer.
 */
export function formatUsdcFromCents(cents: unknown): string | null {
  const value = typeof cents === 'string' && /^\d+$/.test(cents.trim()) ? Number(cents) : cents;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return null;
  const whole = Math.floor(value / 100);
  const fraction = String(value % 100).padStart(2, '0');
  return `${whole.toLocaleString('en-US')}.${fraction} USDC`;
}
