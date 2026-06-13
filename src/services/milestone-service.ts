// milestone-service.ts — Frontend wrapper for the smart-goals Move module
// (`njangi_milestones`). Lets UI code build the transactions for
// create_circle_milestones / add_*_milestone / record_cycle_progress /
// complete_milestone / submit_milestone_proof / verify_milestone without
// knowing the raw Move call shapes. Mirrors cycle-escrow-service.ts.
//
// Transactions are returned as a `BuildTransactionFn` callback that can be
// handed to either the legacy server signer
// (`enokiZkLoginService.sendTransaction`) or the Phase 2 client-side
// signer (`useZkLoginSigner`). Both paths accept the same callback shape.
//
// Note on premium gating: smart goals are a Premium feature, but the gate
// lives in the UI/API layer (entitlement-gate preflight + 402 upsell) —
// the Move entry points themselves are public, so these builders stay
// gate-free by design (soft gate, see entitlement-gate.ts).

import { Transaction } from '@mysten/sui/transactions';
import { getPackageIdForNetwork } from './network-config';
import type { NetworkType } from './whatsapp-registry-service';

const CLOCK_OBJECT_ID = '0x6';

// Mirror the Move module's hard caps (njangi_milestones.move) so a doomed
// transaction fails client-side with a readable message instead of an
// on-chain abort code.
const MAX_DESCRIPTION_BYTES = 256; // E_DESCRIPTION_TOO_LONG
const MAX_PROOF_BYTES = 512; // E_PROOF_TOO_LARGE

function packageIdFor(network: NetworkType): string {
  // Prefer the canonical resolver (handles legacy NEXT_PUBLIC_PACKAGE_ID
  // fallback). Direct process.env reads can return undefined inside the
  // browser bundle if the dev server was started before .env.local was
  // populated, even though the file now has the value.
  const fromConfig = getPackageIdForNetwork(network);
  if (fromConfig && fromConfig.trim() !== '') return fromConfig;

  const envKey =
    network === 'mainnet'
      ? 'NEXT_PUBLIC_MAINNET_PACKAGE_ID'
      : 'NEXT_PUBLIC_TESTNET_PACKAGE_ID';
  const id = process.env[envKey];
  if (!id) {
    throw new Error(
      `Missing ${envKey}. Restart the dev server (npm run dev) so Next.js picks up the latest .env.local.`,
    );
  }
  return id;
}

export interface MilestoneCallBase {
  network: NetworkType;
  /** Canonical Move type argument the circle's cycles settle in,
   *  e.g. `0x2::sui::SUI` or a USDC type. Must match the tracker's `T`. */
  coinType: string;
}

export interface CreateCircleMilestonesParams extends MilestoneCallBase {
  circleId: string;
}

export interface AddMonetaryMilestoneParams extends MilestoneCallBase {
  milestonesId: string;
  circleId: string;
  /** CUMULATIVE contribution target in base units of `T`. Must strictly
   *  exceed the previous monetary milestone's target. */
  targetAmount: bigint;
  description: string;
  requiresVerification?: boolean;
}

export interface AddTimeMilestoneParams extends MilestoneCallBase {
  milestonesId: string;
  circleId: string;
  /** Sui clock target in ms. Must lie in the future and after the
   *  previous time milestone's target. */
  targetTimestampMs: number | bigint;
  description: string;
  requiresVerification?: boolean;
}

export interface RecordCycleProgressParams extends MilestoneCallBase {
  milestonesId: string;
  /** A CLAIMED CycleEscrow<T> of the same circle. Credits exactly once;
   *  permissionless (anyone pays the gas). */
  escrowId: string;
}

export interface CompleteMilestoneParams extends MilestoneCallBase {
  milestonesId: string;
  /** Must equal the tracker's `next_to_complete` (strict index order). */
  milestoneIndex: number;
}

export interface SubmitMilestoneProofParams extends MilestoneCallBase {
  milestonesId: string;
  circleId: string;
  milestoneIndex: number;
  /** Opaque proof bytes (e.g. a Walrus blob hash). Strings are UTF-8
   *  encoded. Max 512 bytes on-chain. */
  proof: Uint8Array | string;
}

