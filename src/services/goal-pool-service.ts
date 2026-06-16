// goal-pool-service.ts — Frontend wrapper for the non-rotating GoalPool Move
// module (`njangi_goal_pool`). Builds the transactions for
// open / contribute (any amount) / release / cancel / claim_refund without
// the UI knowing the raw Move call shapes.
//
// Mirrors cycle-escrow-service.ts: builders return either a sync
// `(txb) => void` (BuildTransactionFn) or, when they must split a coin, an
// async `(txb, client) => Promise<void>` so preparePaymentCoin can read the
// caller's coins. Both shapes are accepted by the zkLogin client signer.

import { Transaction } from '@mysten/sui/transactions';
import { SuiClient } from '@mysten/sui/client';
import { getPackageIdForNetwork } from './network-config';
import type { NetworkType } from './whatsapp-registry-service';
import { preparePaymentCoin } from '../lib/payment-coin-builder';

const CLOCK_OBJECT_ID = '0x6';
const MODULE = 'njangi_goal_pool';

// Goal kinds — must match the on-chain GOAL_KIND_* constants.
export const GOAL_KIND_AMOUNT = 0;
export const GOAL_KIND_DATE = 1;
export const GOAL_KIND_AMOUNT_BY_DATE = 2;

function packageIdFor(network: NetworkType): string {
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

function requireAddr(value: string, name: string): string {
  if (!value) throw new Error(`Missing required argument: ${name}`);
  return value;
}

export interface GoalPoolCallBase {
  network: NetworkType;
  /** Canonical Move type argument, e.g. `0x2::sui::SUI` or a USDC type. */
  coinType: string;
}

export type BuildTransactionFn = (txb: Transaction) => void;
export type AsyncBuildTransactionFn = (txb: Transaction, client: SuiClient) => Promise<void>;

export interface OpenGoalPoolParams extends GoalPoolCallBase {
  /** Display name / goal description (may include a leading emoji). */
  name: string;
  /** Address that receives the whole pot once the goal is met (pre-committed). */
  beneficiary: string;
  /** GOAL_KIND_AMOUNT or GOAL_KIND_DATE. */
  goalKind: number;
  /** Base units of the coin (e.g. SUI MIST). 0 for date goals. */
  targetAmount: bigint;
  /** Unix ms. 0 for amount goals. */
  targetDateMs: bigint;
  /** Optional contributor-protection deadline (0 = none). */
  deadlineMs: bigint;
  /** When true, KYC-gate contributions via the pinned ComplianceConfig. */
  withComplianceGate?: boolean;
  /** Required when withComplianceGate: the ComplianceConfig object id to pin. */
  complianceConfigId?: string;
}

export function buildOpenGoalPoolTx(params: OpenGoalPoolParams): BuildTransactionFn {
  const packageId = packageIdFor(params.network);
  const beneficiary = requireAddr(params.beneficiary, 'beneficiary');
  return (txb: Transaction) => {
    const baseArgs = [
      txb.pure.string(params.name),
      txb.pure.address(beneficiary),
      txb.pure.u8(params.goalKind),
      txb.pure.u64(params.targetAmount),
      txb.pure.u64(params.targetDateMs),
      txb.pure.u64(params.deadlineMs),
    ];
    if (params.withComplianceGate) {
      const configId = requireAddr(params.complianceConfigId ?? '', 'complianceConfigId');
      txb.moveCall({
        target: `${packageId}::${MODULE}::open_with_gate`,
        typeArguments: [params.coinType],
        arguments: [...baseArgs, txb.object(configId), txb.object(CLOCK_OBJECT_ID)],
      });
    } else {
      txb.moveCall({
        target: `${packageId}::${MODULE}::open`,
        typeArguments: [params.coinType],
        arguments: [...baseArgs, txb.object(CLOCK_OBJECT_ID)],
      });
    }
  };
}

export interface ContributeToPoolParams extends GoalPoolCallBase {
  poolId: string;
  /** Any positive amount, in the coin's base units. */
  amount: bigint;
  /** Signer's wallet address, for coin discovery. */
  ownerAddress: string;
  /** Gated pools only: the caller's ComplianceAttestation object id. */
  attestationObjectId?: string;
  /** Gated pools only: the pinned ComplianceConfig object id. */
  complianceConfigId?: string;
}

/**
 * Contribute any positive amount. Auto-discovers + splits the caller's Coin<T>
 * via preparePaymentCoin, then calls contribute (or contribute_with_attestation
 * for a gated pool). Unlike the rotational escrow, the amount is caller-chosen.
 */
export function buildContributeToPoolTx(params: ContributeToPoolParams): AsyncBuildTransactionFn {
  const packageId = packageIdFor(params.network);
  const poolId = requireAddr(params.poolId, 'poolId');
  const owner = requireAddr(params.ownerAddress, 'ownerAddress');
  return async (txb: Transaction, client: SuiClient) => {
    const { coinArg } = await preparePaymentCoin({
      txb,
      client,
      owner,
      coinType: params.coinType,
      amount: params.amount,
    });
    if (params.attestationObjectId) {
      const attestationId = requireAddr(params.attestationObjectId, 'attestationObjectId');
      const configId = requireAddr(params.complianceConfigId ?? '', 'complianceConfigId');
      txb.moveCall({
        target: `${packageId}::${MODULE}::contribute_with_attestation`,
        typeArguments: [params.coinType],
        arguments: [
          txb.object(poolId),
          coinArg,
          txb.object(attestationId),
          txb.object(configId),
          txb.object(CLOCK_OBJECT_ID),
        ],
      });
    } else {
      txb.moveCall({
        target: `${packageId}::${MODULE}::contribute`,
        typeArguments: [params.coinType],
        arguments: [txb.object(poolId), coinArg],
      });
    }
  };
}

export interface PoolActionParams extends GoalPoolCallBase {
  poolId: string;
}

/** Permissionless: pushes the whole pot to the beneficiary once the goal is met. */
export function buildReleaseTx(params: PoolActionParams): BuildTransactionFn {
  const packageId = packageIdFor(params.network);
  const poolId = requireAddr(params.poolId, 'poolId');
  return (txb: Transaction) => {
    txb.moveCall({
      target: `${packageId}::${MODULE}::release`,
      typeArguments: [params.coinType],
      arguments: [txb.object(poolId), txb.object(CLOCK_OBJECT_ID)],
    });
  };
}

/** Admin-only: cancel an active (not-yet-met) pool, opening refunds. */
export function buildCancelTx(params: PoolActionParams): BuildTransactionFn {
  const packageId = packageIdFor(params.network);
  const poolId = requireAddr(params.poolId, 'poolId');
  return (txb: Transaction) => {
    txb.moveCall({
      target: `${packageId}::${MODULE}::cancel`,
      typeArguments: [params.coinType],
      arguments: [txb.object(poolId), txb.object(CLOCK_OBJECT_ID)],
    });
  };
}

/** Permissionless once an optional deadline passes with the goal unmet/unreleased. */
export function buildCancelAfterDeadlineTx(params: PoolActionParams): BuildTransactionFn {
  const packageId = packageIdFor(params.network);
  const poolId = requireAddr(params.poolId, 'poolId');
  return (txb: Transaction) => {
    txb.moveCall({
      target: `${packageId}::${MODULE}::cancel_after_deadline`,
      typeArguments: [params.coinType],
      arguments: [txb.object(poolId), txb.object(CLOCK_OBJECT_ID)],
    });
  };
}

/** A contributor reclaims their exact contribution after the pool is cancelled. */
export function buildClaimRefundTx(params: PoolActionParams): BuildTransactionFn {
  const packageId = packageIdFor(params.network);
  const poolId = requireAddr(params.poolId, 'poolId');
  return (txb: Transaction) => {
    txb.moveCall({
      target: `${packageId}::${MODULE}::claim_refund`,
      typeArguments: [params.coinType],
      arguments: [txb.object(poolId)],
    });
  };
}
