import {
  MAX_MEMBERS,
  MIN_MEMBERS,
  QUICK_START_MEMBERS,
  buildWhatsAppShareUrl,
  clampMembers,
  defaultCycleDay,
  deriveSecurityDeposit,
} from '@/lib/circle-quick-start';

describe('deriveSecurityDeposit', () => {
  it('is half of the contribution', () => {
    expect(deriveSecurityDeposit(100)).toBe(50);
    expect(deriveSecurityDeposit(20)).toBe(10);
    expect(deriveSecurityDeposit(0.1)).toBe(0.05);
  });

  it('rounds half-cents UP so the contract minimum always holds', () => {
    expect(deriveSecurityDeposit(0.01)).toBe(0.01);
    expect(deriveSecurityDeposit(33.33)).toBe(16.67);
    expect(deriveSecurityDeposit(0.03)).toBe(0.02);
  });

  it('never goes below the contract rule (integer cents, floor division)', () => {
    // njangi_circles::create_circle: security_deposit_usd >= contribution_usd / 2
    for (let cents = 1; cents <= 5000; cents += 7) {
      const contribution = cents / 100;
      const depositCents = Math.floor(deriveSecurityDeposit(contribution) * 100 + 1e-9);
      expect(depositCents).toBeGreaterThanOrEqual(Math.floor(cents / 2));
      expect(depositCents).toBeGreaterThan(0);
    }
  });

  it('is zero for nothing, negatives and garbage', () => {
    expect(deriveSecurityDeposit(0)).toBe(0);
    expect(deriveSecurityDeposit(-5)).toBe(0);
    expect(deriveSecurityDeposit(Number.NaN)).toBe(0);
    expect(deriveSecurityDeposit(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('clampMembers', () => {
  it('keeps values inside the contract range', () => {
    expect(clampMembers(5)).toBe(5);
    expect(clampMembers(1)).toBe(MIN_MEMBERS);
    expect(clampMembers(99)).toBe(MAX_MEMBERS);
    expect(clampMembers(7.9)).toBe(7);
  });

  it('falls back to the quick-start default for garbage', () => {
    expect(clampMembers(Number.NaN)).toBe(QUICK_START_MEMBERS);
  });

  it('quick-start default itself is a legal member count', () => {
    expect(QUICK_START_MEMBERS).toBeGreaterThanOrEqual(MIN_MEMBERS);
    expect(QUICK_START_MEMBERS).toBeLessThanOrEqual(MAX_MEMBERS);
  });
});

describe('defaultCycleDay', () => {
  it('uses a weekday for weekly cadences and the 1st otherwise', () => {
    expect(defaultCycleDay('weekly')).toBe('monday');
    expect(defaultCycleDay('bi-weekly')).toBe('monday');
    expect(defaultCycleDay('monthly')).toBe(1);
    expect(defaultCycleDay('quarterly')).toBe(1);
  });
});

describe('buildWhatsAppShareUrl', () => {
  it('encodes the message for wa.me', () => {
    const url = buildWhatsAppShareUrl('Join "Mama Grace" https://x.test/circle/0xa/join');
    expect(url.startsWith('https://wa.me/?text=')).toBe(true);
    expect(url).not.toContain(' ');
    expect(decodeURIComponent(url.slice('https://wa.me/?text='.length))).toBe(
      'Join "Mama Grace" https://x.test/circle/0xa/join',
    );
  });
});
