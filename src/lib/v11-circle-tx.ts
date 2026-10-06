// v11-circle-tx.ts — client side of the v11 Move package.
//
// v11 circles pin their asset terms on chain (settlement coin, decimals,
// native contribution and deposit amounts) and keep each member's security
// deposit as a v11 deposit record inside the circle's own custody wallet,
// moved only by contract rules: it goes back to that member, never anywhere
// else. Recovery stops the circle once and then refunds per asset.
//
// Everything here is used only behind NEXT_PUBLIC_V11_ENABLED (default OFF;
// see feature-flags.ts). Flip it on only after the v11 package is published
// on the active network, the AssetRegistry is blessed with the circle assets
// registered, and the existing circles are converted — before then every
// target named here aborts.
//
// Amounts are base units of the circle's coin (bigint), always read from the
// circle's pinned terms, never derived in the browser from a price.

import type { SuiClient } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { normalizePackageId } from '@/lib/circle-chain';
import { normalizeRequiredObjectId } from '@/lib/sui-object-id';
import {
  parseCreateCircleData,
  type CreateCircleTransactionData,
} from '@/lib/zklogin-tx-builders';
import type { NetworkType } from '@/config/public-env';

const CLOCK_OBJECT_ID = '0x6';
const CREATE_CIRCLE_GAS_BUDGET = 60_000_000;

/** One asset's pinned terms, in that asset's base units. */
export interface V11AssetTerms {
  /** Full coin type with `0x` prefix, e.g. `0x…::usdc::USDC`. */
  coinType: string;
  decimals: number;
  contributionAmount: bigint;
  securityDeposit: bigint;
}

/** A circle's pinned asset terms (njangi_circles::CircleAssetPolicy). */
export interface V11CircleAssetPolicy {
  settlement: V11AssetTerms;
  assets: V11AssetTerms[];
  setAtMs: number;
  /** The custody wallet every v11 money call of this circle must pass. */
  walletId: string;
  legacyLedgerEntries: number;
}

/**
 * The canonical AssetRegistry id for `network`. Static env reads, so Next.js
 * can inline them. Null when unset — callers must refuse rather than guess.
 */
export function getAssetRegistryId(network: NetworkType): string | null {
  const raw = network === 'mainnet'
    ? process.env.NEXT_PUBLIC_MAINNET_NJANGI_ASSET_REGISTRY_ID
    : process.env.NEXT_PUBLIC_TESTNET_NJANGI_ASSET_REGISTRY_ID;
  const trimmed = (raw ?? '').trim();
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(trimmed)) return null;
  return trimmed;
}

const requirePackageId = (value: string): string => {
  const normalized = normalizePackageId(value);
  if (!normalized) throw new Error('Package ID is required.');
  return normalized;
};

const requireCoinType = (value: string): string => {
  const trimmed = (value ?? '').trim();
  if (!/^0x[0-9a-fA-F]{1,64}::[A-Za-z_][A-Za-z0-9_]*::[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
    throw new Error('Coin type is invalid.');
  }
  return trimmed;
};

/** `<64 hex>::m::N` (Move type_name bytes) -> `0x<64 hex>::m::N`. */
export function coinTypeFromTypeNameBytes(raw: string): string {
  const value = raw.startsWith('0x') ? raw.slice(2) : raw;
  return `0x${value}`;
}

/** True when `coinType` is SUI, whatever its address padding. */
export function isSuiCoinType(coinType: string): boolean {
  const [address, module, name] = coinType.split('::');
  if (!address || module !== 'sui' || name !== 'SUI') return false;
  return BigInt(address.startsWith('0x') ? address : `0x${address}`) === 2n;
}

// ---------------------------------------------------------------------------
// Reading a circle's pinned terms
// ---------------------------------------------------------------------------

const bytesToString = (value: unknown): string | null => {
  if (Array.isArray(value) && value.every((b) => typeof b === 'number')) {
    return String.fromCharCode(...(value as number[]));
  }
  if (typeof value === 'string' && value.includes('::')) return value;
  return null;
};

const toBigInt = (value: unknown): bigint | null => {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  return null;
};

const fieldsOf = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const nested = record.fields;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    return nested as Record<string, unknown>;
  }
  return record;
};

