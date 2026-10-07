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
 *   - every round transaction the panel sends to the sponsor is fully allowlisted
 */

// The escrow builders resolve the package id when they are called.
const TESTNET_PKG = '0x' + '9'.repeat(64);
process.env.NEXT_PUBLIC_TESTNET_PACKAGE_ID = TESTNET_PKG;

import type { SuiClient } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import {
  assessSponsorship,
  allowedMoveCallTargets,
  SPONSORABLE_MOVE_FUNCTIONS,
} from '../gas-sponsorship';
import {
  buildAdvanceCircleAfterClaimTx,
  buildCancelUnfinalizedEscrowForRecoveryTx,
  buildCancelUnfinalizedEscrowTx,
  buildContributeWithAutoCoinTx,
  buildFinalizeAndRedeemTx,
  buildFinalizeAndRedeemWithAttestationTx,
  buildOpenCycleTx,
  buildRedeemClaimTx,
  buildRefundExpiredClaimTx,
} from '@/services/cycle-escrow-service';
import {
  buildAdminRemoveMemberTx,
  buildExecuteRecoveryTx,
  buildProposeEmergencyStopTx,
  buildTriggerAutoReleaseTx,
  buildVoteEmergencyStopTx,
} from '@/lib/zklogin-tx-builders';
import { buildAdminRemoveMemberAssetTx } from '@/lib/v11-circle-tx';

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

describe('every round transaction the panel asks about is sponsorable end to end', () => {
  // /api/sponsor/prepare refuses a kind if any one MoveCall falls outside the
  // allowlist, and Enoki does the same, so every route the round panel sends
  // to the sponsor must be covered whole, including the chained rotation
  // advance. Since #81 that includes redeeming a Claim<T> someone else's
  // finalize minted. A route that falls out of the allowlist does not fail:
  // it quietly goes back to costing the member their own gas.
  const ADDR = (b: string) => '0x' + b.repeat(64);
  const BASE = {
    network: 'testnet' as const,
    coinType: `${ADDR('c')}::usdc::USDC`,
    escrowId: ADDR('a'),
    circleId: ADDR('d'),
  };

  // Enough of a client for the pay builder's coin lookup.
  const stubClient = {
    getCoins: async () => ({
      data: [{ coinObjectId: ADDR('6'), balance: '900000', version: '1', digest: '1'.repeat(32) }],
      hasNextPage: false,
      nextCursor: null,
    }),
  } as unknown as SuiClient;

  /** Same reading of a transaction as judgeSponsorableKind. */
  const moveCallTargets = async (
    build: (txb: Transaction, client: SuiClient) => void | Promise<void>,
  ): Promise<string[]> => {
    const txb = new Transaction();
    await build(txb, stubClient);
    return txb.getData().commands.flatMap((command) =>
      'MoveCall' in command && command.MoveCall
        ? [`${command.MoveCall.package}::${command.MoveCall.module}::${command.MoveCall.function}`]
        : [],
    );
  };

  const payShare = () =>
    buildContributeWithAutoCoinTx({
      network: 'testnet',
      coinType: BASE.coinType,
      escrowId: BASE.escrowId,
      contributionAmount: 100_000n,
      ownerAddress: ADDR('b'),
    });
  const openRound = () =>
    buildOpenCycleTx({
      network: 'testnet',
      circleId: BASE.circleId,
      coinType: BASE.coinType,
      stableDecimals: 6,
    });
  const openSuiRound = () =>
    buildOpenCycleTx({ network: 'testnet', circleId: BASE.circleId, coinType: '0x2::sui::SUI' });
  // The open the panel builds when the previous round's escrow was refunded.
  const reopenAfterRefund = () =>
    buildOpenCycleTx({
      network: 'testnet',
      circleId: BASE.circleId,
      coinType: BASE.coinType,
      stableDecimals: 6,
      releaseEscrowId: BASE.escrowId,
      releaseCoinType: BASE.coinType,
    });

  afterEach(() => {
    delete process.env.NEXT_PUBLIC_ESCROW_TIMED_ENTRIES_ENABLED;
    delete process.env.NEXT_PUBLIC_ESCROW_ROUND_GUARD_ENABLED;
  });

  it.each([
    ['pay a USDC share', payShare, ['contribute']],
    ['open a USDC round', openRound, ['open_cycle_stable']],
    ['open a SUI round', openSuiRound, ['open_cycle']],
    ['send the contributions back after the claim window', () => buildRefundExpiredClaimTx(BASE), ['refund_expired_claim']],
    // The stalled-round cancel, both entry points: a member holding no SUI
    // must be able to get everyone's shares back once the grace has passed,
    // and at once in a circle whose recovery vote stopped it.
    ['cancel a stalled round', () => buildCancelUnfinalizedEscrowTx(BASE), ['cancel_unfinalized_escrow']],
    [
      'cancel a stalled round in a stopped circle',
      () => buildCancelUnfinalizedEscrowForRecoveryTx(BASE),
      ['cancel_unfinalized_escrow_for_recovery'],
    ],
  ])('%s', async (_route, makeBuild, expectedFunctions) => {
    const targets = await moveCallTargets(makeBuild());
    expect(targets.map((target) => target.split('::')[2])).toEqual(expectedFunctions);
    const allowed = new Set(allowedMoveCallTargets(TESTNET_PKG));
    expect(targets.filter((target) => !allowed.has(target))).toEqual([]);
  });

  it('re-open a round whose escrow was refunded (release chained ahead of the open)', async () => {
    process.env.NEXT_PUBLIC_ESCROW_ROUND_GUARD_ENABLED = 'true';
    const targets = await moveCallTargets(reopenAfterRefund());
    expect(targets.map((target) => target.split('::')[2])).toEqual([
      'release_open_round',
      'open_cycle_stable',
    ]);
    const allowed = new Set(allowedMoveCallTargets(TESTNET_PKG));
    expect(targets.filter((target) => !allowed.has(target))).toEqual([]);
  });

  it('covers the timed and indexed entries production builds', async () => {
    process.env.NEXT_PUBLIC_ESCROW_TIMED_ENTRIES_ENABLED = 'true';
    const targets = [
      ...(await moveCallTargets(payShare())),
      ...(await moveCallTargets(openRound())),
      ...(await moveCallTargets(openSuiRound())),
    ];
    expect(targets.map((target) => target.split('::')[2])).toEqual([
      'contribute_timed',
      'open_cycle_stable_indexed',
      'open_cycle_indexed',
    ]);
    const allowed = new Set(allowedMoveCallTargets(TESTNET_PKG));
    expect(targets.filter((target) => !allowed.has(target))).toEqual([]);
  });

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
  ])('%s', async (_route, makeBuild, expectedFunctions) => {
    const targets = await moveCallTargets(makeBuild());
    // Pins the route's shape, so a builder change cannot make the check vacuous.
    expect(targets.map((target) => target.split('::')[2])).toEqual(expectedFunctions);
    const allowed = new Set(allowedMoveCallTargets(TESTNET_PKG));
    expect(targets.filter((target) => !allowed.has(target))).toEqual([]);
  });
});