export interface VerifyMilestoneParams extends MilestoneCallBase {
  milestonesId: string;
  circleId: string;
  milestoneIndex: number;
}

export type BuildTransactionFn = (txb: Transaction) => void;

function requireAddr(value: string, name: string): string {
  if (!value) throw new Error(`Missing required argument: ${name}`);
  return value;
}

function requireIndex(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return value;
}

function descriptionToBytes(description: string): number[] {
  const bytes = new TextEncoder().encode(description ?? '');
  if (bytes.length > MAX_DESCRIPTION_BYTES) {
    throw new Error(
      `Milestone description is too long (${bytes.length} bytes; max ${MAX_DESCRIPTION_BYTES}).`,
    );
  }
  return Array.from(bytes);
}

function proofToBytes(proof: Uint8Array | string): number[] {
  const bytes =
    typeof proof === 'string' ? new TextEncoder().encode(proof) : proof;
  if (bytes.length === 0) {
    throw new Error('Milestone proof must not be empty.');
  }
  if (bytes.length > MAX_PROOF_BYTES) {
    throw new Error(
      `Milestone proof is too large (${bytes.length} bytes; max ${MAX_PROOF_BYTES}).`,
    );
  }
  return Array.from(bytes);
}

/**
 * `create_circle_milestones<T>(circle)` — admin-only, before the rotation
 * starts. Shares the goal tracker; the resulting object id is discovered
 * afterwards via `findCircleMilestones` (MilestonesCreated event).
 */
export function buildCreateCircleMilestonesTx(
  params: CreateCircleMilestonesParams,
): BuildTransactionFn {
  const packageId = packageIdFor(params.network);
  const circleId = requireAddr(params.circleId, 'circleId');
  return (txb: Transaction) => {
    txb.moveCall({
      target: `${packageId}::njangi_milestones::create_circle_milestones`,
      typeArguments: [params.coinType],
      arguments: [txb.object(circleId)],
    });
  };
}

/**
 * `add_monetary_milestone<T>(tracker, circle, target, description,
 * requires_verification)` — admin-only while the definition is open.
 */
export function buildAddMonetaryMilestoneTx(
  params: AddMonetaryMilestoneParams,
): BuildTransactionFn {
  const packageId = packageIdFor(params.network);
  const milestonesId = requireAddr(params.milestonesId, 'milestonesId');
  const circleId = requireAddr(params.circleId, 'circleId');
  if (params.targetAmount <= 0n) {
    throw new Error('Milestone target amount must be greater than zero.');
  }
  const descriptionBytes = descriptionToBytes(params.description);
  return (txb: Transaction) => {
    txb.moveCall({
      target: `${packageId}::njangi_milestones::add_monetary_milestone`,
      typeArguments: [params.coinType],
      arguments: [
        txb.object(milestonesId),
        txb.object(circleId),
        txb.pure.u64(params.targetAmount),
        txb.pure.vector('u8', descriptionBytes),
        txb.pure.bool(Boolean(params.requiresVerification)),
      ],
    });
  };
}

/**
 * `add_time_milestone<T>(tracker, circle, target_ms, description,
 * requires_verification, clock)` — admin-only while the definition is open.
 */
export function buildAddTimeMilestoneTx(
  params: AddTimeMilestoneParams,
): BuildTransactionFn {
  const packageId = packageIdFor(params.network);
  const milestonesId = requireAddr(params.milestonesId, 'milestonesId');
  const circleId = requireAddr(params.circleId, 'circleId');
  const targetMs = BigInt(params.targetTimestampMs);
  if (targetMs <= 0n) {
    throw new Error('Milestone target date must be in the future.');
  }
  const descriptionBytes = descriptionToBytes(params.description);
  return (txb: Transaction) => {
    txb.moveCall({
      target: `${packageId}::njangi_milestones::add_time_milestone`,
      typeArguments: [params.coinType],
      arguments: [
        txb.object(milestonesId),
        txb.object(circleId),
        txb.pure.u64(targetMs),
        txb.pure.vector('u8', descriptionBytes),
        txb.pure.bool(Boolean(params.requiresVerification)),
        txb.object(CLOCK_OBJECT_ID),
      ],
    });
  };
}