function parseTerms(value: unknown): V11AssetTerms | null {
  const fields = fieldsOf(value);
  if (!fields) return null;
  const asset = bytesToString(fields.asset);
  const decimals = Number(fields.decimals);
  const contributionAmount = toBigInt(fields.contribution_amount);
  const securityDeposit = toBigInt(fields.security_deposit);
  if (!asset || !Number.isInteger(decimals) || contributionAmount === null || securityDeposit === null) {
    return null;
  }
  return {
    coinType: coinTypeFromTypeNameBytes(asset),
    decimals,
    contributionAmount,
    securityDeposit,
  };
}

/**
 * Parses the JSON-RPC rendering of a `CircleAssetPolicy` value. Returns null
 * for anything that does not have the full shape — an unreadable policy is
 * "unknown", never "no terms".
 */
export function parseCircleAssetPolicy(value: unknown): V11CircleAssetPolicy | null {
  const fields = fieldsOf(value);
  if (!fields) return null;
  const settlementAsset = bytesToString(fields.settlement_asset);
  const assetsRaw = Array.isArray(fields.assets) ? fields.assets : null;
  const setAtMs = toBigInt(fields.set_at_ms);
  const walletId = typeof fields.wallet_id === 'string' ? fields.wallet_id : null;
  const ledgerEntries = toBigInt(fields.legacy_ledger_entries);
  if (!settlementAsset || !assetsRaw || setAtMs === null || !walletId || ledgerEntries === null) {
    return null;
  }
  const assets: V11AssetTerms[] = [];
  for (const entry of assetsRaw) {
    const terms = parseTerms(entry);
    if (!terms) return null;
    assets.push(terms);
  }
  const settlementType = coinTypeFromTypeNameBytes(settlementAsset);
  const settlement = assets.find((terms) => terms.coinType === settlementType);
  if (!settlement) return null;
  return {
    settlement,
    assets,
    setAtMs: Number(setAtMs),
    walletId,
    legacyLedgerEntries: Number(ledgerEntries),
  };
}

type PolicyReaderClient = Pick<SuiClient, 'getDynamicFields' | 'getObject'>;

/**
 * Reads a circle's pinned terms by object read (no event scan). Resolves to
 * `null` when the circle has no terms (created before v11 and not converted).
 * Throws when the read itself fails, so callers never mistake an RPC error
 * for "no terms".
 */
export async function readCircleAssetPolicy(
  client: PolicyReaderClient,
  circleId: string,
): Promise<V11CircleAssetPolicy | null> {
  const parentId = normalizeRequiredObjectId(circleId, 'Circle ID');
  let cursor: string | null | undefined = null;
  do {
    const page = await client.getDynamicFields({ parentId, cursor });
    const entry = page.data.find((field) =>
      typeof field.name?.type === 'string'
      && field.name.type.endsWith('::njangi_circles::AssetPolicyKey'),
    );
    if (entry) {
      const object = await client.getObject({ id: entry.objectId, options: { showContent: true } });
      const content = object.data?.content;
      const value = content && 'fields' in content
        ? (content.fields as Record<string, unknown>).value
        : null;
      const policy = parseCircleAssetPolicy(value);
      if (!policy) throw new Error('This circle\'s asset terms could not be read.');
      return policy;
    }
    cursor = page.hasNextPage ? page.nextCursor : null;
  } while (cursor);
  return null;
}

// ---------------------------------------------------------------------------
// Native terms at creation
// ---------------------------------------------------------------------------

export type V11SettlementChoice = 'USDC' | 'SUI';

