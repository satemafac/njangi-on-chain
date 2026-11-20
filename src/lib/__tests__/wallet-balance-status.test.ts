import { afterBalanceRead, isWalletBalanceKnown } from '../wallet-balance-status';

describe('afterBalanceRead', () => {
  it.each(['loading', 'ok', 'stale', 'unavailable'] as const)('a successful read from %s is ok', (prev) => {
    expect(afterBalanceRead(prev, true)).toBe('ok');
  });

  // The 2026-10-15 bug: a failed first read left the initial zeros on screen.
  it('a failed first read is unavailable, never a zero balance', () => {
    expect(afterBalanceRead('loading', false)).toBe('unavailable');
    expect(afterBalanceRead('unavailable', false)).toBe('unavailable');
  });

  it('a failed refresh keeps the earlier reading, marked stale', () => {
    expect(afterBalanceRead('ok', false)).toBe('stale');
    expect(afterBalanceRead('stale', false)).toBe('stale');
  });
});

describe('isWalletBalanceKnown', () => {
  it('trusts only statuses backed by a read', () => {
    expect(isWalletBalanceKnown('ok')).toBe(true);
    expect(isWalletBalanceKnown('stale')).toBe(true);
    expect(isWalletBalanceKnown('loading')).toBe(false);
    expect(isWalletBalanceKnown('unavailable')).toBe(false);
  });
});
