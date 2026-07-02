/**
 * gas-sponsorship.test.ts — pure policy for Enoki gas sponsorship.
 *
 * Covers the decision core (assessSponsorship) and the move-target
 * allowlist. Cap enforcement (shouldSponsor) and the chain/entitlement
 * resolver live behind I/O and are exercised via their own integration
 * paths; here we lock the security-critical pure rules:
 *   - disabled flag wins
 *   - SUI-value-from-gas-coin is never sponsored (would pay from sponsor)
 *   - non-premium admin is never sponsored
 *   - a missing package id yields an empty (safe) allowlist
 */

import {
  assessSponsorship,
  allowedMoveCallTargets,
  SPONSORABLE_MOVE_FUNCTIONS,
} from '../gas-sponsorship';

const PKG = '0xabc';

describe('allowedMoveCallTargets', () => {
  it('returns [] when package id is missing (fail safe — decline to sponsor)', () => {
    expect(allowedMoveCallTargets(null)).toEqual([]);
    expect(allowedMoveCallTargets('')).toEqual([]);
    expect(allowedMoveCallTargets('   ')).toEqual([]);
  });

  it('fully-qualifies every sponsorable function against the package id', () => {
    const targets = allowedMoveCallTargets(PKG);
    expect(targets).toHaveLength(SPONSORABLE_MOVE_FUNCTIONS.length);
    expect(targets).toContain(`${PKG}::njangi_cycle_escrow::contribute`);
    expect(targets).toContain(`${PKG}::njangi_circles::member_deposit_security_deposit`);
  });

  it('never allowlists a swap/Cetus target (sponsored swaps widen abuse surface)', () => {
    const targets = allowedMoveCallTargets(PKG).join('\n').toLowerCase();
    expect(targets).not.toContain('cetus');
    expect(targets).not.toContain('swap');
  });
});

describe('assessSponsorship', () => {
  const base = { adminIsPremium: true, usesGasCoinForValue: false, packageId: PKG };

  afterEach(() => {
    delete process.env.GAS_SPONSORSHIP_ENABLED;
  });

  it('declines when the feature flag is off, regardless of everything else', () => {
    delete process.env.GAS_SPONSORSHIP_ENABLED;
    expect(assessSponsorship(base)).toEqual({ sponsor: false, reason: 'disabled' });
  });

  it('declines SUI value drawn from the gas coin (would pay contribution from sponsor)', () => {
    process.env.GAS_SPONSORSHIP_ENABLED = 'true';
    expect(assessSponsorship({ ...base, usesGasCoinForValue: true })).toEqual({
      sponsor: false,
      reason: 'sui_value_from_gas_coin',
    });
  });

  it('declines when the circle admin is not premium', () => {
    process.env.GAS_SPONSORSHIP_ENABLED = 'true';
    expect(assessSponsorship({ ...base, adminIsPremium: false })).toEqual({
      sponsor: false,
      reason: 'admin_not_premium',
    });
  });

  it('declines when no package id is available for the allowlist', () => {
    process.env.GAS_SPONSORSHIP_ENABLED = 'true';
    expect(assessSponsorship({ ...base, packageId: null })).toEqual({
      sponsor: false,
      reason: 'no_package_id',
    });
  });

  it('sponsors when enabled + premium admin + owned-coin value + package id', () => {
    process.env.GAS_SPONSORSHIP_ENABLED = 'true';
    expect(assessSponsorship(base)).toEqual({ sponsor: true, reason: 'eligible' });
  });
});
