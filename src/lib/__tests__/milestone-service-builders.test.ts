// Tx-builder assertions for milestone-service (mirrors
// zklogin-tx-builders.test.ts: serialize the PTB and check targets,
// type arguments, and pure inputs).

jest.mock('@/services/network-config', () => ({
  getPackageIdForNetwork: () => '0xabc',
}));

import { Transaction } from '@mysten/sui/transactions';
import {
  buildAddMonetaryMilestoneTx,
  buildAddTimeMilestoneTx,
  buildCompleteMilestoneTx,
  buildCreateCircleMilestonesTx,
  buildRecordCycleProgressTx,
  buildSubmitMilestoneProofTx,
  buildVerifyMilestoneTx,
  type BuildTransactionFn,
} from '@/services/milestone-service';

const PKG =
  '0x0000000000000000000000000000000000000000000000000000000000000abc';
const SUI = '0x2::sui::SUI';
const base = { network: 'testnet' as const, coinType: SUI };

interface SerializedTx {
  transactions: Array<{
    target: string;
    typeArguments?: string[];
    arguments: unknown[];
  }>;
  inputs: Array<{ value?: { Pure?: number[] } }>;
}

function serialize(build: BuildTransactionFn): SerializedTx {
  const txb = new Transaction();
  build(txb);
  return JSON.parse(txb.serialize()) as SerializedTx;
}

function pureInputs(serialized: SerializedTx): number[][] {
  return serialized.inputs
    .map((input) => input.value?.Pure)
    .filter((bytes): bytes is number[] => Array.isArray(bytes));
}

