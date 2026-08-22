// cycle-escrow-service.ts — Frontend wrapper for the Phase 2 CycleEscrow
// Move module (`njangi_cycle_escrow`). Lets UI code build the transactions
// for open_cycle / contribute / finalize_and_redeem / redeem_claim without
// knowing the raw Move call shapes.
//
// Transactions are returned as a `buildTransaction` callback that can be
// handed to either the legacy server signer
// (`enokiZkLoginService.sendTransaction`) or the Phase 2 client-side
// signer (`useZkLoginSigner`). Both paths accept the same callback shape.

import { Transaction } from '@mysten/sui/transactions';
import { SuiClient } from '@mysten/sui/client';
import { getPooledSuiClient } from './sui-rpc-failover';
import { getNetworkConfig, getPackageIdForNetwork } from './network-config';
import type { NetworkType } from './whatsapp-registry-service';
import { preparePaymentCoin } from '../lib/payment-coin-builder';
import { isTimedEscrowEntriesEnabled } from '@/config/feature-flags';

const CLOCK_OBJECT_ID = '0x6';

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

export interface CycleEscrowCallBase {
  network: NetworkType;
  /** Canonical Move type argument, e.g. `0x2::sui::SUI` or a USDC type. */
  coinType: string;
}

export interface OpenCycleParams extends CycleEscrowCallBase {
  circleId: string;
  /** Phase 7: when true, the escrow requires a valid ComplianceAttestation
   *  for every contribute/claim. Calls `open_cycle_with_gate` instead of
   *  the plain `open_cycle`. */
  withComplianceGate?: boolean;
  /**
   * Required when withComplianceGate: the shared ComplianceConfig object
   * id the gated entrypoints take as their second argument (resolve it
   * with `resolveComplianceConfigId` from lib/compliance-gate). Omitting
   * it used to produce an on-chain "Incorrect number of arguments" error.
   */
  complianceConfigId?: string;
  /**
   * When set, opens a stablecoin-settled escrow. The per-member contribution
   * target is derived on-chain from the circle's USD value at this many
   * decimals (USDC = 6), so $0.30 becomes 300000 base units. Omit for
   * SUI-settled circles, which use the circle's raw SUI (MIST) amount.
   */
  stableDecimals?: number;
}

export interface ContributeParams extends CycleEscrowCallBase {
  escrowId: string;
  /**
   * The caller's `Coin<T>` object that matches the escrow snapshot's
   * contribution amount exactly. If you hold multiple coins, merge/split
   * them in the outer PTB before handing this to `contribute`.
   */
  paymentCoinId: string;
}

export interface FinalizeAndRedeemParams extends CycleEscrowCallBase {
  escrowId: string;
  /**
   * When provided, the collect PTB also calls
   * `advance_circle_after_claim(circle, escrow, clock)` so the circle's
   * rotation advances ATOMICALLY with the payout. The escrow flow has no
   * other path to advance the cycle, so omitting this leaves the circle
   * stalled on the same recipient. Always pass it from the panel.
   */
  circleId?: string;
}

export interface AdvanceCircleAfterClaimParams extends CycleEscrowCallBase {
  circleId: string;
  escrowId: string;
}

export interface RedeemClaimParams extends CycleEscrowCallBase {
  escrowId: string;
  claimId: string;
}

export type BuildTransactionFn = (txb: Transaction) => void;

function requireAddr(value: string, name: string): string {
  if (!value) throw new Error(`Missing required argument: ${name}`);
  return value;
}

export function buildOpenCycleTx(params: OpenCycleParams): BuildTransactionFn {
  const packageId = packageIdFor(params.network);
  const circleId = requireAddr(params.circleId, 'circleId');
  const isStable = typeof params.stableDecimals === 'number';
  // The *_with_gate entrypoints take the shared ComplianceConfig as their
  // second argument — enforce its presence here so a missing id fails at
  // build time with a named error instead of an on-chain arity abort.
  const complianceConfigId = params.withComplianceGate
    ? requireAddr(params.complianceConfigId ?? '', 'complianceConfigId')
    : null;
  // v1.1 (flag-gated on the published package version): the *_indexed
  // twins also append the new escrow's id to the circle's on-chain
  // history, which is what makes past escrows enumerable by object read.
  const indexed = isTimedEscrowEntriesEnabled() ? '_indexed' : '';
  const target = isStable
    ? params.withComplianceGate
      ? `${packageId}::njangi_cycle_escrow::open_cycle_stable${indexed}_with_gate`
      : `${packageId}::njangi_cycle_escrow::open_cycle_stable${indexed}`
    : params.withComplianceGate
      ? `${packageId}::njangi_cycle_escrow::open_cycle${indexed}_with_gate`
      : `${packageId}::njangi_cycle_escrow::open_cycle${indexed}`;
  return (txb: Transaction) => {
    const gateArgs = complianceConfigId ? [txb.object(complianceConfigId)] : [];
    txb.moveCall({
      target,
      typeArguments: [params.coinType],
      arguments: isStable
        ? [
            txb.object(circleId),
            ...gateArgs,
            txb.pure.u8(params.stableDecimals as number),
            txb.object(CLOCK_OBJECT_ID),
          ]
        : [txb.object(circleId), ...gateArgs, txb.object(CLOCK_OBJECT_ID)],
    });
  };
}