/**
 * `record_cycle_progress<T>(tracker, escrow)` — permissionless; credits a
 * CLAIMED CycleEscrow exactly once. The credited amount comes from the
 * escrow's frozen snapshot, never from the caller.
 */
export function buildRecordCycleProgressTx(
  params: RecordCycleProgressParams,
): BuildTransactionFn {
  const packageId = packageIdFor(params.network);
  const milestonesId = requireAddr(params.milestonesId, 'milestonesId');
  const escrowId = requireAddr(params.escrowId, 'escrowId');
  return (txb: Transaction) => {
    txb.moveCall({
      target: `${packageId}::njangi_milestones::record_cycle_progress`,
      typeArguments: [params.coinType],
      arguments: [txb.object(milestonesId), txb.object(escrowId)],
    });
  };
}

/**
 * `complete_milestone<T>(tracker, index, clock)` — permissionless once the
 * condition holds on-chain. Completing the final milestone also emits
 * `GoalAchieved` (the community celebration hook).
 */
export function buildCompleteMilestoneTx(
  params: CompleteMilestoneParams,
): BuildTransactionFn {
  const packageId = packageIdFor(params.network);
  const milestonesId = requireAddr(params.milestonesId, 'milestonesId');
  const milestoneIndex = requireIndex(params.milestoneIndex, 'milestoneIndex');
  return (txb: Transaction) => {
    txb.moveCall({
      target: `${packageId}::njangi_milestones::complete_milestone`,
      typeArguments: [params.coinType],
      arguments: [
        txb.object(milestonesId),
        txb.pure.u64(BigInt(milestoneIndex)),
        txb.object(CLOCK_OBJECT_ID),
      ],
    });
  };
}

/**
 * `submit_milestone_proof<T>(tracker, circle, index, proof)` — member-only;
 * anchors opaque proof bytes on a verification-gated milestone.
 */
export function buildSubmitMilestoneProofTx(
  params: SubmitMilestoneProofParams,
): BuildTransactionFn {
  const packageId = packageIdFor(params.network);
  const milestonesId = requireAddr(params.milestonesId, 'milestonesId');
  const circleId = requireAddr(params.circleId, 'circleId');
  const milestoneIndex = requireIndex(params.milestoneIndex, 'milestoneIndex');
  const proofBytes = proofToBytes(params.proof);
  return (txb: Transaction) => {
    txb.moveCall({
      target: `${packageId}::njangi_milestones::submit_milestone_proof`,
      typeArguments: [params.coinType],
      arguments: [
        txb.object(milestonesId),
        txb.object(circleId),
        txb.pure.u64(BigInt(milestoneIndex)),
        txb.pure.vector('u8', proofBytes),
      ],
    });
  };
}

/**
 * `verify_milestone<T>(tracker, circle, index)` — admin's one-time
 * confirmation of a verification-gated milestone. Gates only the
 * celebration flag; moves no funds.
 */
export function buildVerifyMilestoneTx(
  params: VerifyMilestoneParams,
): BuildTransactionFn {
  const packageId = packageIdFor(params.network);
  const milestonesId = requireAddr(params.milestonesId, 'milestonesId');
  const circleId = requireAddr(params.circleId, 'circleId');
  const milestoneIndex = requireIndex(params.milestoneIndex, 'milestoneIndex');
  return (txb: Transaction) => {
    txb.moveCall({
      target: `${packageId}::njangi_milestones::verify_milestone`,
      typeArguments: [params.coinType],
      arguments: [
        txb.object(milestonesId),
        txb.object(circleId),
        txb.pure.u64(BigInt(milestoneIndex)),
      ],
    });
  };
}