describe('milestone-service tx builders', () => {
  it('builds create_circle_milestones with the circle and coin type', () => {
    const serialized = serialize(
      buildCreateCircleMilestonesTx({ ...base, circleId: '0xc1' }),
    );
    expect(serialized.transactions).toHaveLength(1);
    expect(serialized.transactions[0].target).toBe(
      `${PKG}::njangi_milestones::create_circle_milestones`,
    );
    expect(serialized.transactions[0].typeArguments).toEqual([SUI]);
    expect(serialized.transactions[0].arguments).toHaveLength(1);
  });

  it('builds add_monetary_milestone with target, description bytes, and flag', () => {
    const serialized = serialize(
      buildAddMonetaryMilestoneTx({
        ...base,
        milestonesId: '0xfeed',
        circleId: '0xc1',
        targetAmount: 2_000_000_000n,
        description: 'Two cycles in',
        requiresVerification: true,
      }),
    );
    expect(serialized.transactions[0].target).toBe(
      `${PKG}::njangi_milestones::add_monetary_milestone`,
    );
    expect(serialized.transactions[0].typeArguments).toEqual([SUI]);
    // tracker, circle, target, description, requires_verification
    expect(serialized.transactions[0].arguments).toHaveLength(5);

    const pure = pureInputs(serialized);
    expect(pure).toHaveLength(3);
    // u64 target, little-endian: 2_000_000_000 = 0x77359400
    expect(pure[0]).toEqual([0, 148, 53, 119, 0, 0, 0, 0]);
    // vector<u8> description: ULEB length prefix + utf8 bytes
    expect(pure[1]).toEqual([
      13,
      ...Array.from(new TextEncoder().encode('Two cycles in')),
    ]);
    // bool true
    expect(pure[2]).toEqual([1]);
  });

  it('builds add_time_milestone with the clock as the final argument', () => {
    const serialized = serialize(
      buildAddTimeMilestoneTx({
        ...base,
        milestonesId: '0xfeed',
        circleId: '0xc1',
        targetTimestampMs: 1_800_000_000_000,
        description: '30 days strong',
        requiresVerification: false,
      }),
    );
    expect(serialized.transactions[0].target).toBe(
      `${PKG}::njangi_milestones::add_time_milestone`,
    );
    // tracker, circle, target_ms, description, flag, clock
    expect(serialized.transactions[0].arguments).toHaveLength(6);
    const pure = pureInputs(serialized);
    expect(pure).toHaveLength(3);
    // bool false
    expect(pure[2]).toEqual([0]);
  });

  it('builds record_cycle_progress against the tracker and a settled escrow', () => {
    const serialized = serialize(
      buildRecordCycleProgressTx({
        ...base,
        milestonesId: '0xfeed',
        escrowId: '0xe5c',
      }),
    );
    expect(serialized.transactions[0].target).toBe(
      `${PKG}::njangi_milestones::record_cycle_progress`,
    );
    expect(serialized.transactions[0].typeArguments).toEqual([SUI]);
    expect(serialized.transactions[0].arguments).toHaveLength(2);
    expect(pureInputs(serialized)).toHaveLength(0);
  });

  it('builds complete_milestone with the index and the shared clock', () => {
    const serialized = serialize(
      buildCompleteMilestoneTx({
        ...base,
        milestonesId: '0xfeed',
        milestoneIndex: 3,
      }),
    );
    expect(serialized.transactions[0].target).toBe(
      `${PKG}::njangi_milestones::complete_milestone`,
    );
    // tracker, index, clock
    expect(serialized.transactions[0].arguments).toHaveLength(3);
    const pure = pureInputs(serialized);
    expect(pure).toHaveLength(1);
    expect(pure[0]).toEqual([3, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('builds submit_milestone_proof with utf8-encoded proof bytes', () => {
    const serialized = serialize(
      buildSubmitMilestoneProofTx({
        ...base,
        milestonesId: '0xfeed',
        circleId: '0xc1',
        milestoneIndex: 0,
        proof: 'walrus-blob-hash',
      }),
    );
    expect(serialized.transactions[0].target).toBe(
      `${PKG}::njangi_milestones::submit_milestone_proof`,
    );
    // tracker, circle, index, proof
    expect(serialized.transactions[0].arguments).toHaveLength(4);
    const pure = pureInputs(serialized);
    expect(pure).toHaveLength(2);
    expect(pure[1]).toEqual([
      16,
      ...Array.from(new TextEncoder().encode('walrus-blob-hash')),
    ]);
  });

  it('accepts raw Uint8Array proofs', () => {
    const serialized = serialize(
      buildSubmitMilestoneProofTx({
        ...base,
        milestonesId: '0xfeed',
        circleId: '0xc1',
        milestoneIndex: 1,
        proof: new Uint8Array([1, 2, 3]),
      }),
    );
    const pure = pureInputs(serialized);
    expect(pure[1]).toEqual([3, 1, 2, 3]);
  });

  it('builds verify_milestone with tracker, circle, and index', () => {
    const serialized = serialize(
      buildVerifyMilestoneTx({
        ...base,
        milestonesId: '0xfeed',
        circleId: '0xc1',
        milestoneIndex: 2,
      }),
    );
    expect(serialized.transactions[0].target).toBe(
      `${PKG}::njangi_milestones::verify_milestone`,
    );
    expect(serialized.transactions[0].arguments).toHaveLength(3);
    expect(pureInputs(serialized)[0]).toEqual([2, 0, 0, 0, 0, 0, 0, 0]);
  });

  // --- eager argument validation (fail before signing, not on-chain) ----

  it('rejects missing object ids', () => {
    expect(() =>
      buildCreateCircleMilestonesTx({ ...base, circleId: '' }),
    ).toThrow('Missing required argument: circleId');
    expect(() =>
      buildRecordCycleProgressTx({ ...base, milestonesId: '', escrowId: '0xe' }),
    ).toThrow('Missing required argument: milestonesId');
    expect(() =>
      buildRecordCycleProgressTx({ ...base, milestonesId: '0xt', escrowId: '' }),
    ).toThrow('Missing required argument: escrowId');
  });

  it('rejects zero monetary targets (mirrors E_TARGET_INVALID)', () => {
    expect(() =>
      buildAddMonetaryMilestoneTx({
        ...base,
        milestonesId: '0xfeed',
        circleId: '0xc1',
        targetAmount: 0n,
        description: 'x',
      }),
    ).toThrow('Milestone target amount must be greater than zero.');
  });

  it('rejects descriptions above the 256-byte on-chain cap', () => {
    expect(() =>
      buildAddMonetaryMilestoneTx({
        ...base,
        milestonesId: '0xfeed',
        circleId: '0xc1',
        targetAmount: 1n,
        description: 'a'.repeat(257),
      }),
    ).toThrow(/description is too long/);
  });

  it('rejects negative or fractional milestone indexes', () => {
    expect(() =>
      buildCompleteMilestoneTx({
        ...base,
        milestonesId: '0xfeed',
        milestoneIndex: -1,
      }),
    ).toThrow('milestoneIndex must be a non-negative integer.');
    expect(() =>
      buildVerifyMilestoneTx({
        ...base,
        milestonesId: '0xfeed',
        circleId: '0xc1',
        milestoneIndex: 1.5,
      }),
    ).toThrow('milestoneIndex must be a non-negative integer.');
  });

  it('rejects empty and oversized proofs (mirrors E_PROOF_TOO_LARGE)', () => {
    expect(() =>
      buildSubmitMilestoneProofTx({
        ...base,
        milestonesId: '0xfeed',
        circleId: '0xc1',
        milestoneIndex: 0,
        proof: '',
      }),
    ).toThrow('Milestone proof must not be empty.');
    expect(() =>
      buildSubmitMilestoneProofTx({
        ...base,
        milestonesId: '0xfeed',
        circleId: '0xc1',
        milestoneIndex: 0,
        proof: new Uint8Array(513),
      }),
    ).toThrow(/proof is too large/);
  });
});
