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
 *   - every transaction the Collect button can build is fully allowlisted
 */

// The escrow builders resolve the package id when they are called.
const TESTNET_PKG = '0x' + '9'.repeat(64);
process.env.NEXT_PUBLIC_TESTNET_PACKAGE_ID = TESTNET_PKG;

import { Transaction } from '@mysten/sui/transactions';
import {
  assessSponsorship,
  allowedMoveCallTargets,
  SPONSORABLE_MOVE_FUNCTIONS,
} from '../gas-sponsorship';
import {
  buildAdvanceCircleAfterClaimTx,
  buildFinalizeAndRedeemTx,
  buildFinalizeAndRedeemWithAttestationTx,
  buildRedeemClaimTx,
} from '@/services/cycle-escrow-service';

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

describe('the Collect payout transactions are sponsorable end to end', () => {
  // /api/sponsor/prepare refuses a kind if any one MoveCall falls outside the
  // allowlist, and Enoki does the same, so every route the Collect button can
  // build must be covered whole, including the chained rotation advance.
  // Since #81 that includes redeeming a Claim<T> someone else's finalize
  // minted. The collect path signs with the member's own gas today; this
  // keeps it sponsorable if it is ever wired through /api/sponsor.
  const ADDR = (b: string) => '0x' + b.repeat(64);
  const BASE = {
    network: 'testnet' as const,
    coinType: `${ADDR('c')}::usdc::USDC`,
    escrowId: ADDR('a'),
    circleId: ADDR('d'),
  };

  /** Same reading of a transaction as assertKindIsSponsorable. */
  const moveCallTargets = (build: (txb: Transaction) => void): string[] => {
    const txb = new Transaction();
    build(txb);
    return txb.getData().commands.flatMap((command) =>
      'MoveCall' in command && command.MoveCall
        ? [`${command.MoveCall.package}::${command.MoveCall.module}::${command.MoveCall.function}`]
        : [],
    );
  };

  it.each([
    ['collect (one step)', () => buildFinalizeAndRedeemTx(BASE), ['finalize_and_redeem', 'advance_circle_after_claim']],
    [
      'collect (one step, verification-gated)',
      () =>
        buildFinalizeAndRedeemWithAttestationTx({
          ...BASE,
          attestationObjectId: ADDR('b'),
          complianceConfigId: ADDR('e'),
        }),
      ['finalize_and_redeem_with_attestation', 'advance_circle_after_claim'],
    ],
    [
      'collect a round someone else finalized',
      () => buildRedeemClaimTx({ ...BASE, claimId: ADDR('f') }),
      ['recipient', 'redeem_claim', 'advance_circle_after_claim'],
    ],
    ['advance after an earlier collect', () => buildAdvanceCircleAfterClaimTx(BASE), ['advance_circle_after_claim']],
  ])('%s', (_route, makeBuild, expectedFunctions) => {
    const targets = moveCallTargets(makeBuild());
    // Pins the route's shape, so a builder change cannot make the check vacuous.
    expect(targets.map((target) => target.split('::')[2])).toEqual(expectedFunctions);
    const allowed = new Set(allowedMoveCallTargets(TESTNET_PKG));
    expect(targets.filter((target) => !allowed.has(target))).toEqual([]);
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