export interface ContributeWithAttestationParams extends ContributeParams {
  attestationObjectId: string;
}

export function buildContributeWithAttestationTx(
  params: ContributeWithAttestationParams,
): BuildTransactionFn {
  const packageId = packageIdFor(params.network);
  const escrowId = requireAddr(params.escrowId, 'escrowId');
  const paymentCoinId = requireAddr(params.paymentCoinId, 'paymentCoinId');
  const attestationId = requireAddr(params.attestationObjectId, 'attestationObjectId');
  return (txb: Transaction) => {
    txb.moveCall({
      target: `${packageId}::njangi_cycle_escrow::contribute_with_attestation`,
      typeArguments: [params.coinType],
      arguments: [
        txb.object(escrowId),
        txb.object(paymentCoinId),
        txb.object(attestationId),
        txb.object(CLOCK_OBJECT_ID),
      ],
    });
  };
}

export interface FinalizeAndRedeemWithAttestationParams extends FinalizeAndRedeemParams {
  attestationObjectId: string;
}

export function buildFinalizeAndRedeemWithAttestationTx(
  params: FinalizeAndRedeemWithAttestationParams,
): BuildTransactionFn {
  const packageId = packageIdFor(params.network);
  const escrowId = requireAddr(params.escrowId, 'escrowId');
  const attestationId = requireAddr(params.attestationObjectId, 'attestationObjectId');
  return (txb: Transaction) => {
    txb.moveCall({
      target: `${packageId}::njangi_cycle_escrow::finalize_and_redeem_with_attestation`,
      typeArguments: [params.coinType],
      arguments: [
        txb.object(escrowId),
        txb.object(attestationId),
        txb.object(CLOCK_OBJECT_ID),
      ],
    });
    appendAdvanceCircleAfterClaim(txb, packageId, params.coinType, params.circleId, escrowId);
  };
}

export function buildContributeTx(params: ContributeParams): BuildTransactionFn {
  const packageId = packageIdFor(params.network);
  const escrowId = requireAddr(params.escrowId, 'escrowId');
  const paymentCoinId = requireAddr(params.paymentCoinId, 'paymentCoinId');
  // v1.1: contribute_timed also records the member's contribution
  // timestamp on the escrow (takes the Clock as an extra argument), which
  // is what lets the Circle Record say "on time" as a fact.
  const timed = isTimedEscrowEntriesEnabled();
  return (txb: Transaction) => {
    txb.moveCall({
      target: `${packageId}::njangi_cycle_escrow::contribute${timed ? '_timed' : ''}`,
      typeArguments: [params.coinType],
      arguments: timed
        ? [txb.object(escrowId), txb.object(paymentCoinId), txb.object(CLOCK_OBJECT_ID)]
        : [txb.object(escrowId), txb.object(paymentCoinId)],
    });
  };
}

export interface ContributeAutoCoinParams {
  network: NetworkType;
  coinType: string;
  escrowId: string;
  /** Contribution amount in the coin's base units (must match snapshot). */
  contributionAmount: bigint;
  /** Signer's wallet address, for coin discovery. */
  ownerAddress: string;
}

/**
 * Builds a "contribute" transaction that auto-discovers the caller's
 * Coin<T> objects, merges / splits as needed, and submits the
 * contribution in one PTB. No manual object id entry required —
 * the user just signs the transaction.
 */
export function buildContributeWithAutoCoinTx(
  params: ContributeAutoCoinParams,
): (txb: Transaction, client: SuiClient) => Promise<void> {
  const packageId = packageIdFor(params.network);
  const escrowId = requireAddr(params.escrowId, 'escrowId');
  const owner = requireAddr(params.ownerAddress, 'ownerAddress');
  return async (txb: Transaction, client: SuiClient) => {
    const { coinArg } = await preparePaymentCoin({
      txb,
      client,
      owner,
      coinType: params.coinType,
      amount: params.contributionAmount,
    });
    const timed = isTimedEscrowEntriesEnabled();
    txb.moveCall({
      target: `${packageId}::njangi_cycle_escrow::contribute${timed ? '_timed' : ''}`,
      typeArguments: [params.coinType],
      arguments: timed
        ? [txb.object(escrowId), coinArg, txb.object(CLOCK_OBJECT_ID)]
        : [txb.object(escrowId), coinArg],
    });
  };
}

