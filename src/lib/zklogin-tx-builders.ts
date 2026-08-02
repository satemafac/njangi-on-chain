import { normalizeSuiObjectId } from '@mysten/sui/utils';
import { Transaction } from '@mysten/sui/transactions';
import { getMinimumAutoReleaseDelayMsForMoveCycleLength } from '@/lib/auto-release';
import { normalizePackageId } from '@/lib/circle-chain';
import { normalizeRecoveryDelegateAddress } from '@/lib/recovery-delegate';

const CLOCK_OBJECT_ID = '0x6';
const CREATE_CIRCLE_GAS_BUDGET = 50_000_000;
const RECOVERY_VOTE_GAS_BUDGET = 50_000_000;
const RECOVERY_EXECUTION_GAS_BUDGET = 100_000_000;

export interface CircleOptionU8 {
  some?: number;
  none?: null;
}

export interface CircleOptionU64 {
  some?: string | number | bigint;
  none?: null;
}

export interface CreateCircleTransactionData {
  name: string;
  contribution_amount: string | number | bigint;
  contribution_amount_local?: string | number | bigint;
  contribution_amount_usd?: string | number | bigint;
  currency_type?: string;
  security_deposit: string | number | bigint;
  security_deposit_local?: string | number | bigint;
  security_deposit_usd?: string | number | bigint;
  cycle_length: number;
  cycle_day: number;
  circle_type: number;
  max_members: number;
  rotation_style: number;
  penalty_rules: boolean[];
  goal_type?: CircleOptionU8;
  target_amount?: CircleOptionU64;
  target_amount_local?: CircleOptionU64 | string | number | bigint;
  target_date?: CircleOptionU64;
  verification_required: boolean;
  auto_release_enabled?: boolean;
  auto_release_delay_ms?: string | number | bigint;
  next_in_command?: string | null;
}

interface BaseRecoveryBuilderInput {
  packageId: string;
  circleId: string;
}

export interface ExecuteRecoveryBuilderInput extends BaseRecoveryBuilderInput {
  walletId: string;
  stablecoinType: string;
}

export type HeartbeatAdminLivenessBuilderInput = BaseRecoveryBuilderInput;

export interface BatchHeartbeatAdminLivenessBuilderInput {
  circles: HeartbeatAdminLivenessBuilderInput[];
}

export interface UpdateNextInCommandBuilderInput extends BaseRecoveryBuilderInput {
  nextInCommand?: string | null;
}

export interface BuildCreateCircleTxInput {
  packageId: string;
  circleData: CreateCircleTransactionData;
}