describe('recovery and deposit-return transactions are sponsorable end to end', () => {
  // How deposits come back to members: the emergency stop the admin proposes
  // and the members vote on, the recovery it unlocks, the auto-release after
  // the admin goes quiet, and the admin's "Return Deposit & Remove Member".
  // A member holding no SUI must be able to get theirs back.
  const ADDR = (b: string) => '0x' + b.repeat(64);
  const IDS = { packageId: TESTNET_PKG, circleId: ADDR('d') };
  const USDC_TYPE = `${ADDR('c')}::usdc::USDC`;
  const targetsOf = (tx: Transaction): string[] =>
    tx.getData().commands.flatMap((command) =>
      'MoveCall' in command && command.MoveCall
        ? [`${command.MoveCall.package}::${command.MoveCall.module}::${command.MoveCall.function}`]
        : [],
    );

  it.each([
    ['propose an emergency stop', () => buildProposeEmergencyStopTx(IDS), 'propose_emergency_stop'],
    ['vote on it', () => buildVoteEmergencyStopTx({ ...IDS, yesVote: true }), 'vote_emergency_stop'],
    [
      'execute the recovery it unlocks',
      () => buildExecuteRecoveryTx({ ...IDS, walletId: ADDR('e'), stablecoinType: USDC_TYPE }),
      'execute_recovery',
    ],
    [
      'release after the admin goes quiet',
      () => buildTriggerAutoReleaseTx({ ...IDS, walletId: ADDR('e'), stablecoinType: USDC_TYPE }),
      'trigger_auto_release',
    ],
    [
      'return a deposit and remove the member',
      () =>
        buildAdminRemoveMemberAssetTx({
          ...IDS,
          walletId: ADDR('e'),
          coinType: USDC_TYPE,
          memberAddress: ADDR('b'),
        }),
      'admin_remove_member_asset',
    ],
  ])('%s', (_route, makeTx, expectedFunction) => {
    const targets = targetsOf(makeTx());
    expect(targets.map((target) => target.split('::')[2])).toEqual([expectedFunction]);
    const allowed = new Set(allowedMoveCallTargets(TESTNET_PKG));
    expect(targets.filter((target) => !allowed.has(target))).toEqual([]);
  });

  it('leaves the pre-v11 member removal off the list', () => {
    const targets = targetsOf(
      buildAdminRemoveMemberTx({ ...IDS, memberAddress: ADDR('b'), walletId: ADDR('e') }),
    );
    expect(targets.map((target) => target.split('::')[2])).toEqual(['admin_remove_member']);
    expect(allowedMoveCallTargets(TESTNET_PKG)).not.toContain(targets[0]);
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