export function buildFinalizeAndRedeemTx(
  params: FinalizeAndRedeemParams,
): BuildTransactionFn {
  const packageId = packageIdFor(params.network);
  const escrowId = requireAddr(params.escrowId, 'escrowId');
  return (txb: Transaction) => {
    txb.moveCall({
      target: `${packageId}::njangi_cycle_escrow::finalize_and_redeem`,
      typeArguments: [params.coinType],
      arguments: [txb.object(escrowId), txb.object(CLOCK_OBJECT_ID)],
    });
    appendAdvanceCircleAfterClaim(txb, packageId, params.coinType, params.circleId, escrowId);
  };
}

/**
 * Append the `advance_circle_after_claim` move call to a PTB that has just
 * finalized+redeemed an escrow, so the circle's rotation advances atomically
 * with the payout. No-op when `circleId` is absent.
 */
function appendAdvanceCircleAfterClaim(
  txb: Transaction,
  packageId: string,
  coinType: string,
  circleId: string | undefined,
  escrowId: string,
): void {
  if (!circleId) return;
  txb.moveCall({
    target: `${packageId}::njangi_cycle_escrow::advance_circle_after_claim`,
    typeArguments: [coinType],
    arguments: [
      txb.object(circleId),
      txb.object(escrowId),
      txb.object(CLOCK_OBJECT_ID),
    ],
  });
}

/**
 * Standalone advance for a circle whose payout was collected WITHOUT the
 * chained advance above (i.e. a circle stuck on the same recipient because the
 * escrow was claimed before this function existed). Permissionless on-chain.
 */
export function buildAdvanceCircleAfterClaimTx(
  params: AdvanceCircleAfterClaimParams,
): BuildTransactionFn {
  const packageId = packageIdFor(params.network);
  const circleId = requireAddr(params.circleId, 'circleId');
  const escrowId = requireAddr(params.escrowId, 'escrowId');
  return (txb: Transaction) => {
    txb.moveCall({
      target: `${packageId}::njangi_cycle_escrow::advance_circle_after_claim`,
      typeArguments: [params.coinType],
      arguments: [
        txb.object(circleId),
        txb.object(escrowId),
        txb.object(CLOCK_OBJECT_ID),
      ],
    });
  };
}

/**
 * Two-step redeem for a claim minted to the recipient in a previous tx.
 * The caller must pass both the shared escrow object and the owned claim
 * object they hold; the Move function returns a `Coin<T>` that we transfer
 * to the caller.
 */
export function buildRedeemClaimTx(params: RedeemClaimParams): BuildTransactionFn {
  const packageId = packageIdFor(params.network);
  const escrowId = requireAddr(params.escrowId, 'escrowId');
  const claimId = requireAddr(params.claimId, 'claimId');
  return (txb: Transaction) => {
    const recipientAddress = txb.moveCall({
      target: `${packageId}::njangi_cycle_escrow::recipient`,
      typeArguments: [params.coinType],
      arguments: [txb.object(escrowId)],
    });
    const coin = txb.moveCall({
      target: `${packageId}::njangi_cycle_escrow::redeem_claim`,
      typeArguments: [params.coinType],
      arguments: [
        txb.object(escrowId),
        txb.object(claimId),
        txb.object(CLOCK_OBJECT_ID),
      ],
    });
    txb.transferObjects([coin], recipientAddress);
  };
}

/**
 * Convenience reader — fetches the CycleEscrow object state for a given
 * id. Useful for contribute/redeem UIs that need the snapshot's required
 * amount or remaining contributor list before building a tx.
 */
export async function fetchCycleEscrow(
  escrowId: string,
  network: NetworkType,
): Promise<Record<string, unknown> | null> {
  const config = getNetworkConfig(network);
  const client: SuiClient = getPooledSuiClient({ network, rpcUrl: config.rpcUrl });
  const obj = await client.getObject({
    id: escrowId,
    options: { showContent: true },
  });
  if (!obj.data?.content || obj.data.content.dataType !== 'moveObject') {
    return null;
  }
  return (obj.data.content as { fields: Record<string, unknown> }).fields;
}