const normalizeRequiredObjectId = (value: string, label: string): string => {
  if (!value || typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} is required.`);
  }

  try {
    return normalizeSuiObjectId(value);
  } catch {
    throw new Error(`${label} is invalid.`);
  }
};

const normalizeRequiredPackageId = (value: string): string => {
  const normalized = normalizePackageId(value);
  if (!normalized) {
    throw new Error('Package ID is required.');
  }
  return normalized;
};

const toU64 = (value: string | number | bigint | null | undefined, label: string): bigint => {
  if (value === null || typeof value === 'undefined' || value === '') {
    throw new Error(`${label} is required.`);
  }

  try {
    const parsed = BigInt(value);
    if (parsed < 0n) {
      throw new Error(`${label} must be non-negative.`);
    }
    return parsed;
  } catch (error) {
    if (error instanceof Error && error.message.includes('must be non-negative')) {
      throw error;
    }
    throw new Error(`${label} is invalid.`);
  }
};

const toOptionalU64 = (
  value: CircleOptionU64 | string | number | bigint | null | undefined,
): bigint | null => {
  if (value === null || typeof value === 'undefined') {
    return null;
  }

  if (typeof value === 'object' && !Array.isArray(value)) {
    if ('some' in value && value.some !== undefined && value.some !== null && value.some !== '') {
      return toU64(value.some, 'Option<u64> value');
    }
    return null;
  }

  if (value === '') {
    return null;
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
    return toU64(value, 'Option<u64> value');
  }

  return null;
};

const toOptionalU8 = (value: CircleOptionU8 | null | undefined): number | null => {
  if (!value || typeof value.some === 'undefined' || value.some === null) {
    return null;
  }

  if (!Number.isInteger(value.some) || value.some < 0 || value.some > 255) {
    throw new Error('Option<u8> value is invalid.');
  }

  return value.some;
};

export function buildCreateCircleTx({
  packageId,
  circleData,
}: BuildCreateCircleTxInput): Transaction {
  if (!circleData.name || circleData.name.trim().length === 0) {
    throw new Error('Circle name is required.');
  }

  if (!Array.isArray(circleData.penalty_rules)) {
    throw new Error('Penalty rules are required.');
  }

  const normalizedPackageId = normalizeRequiredPackageId(packageId);
  const contributionAmount = toU64(circleData.contribution_amount, 'Contribution amount');
  const contributionAmountLocal = toU64(
    circleData.contribution_amount_local ?? 0,
    'Contribution amount (local)',
  );
  const contributionAmountUsd = toU64(
    circleData.contribution_amount_usd ?? 0,
    'Contribution amount (USD)',
  );
  const securityDeposit = toU64(circleData.security_deposit, 'Security deposit');
  const securityDepositLocal = toU64(
    circleData.security_deposit_local ?? 0,
    'Security deposit (local)',
  );
  const securityDepositUsd = toU64(
    circleData.security_deposit_usd ?? 0,
    'Security deposit (USD)',
  );
  const cycleLength = Number(circleData.cycle_length);
  const cycleDay = Number(circleData.cycle_day);
  const circleType = Number(circleData.circle_type);
  const maxMembers = Number(circleData.max_members);
  const rotationStyle = Number(circleData.rotation_style);
  const autoReleaseEnabled = circleData.auto_release_enabled === true;
  const autoReleaseDelayMs = toU64(
    circleData.auto_release_delay_ms ?? 0,
    'Auto-release delay',
  );
  const rawNextInCommand = circleData.next_in_command;
  const nextInCommand = normalizeRecoveryDelegateAddress(rawNextInCommand);

  if (!Number.isInteger(cycleLength)) {
    throw new Error('Cycle length is invalid.');
  }
  if (!Number.isInteger(cycleDay) || cycleDay < 0) {
    throw new Error('Cycle day is invalid.');
  }
  if (!Number.isInteger(circleType) || circleType < 0 || circleType > 255) {
    throw new Error('Circle type is invalid.');
  }
  if (!Number.isInteger(maxMembers) || maxMembers <= 0) {
    throw new Error('Max members is invalid.');
  }
  if (!Number.isInteger(rotationStyle) || rotationStyle < 0 || rotationStyle > 255) {
    throw new Error('Rotation style is invalid.');
  }

  if (
    typeof rawNextInCommand === 'string'
    && rawNextInCommand.trim().length > 0
    && !nextInCommand
  ) {
    throw new Error('Next-in-command wallet address is invalid.');
  }

  if (autoReleaseEnabled) {
    const minimumAutoReleaseDelayMs = getMinimumAutoReleaseDelayMsForMoveCycleLength(cycleLength);
    if (minimumAutoReleaseDelayMs === null) {
      throw new Error('Cycle length is invalid.');
    }

    if (autoReleaseDelayMs <= BigInt(minimumAutoReleaseDelayMs)) {
      throw new Error('Auto-release delay must be greater than the selected cycle length.');
    }
  }

  const tx = new Transaction();
  tx.setGasBudget(CREATE_CIRCLE_GAS_BUDGET);
  tx.moveCall({
    target: `${normalizedPackageId}::njangi_circles::create_circle`,
    arguments: [
      tx.pure.string(circleData.name),
      tx.pure.u64(contributionAmount),
      tx.pure.string(circleData.currency_type || 'USD'),
      tx.pure.u64(contributionAmountLocal),
      tx.pure.u64(contributionAmountUsd),
      tx.pure.u64(securityDeposit),
      tx.pure.u64(securityDepositLocal),
      tx.pure.u64(securityDepositUsd),
      tx.pure.u64(cycleLength),
      tx.pure.u64(cycleDay),
      tx.pure.u8(circleType),
      tx.pure.u64(maxMembers),
      tx.pure.u8(rotationStyle),
      tx.pure.vector('bool', circleData.penalty_rules),
      tx.pure.option('u8', toOptionalU8(circleData.goal_type)),
      tx.pure.option('u64', toOptionalU64(circleData.target_amount)),
      tx.pure.option('u64', toOptionalU64(circleData.target_amount_local)),
      tx.pure.option('u64', toOptionalU64(circleData.target_date)),
      tx.pure.bool(circleData.verification_required),
      tx.pure.bool(autoReleaseEnabled),
      tx.pure.u64(autoReleaseDelayMs),
      tx.pure.option('address', nextInCommand),
      tx.object(CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

export function buildProposeEmergencyStopTx({
  packageId,
  circleId,
}: BaseRecoveryBuilderInput): Transaction {
  const tx = new Transaction();
  tx.setGasBudget(RECOVERY_VOTE_GAS_BUDGET);
  tx.moveCall({
    target: `${normalizeRequiredPackageId(packageId)}::njangi_circles::propose_emergency_stop`,
    arguments: [
      tx.object(normalizeRequiredObjectId(circleId, 'Circle ID')),
      tx.object(CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

export function buildVoteEmergencyStopTx({
  packageId,
  circleId,
  yesVote,
}: BaseRecoveryBuilderInput & { yesVote: boolean }): Transaction {
  const tx = new Transaction();
  tx.setGasBudget(RECOVERY_VOTE_GAS_BUDGET);
  tx.moveCall({
    target: `${normalizeRequiredPackageId(packageId)}::njangi_circles::vote_emergency_stop`,
    arguments: [
      tx.object(normalizeRequiredObjectId(circleId, 'Circle ID')),
      tx.pure.bool(yesVote),
      tx.object(CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

export function buildExecuteRecoveryTx({
  packageId,
  circleId,
  walletId,
  stablecoinType,
}: ExecuteRecoveryBuilderInput): Transaction {
  if (!stablecoinType || stablecoinType.trim().length === 0) {
    throw new Error('Stablecoin type is required.');
  }

  const tx = new Transaction();
  tx.setGasBudget(RECOVERY_EXECUTION_GAS_BUDGET);
  tx.moveCall({
    target: `${normalizeRequiredPackageId(packageId)}::njangi_circles::execute_recovery`,
    typeArguments: [stablecoinType],
    arguments: [
      tx.object(normalizeRequiredObjectId(circleId, 'Circle ID')),
      tx.object(normalizeRequiredObjectId(walletId, 'Custody wallet ID')),
      tx.object(CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

export function buildTriggerAutoReleaseTx({
  packageId,
  circleId,
  walletId,
  stablecoinType,
}: ExecuteRecoveryBuilderInput): Transaction {
  if (!stablecoinType || stablecoinType.trim().length === 0) {
    throw new Error('Stablecoin type is required.');
  }

  const tx = new Transaction();
  tx.setGasBudget(RECOVERY_EXECUTION_GAS_BUDGET);
  tx.moveCall({
    target: `${normalizeRequiredPackageId(packageId)}::njangi_circles::trigger_auto_release`,
    typeArguments: [stablecoinType],
    arguments: [
      tx.object(normalizeRequiredObjectId(circleId, 'Circle ID')),
      tx.object(normalizeRequiredObjectId(walletId, 'Custody wallet ID')),
      tx.object(CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

export function buildUpdateNextInCommandTx({
  packageId,
  circleId,
  nextInCommand,
}: UpdateNextInCommandBuilderInput): Transaction {
  const normalizedNextInCommand = normalizeRecoveryDelegateAddress(nextInCommand);

  if (
    typeof nextInCommand === 'string'
    && nextInCommand.trim().length > 0
    && !normalizedNextInCommand
  ) {
    throw new Error('Next-in-command wallet address is invalid.');
  }

  const tx = new Transaction();
  tx.setGasBudget(RECOVERY_VOTE_GAS_BUDGET);
  tx.moveCall({
    target: `${normalizeRequiredPackageId(packageId)}::njangi_circles::update_next_in_command`,
    arguments: [
      tx.object(normalizeRequiredObjectId(circleId, 'Circle ID')),
      tx.pure.option('address', normalizedNextInCommand),
      tx.object(CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

export function buildHeartbeatAdminLivenessTx({
  packageId,
  circleId,
}: HeartbeatAdminLivenessBuilderInput): Transaction {
  const tx = new Transaction();
  tx.setGasBudget(RECOVERY_VOTE_GAS_BUDGET);
  tx.moveCall({
    target: `${normalizeRequiredPackageId(packageId)}::njangi_circles::heartbeat_admin_liveness`,
    arguments: [
      tx.object(normalizeRequiredObjectId(circleId, 'Circle ID')),
      tx.object(CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

export function buildBatchHeartbeatAdminLivenessTx({
  circles,
}: BatchHeartbeatAdminLivenessBuilderInput): Transaction {
  if (!Array.isArray(circles) || circles.length === 0) {
    throw new Error('At least one circle target is required.');
  }

  const tx = new Transaction();
  tx.setGasBudget(RECOVERY_VOTE_GAS_BUDGET * circles.length);

  circles.forEach(({ packageId, circleId }) => {
    tx.moveCall({
      target: `${normalizeRequiredPackageId(packageId)}::njangi_circles::heartbeat_admin_liveness`,
      arguments: [
        tx.object(normalizeRequiredObjectId(circleId, 'Circle ID')),
        tx.object(CLOCK_OBJECT_ID),
      ],
    });
  });

  return tx;
}

export interface ClaimMembershipBuilderInput {
  /** One entry per circle whose receipt is missing. */
  circles: Array<{ packageId: string; circleId: string }>;
}

/**
 * Mints the caller's own `CircleMembership` receipts.
 *
 * Receipts make a circle discoverable through `getOwnedObjects`, which is
 * server-side filtered and works on any RPC endpoint. Circles predating the
 * receipt upgrade have none, so they are only findable by scanning the
 * `CircleCreated` / `MemberJoined` event streams — and event history is the
 * one thing replacement RPC providers do NOT reliably serve (publicnode and
 * suiscan both fail with "Could not find the referenced transaction events";
 * only blockvision answers, and it rate-limits). A circle without a receipt is
 * therefore one rate-limit away from vanishing from the dashboard.
 *
 * `claim_membership` is permissionless for a current member and aborts with
 * ENotMember otherwise, so this can only ever mint the caller's own receipts.
 * Duplicates are harmless — discovery dedups by circle_id and re-verifies
 * against the circle's live members table.
 *
 * Batched into one transaction so restoring N circles costs one signature.
 */
export function buildClaimMembershipTx({
  circles,
}: ClaimMembershipBuilderInput): Transaction {
  if (!Array.isArray(circles) || circles.length === 0) {
    throw new Error('At least one circle target is required.');
  }

  const tx = new Transaction();
  tx.setGasBudget(RECOVERY_VOTE_GAS_BUDGET * circles.length);

  circles.forEach(({ packageId, circleId }) => {
    tx.moveCall({
      target: `${normalizeRequiredPackageId(packageId)}::njangi_circles::claim_membership`,
      arguments: [
        tx.object(normalizeRequiredObjectId(circleId, 'Circle ID')),
        tx.object(CLOCK_OBJECT_ID),
      ],
    });
  });

  return tx;
}