/**
 * The native (base-unit) contribution and deposit a new circle pins.
 *   - USD-pegged coin (USDC): cents at the peg, `cents * 10^(decimals - 2)`
 *     — exactly what the contract checks, so the USD fields stay truthful.
 *   - SUI: the SUI amounts the create form already computed (MIST).
 */
export function nativeTermsForCreate(input: {
  settlement: V11SettlementChoice;
  contributionUsdCents: bigint;
  depositUsdCents: bigint;
  suiContributionMist: bigint;
  suiDepositMist: bigint;
  usdDecimals?: number;
}): { contributionNative: bigint; depositNative: bigint } {
  if (input.settlement === 'SUI') {
    return { contributionNative: input.suiContributionMist, depositNative: input.suiDepositMist };
  }
  const decimals = input.usdDecimals ?? 6;
  if (!Number.isInteger(decimals) || decimals < 2) {
    throw new Error('Stablecoin decimals are invalid.');
  }
  const scale = 10n ** BigInt(decimals - 2);
  return {
    contributionNative: input.contributionUsdCents * scale,
    depositNative: input.depositUsdCents * scale,
  };
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

export interface BuildCreateCircleWithAssetTxInput {
  packageId: string;
  registryId: string;
  coinType: string;
  circleData: CreateCircleTransactionData;
  contributionNative: bigint;
  depositNative: bigint;
}

/** `njangi_circles::create_circle_with_asset<T>`. */
export function buildCreateCircleWithAssetTx(input: BuildCreateCircleWithAssetTxInput): Transaction {
  const parsed = parseCreateCircleData(input.circleData);
  const packageId = requirePackageId(input.packageId);
  const coinType = requireCoinType(input.coinType);
  const registryId = normalizeRequiredObjectId(input.registryId, 'Asset registry ID');
  if (input.contributionNative <= 0n) throw new Error('Contribution amount is required.');
  // The contract's own rule, no stricter: `deposit_native >=
  // njangi_core::min_security_deposit(contribution_native)`, which is the
  // contribution divided by two, rounded down. `deposit * 2 < contribution`
  // refused an odd SUI share's half (84_745_763 MIST share, 42_372_881 MIST
  // deposit) that the contract accepts, so the default half deposit of a SUI
  // circle failed before signing about half the time (production 2026-10-06).
  if (input.depositNative <= 0n || input.depositNative < input.contributionNative / 2n) {
    throw new Error('The security deposit must be at least half a contribution.');
  }

  const tx = new Transaction();
  tx.setGasBudget(CREATE_CIRCLE_GAS_BUDGET);
  tx.moveCall({
    target: `${packageId}::njangi_circles::create_circle_with_asset`,
    typeArguments: [coinType],
    arguments: [
      tx.pure.string(parsed.name),
      tx.pure.string(parsed.currencyType),
      tx.pure.u64(parsed.contributionAmountLocal),
      tx.pure.u64(parsed.contributionAmountUsd),
      tx.pure.u64(parsed.securityDepositLocal),
      tx.pure.u64(parsed.securityDepositUsd),
      tx.pure.u64(input.contributionNative),
      tx.pure.u64(input.depositNative),
      tx.pure.u64(parsed.cycleLength),
      tx.pure.u64(parsed.cycleDay),
      tx.pure.u8(parsed.circleType),
      tx.pure.u64(parsed.maxMembers),
      tx.pure.u8(parsed.rotationStyle),
      tx.pure.vector('bool', parsed.penaltyRules),
      tx.pure.option('u8', parsed.goalType),
      tx.pure.option('u64', parsed.targetAmount),
      tx.pure.option('u64', parsed.targetAmountLocal),
      tx.pure.option('u64', parsed.targetDate),
      tx.pure.bool(parsed.verificationRequired),
      tx.pure.bool(parsed.autoReleaseEnabled),
      tx.pure.u64(parsed.autoReleaseDelayMs),
      tx.pure.option('address', parsed.nextInCommand),
      tx.object(registryId),
      tx.object(CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

export class InsufficientCoinBalanceError extends Error {
  constructor(readonly required: bigint, readonly available: bigint, readonly coinType: string) {
    super('Your wallet does not hold enough of this circle\'s coin for the security deposit.');
    this.name = 'InsufficientCoinBalanceError';
  }
}

type CoinReaderClient = Pick<SuiClient, 'getCoins'>;

async function getAllCoins(client: CoinReaderClient, owner: string, coinType: string) {
  const out: Array<{ coinObjectId: string; balance: string }> = [];
  let cursor: string | null | undefined = null;
  do {
    const page = await client.getCoins({ owner, coinType, cursor });
    out.push(...page.data.map((c) => ({ coinObjectId: c.coinObjectId, balance: c.balance })));
    cursor = page.hasNextPage ? page.nextCursor : null;
  } while (cursor);
  return out;
}

export interface PostSecurityDepositInput {
  packageId: string;
  registryId: string;
  circleId: string;
  userAddress: string;
  /** The circle's pinned terms (readCircleAssetPolicy). */
  policy: V11CircleAssetPolicy;
}

/**
 * Populates `txb` with `njangi_circles::post_security_deposit<T>`: exactly the
 * circle's pinned deposit, in its pinned coin, into the circle's bound custody
 * wallet. A non-SUI coin is merged from the member's own coin objects and
 * split there (never from `txb.gas`), which keeps the call sponsorable; SUI
 * comes from the gas coin and so must not be sponsored.
 */
export async function buildPostSecurityDepositTx(
  txb: Transaction,
  client: CoinReaderClient,
  input: PostSecurityDepositInput,
): Promise<{ coinType: string; amount: bigint; usesGasCoinForValue: boolean }> {
  const packageId = requirePackageId(input.packageId);
  const registryId = normalizeRequiredObjectId(input.registryId, 'Asset registry ID');
  const circleId = normalizeRequiredObjectId(input.circleId, 'Circle ID');
  const walletId = normalizeRequiredObjectId(input.policy.walletId, 'Custody wallet ID');
  const { coinType, securityDeposit: amount } = input.policy.settlement;
  if (amount <= 0n) throw new Error('This circle has no security deposit in its terms.');

  let depositCoin;
  const usesGasCoinForValue = isSuiCoinType(coinType);
  if (usesGasCoinForValue) {
    [depositCoin] = txb.splitCoins(txb.gas, [txb.pure.u64(amount)]);
  } else {
    const coins = await getAllCoins(client, input.userAddress, coinType);
    const total = coins.reduce((sum, c) => sum + BigInt(c.balance), 0n);
    if (total < amount) throw new InsufficientCoinBalanceError(amount, total, coinType);
    const [primary, ...rest] = coins.map((c) => c.coinObjectId);
    if (rest.length > 0) {
      txb.mergeCoins(txb.object(primary), rest.map((id) => txb.object(id)));
    }
    [depositCoin] = txb.splitCoins(txb.object(primary), [txb.pure.u64(amount)]);
  }

  txb.moveCall({
    target: `${packageId}::njangi_circles::post_security_deposit`,
    typeArguments: [coinType],
    arguments: [
      txb.object(circleId),
      txb.object(walletId),
      txb.object(registryId),
      depositCoin,
      txb.object(CLOCK_OBJECT_ID),
    ],
  });
  return { coinType, amount, usesGasCoinForValue };
}

interface CircleWalletAssetInput {
  packageId: string;
  circleId: string;
  walletId: string;
  coinType: string;
}

function circleWalletAssetCall(
  fn: 'refund_asset' | 'claim_own_refund' | 'execute_recovery_asset' | 'trigger_auto_release_asset',
  input: CircleWalletAssetInput,
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${requirePackageId(input.packageId)}::njangi_circles::${fn}`,
    typeArguments: [requireCoinType(input.coinType)],
    arguments: [
      tx.object(normalizeRequiredObjectId(input.circleId, 'Circle ID')),
      tx.object(normalizeRequiredObjectId(input.walletId, 'Custody wallet ID')),
      tx.object(CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

/** Returns every recorded deposit in `coinType` to its member (circle stopped). */
export const buildRefundAssetTx = (input: CircleWalletAssetInput) =>
  circleWalletAssetCall('refund_asset', input);

/** The signer collects their own recorded deposit (stopped, or no longer a member). */
export const buildClaimOwnRefundTx = (input: CircleWalletAssetInput) =>
  circleWalletAssetCall('claim_own_refund', input);

/** Stop after a passed vote (if not yet stopped), then refund `coinType`. */
export const buildExecuteRecoveryAssetTx = (input: CircleWalletAssetInput) =>
  circleWalletAssetCall('execute_recovery_asset', input);

/** Stop through the auto-release rule (if not yet stopped), then refund `coinType`. */
export const buildTriggerAutoReleaseAssetTx = (input: CircleWalletAssetInput) =>
  circleWalletAssetCall('trigger_auto_release_asset', input);

/**
 * `admin_remove_member_asset<T>`: removes a member from an inactive circle and
 * returns their recorded deposit, in its coin, to them.
 */
export function buildAdminRemoveMemberAssetTx(input: CircleWalletAssetInput & { memberAddress: string }): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${requirePackageId(input.packageId)}::njangi_circles::admin_remove_member_asset`,
    typeArguments: [requireCoinType(input.coinType)],
    arguments: [
      tx.object(normalizeRequiredObjectId(input.circleId, 'Circle ID')),
      tx.pure.address(normalizeRequiredObjectId(input.memberAddress, 'Member address')),
      tx.object(normalizeRequiredObjectId(input.walletId, 'Custody wallet ID')),
      tx.object(CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

/**
 * `adopt_asset_policy<T>`: converts a circle created before v11 (permissionless;
 * nothing leaves the custody wallet). Used by the conversion script.
 */
export function buildAdoptAssetPolicyTx(input: CircleWalletAssetInput & { registryId: string }): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${requirePackageId(input.packageId)}::njangi_circles::adopt_asset_policy`,
    typeArguments: [requireCoinType(input.coinType)],
    arguments: [
      tx.object(normalizeRequiredObjectId(input.circleId, 'Circle ID')),
      tx.object(normalizeRequiredObjectId(input.walletId, 'Custody wallet ID')),
      tx.object(normalizeRequiredObjectId(input.registryId, 'Asset registry ID')),
      tx.object(CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

/** `njangi_cycle_escrow::open_round<T>` (pinned coin and amount, indexed). */
export function buildOpenRoundTx(input: {
  packageId: string;
  circleId: string;
  registryId: string;
  coinType: string;
}): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${requirePackageId(input.packageId)}::njangi_cycle_escrow::open_round`,
    typeArguments: [requireCoinType(input.coinType)],
    arguments: [
      tx.object(normalizeRequiredObjectId(input.circleId, 'Circle ID')),
      tx.object(normalizeRequiredObjectId(input.registryId, 'Asset registry ID')),
      tx.object(CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

/**
 * `njangi_cycle_escrow::release_invalid_round<T>`: clears the open-round
 * marker of an escrow that is not a valid round under the circle's pinned
 * terms. Moves no coins.
 */
export function buildReleaseInvalidRoundTx(input: {
  packageId: string;
  circleId: string;
  escrowId: string;
  coinType: string;
}): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${requirePackageId(input.packageId)}::njangi_cycle_escrow::release_invalid_round`,
    typeArguments: [requireCoinType(input.coinType)],
    arguments: [
      tx.object(normalizeRequiredObjectId(input.circleId, 'Circle ID')),
      tx.object(normalizeRequiredObjectId(input.escrowId, 'Escrow ID')),
      tx.object(CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}
