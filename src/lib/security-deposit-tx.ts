// security-deposit-tx.ts — browser-side builder for a member's security deposit.
//
// This is the transaction that lets someone JOIN a circle, so it is the most
// user-critical of the actions that moved off server-side signing. It has more
// work than the plain admin move calls: the amount is read from the circle's
// on-chain config rather than trusted from the caller, and the USDC path has
// to gather and merge the member's coin objects before splitting the exact
// deposit.
//
// Every read here (config fields, coin objects) is a public RPC read the
// browser can do for itself. Nothing needed the server except the signature,
// which is exactly the part that had to stop happening there.

import type { SuiClient } from '@mysten/sui/client';
import type { Transaction } from '@mysten/sui/transactions';
import { getCircleConfigFields } from './circle-config';

const CLOCK_OBJECT_ID = '0x6';

/** 1 US cent == 10,000 microUSDC (USDC carries 6 decimals). */
export function usdCentsToMicroUsdc(usdCents: number): bigint {
  return BigInt(Math.floor(usdCents)) * BigInt(10_000);
}

function parsePositiveNumber(value: unknown): number {
  const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function readConfigUsdCents(
  fields: Record<string, unknown> | null,
  keys: string[],
): number {
  if (!fields) return 0;
  for (const key of keys) {
    const v = parsePositiveNumber(fields[key]);
    if (v > 0) return v;
  }
  return 0;
}

/** Pages through every coin of a type the member owns. */
async function getAllCoins(
  client: SuiClient,
  owner: string,
  coinType: string,
): Promise<Array<{ coinObjectId: string; balance: string }>> {
  const out: Array<{ coinObjectId: string; balance: string }> = [];
  let cursor: string | null = null;
  do {
    const page = await client.getCoins({ owner, coinType, cursor });
    out.push(...page.data.map((c) => ({ coinObjectId: c.coinObjectId, balance: c.balance })));
    cursor = page.hasNextPage ? page.nextCursor ?? null : null;
  } while (cursor);
  return out;
}

export class InsufficientDepositBalanceError extends Error {
  constructor(
    readonly required: bigint,
    readonly available: bigint,
    readonly currency: 'USDC' | 'SUI',
  ) {
    const fmt = (v: bigint) =>
      currency === 'USDC'
        ? (Number(v) / 1e6).toFixed(2)
        : (Number(v) / 1e9).toFixed(4);
    super(
      `Insufficient ${currency} for the security deposit. ` +
        `Need ${fmt(required)}, have ${fmt(available)}.`,
    );
    this.name = 'InsufficientDepositBalanceError';
  }
}

export interface SecurityDepositBuildInput {
  packageId: string;
  circleId: string;
  walletId: string;
  userAddress: string;
  currency: 'USDC' | 'SUI';
  usdcCoinType: string;
  suiCoinType: string;
  /** Only consulted for SUI when the circle config has no configured amount. */
  fallbackSuiAmount?: bigint;
}

/**
 * Populates `txb` with the member's security-deposit payment.
 *
 * The deposit amount is ALWAYS taken from the circle's on-chain config when
 * one is set — a caller-supplied figure is only a fallback for SUI circles
 * with no configured amount. The Move side re-checks it, but deriving it from
 * chain state here means the UI cannot under-pay by passing a stale number.
 */
export async function buildSecurityDepositTx(
  txb: Transaction,
  client: SuiClient,
  input: SecurityDepositBuildInput,
): Promise<void> {
  const configFields = await getCircleConfigFields(client, input.circleId);

  if (input.currency === 'USDC') {
    const cents = readConfigUsdCents(configFields, ['security_deposit_usd']);
    if (cents <= 0) {
      throw new Error(
        'This circle has no USDC security deposit configured. Try the SUI deposit instead.',
      );
    }
    const required = usdCentsToMicroUsdc(cents);

    const coins = await getAllCoins(client, input.userAddress, input.usdcCoinType);
    const total = coins.reduce((s, c) => s + BigInt(c.balance), BigInt(0));
    if (total < required) {
      throw new InsufficientDepositBalanceError(required, total, 'USDC');
    }

    // Merge into the first coin, then split the exact amount. Splitting from
    // an OWNED coin rather than txb.gas is what keeps this sponsorable: the
    // sponsor's gas coin is never drawn on for value.
    const [primary, ...rest] = coins.map((c) => c.coinObjectId);
    if (rest.length > 0) {
      txb.mergeCoins(txb.object(primary), rest.map((id) => txb.object(id)));
    }
    const depositCoin = txb.splitCoins(txb.object(primary), [txb.pure.u64(required)]);

    txb.moveCall({
      target: `${input.packageId}::njangi_circles::member_deposit_security_deposit`,
      typeArguments: [input.usdcCoinType],
      arguments: [
        txb.object(input.circleId),
        txb.object(input.walletId),
        depositCoin,
        txb.object(CLOCK_OBJECT_ID),
      ],
    });
    return;
  }

  // SUI path: config wins over the caller's figure when present.
  const configured = parsePositiveNumber(configFields?.security_deposit);
  const amount =
    configured > 0 ? BigInt(Math.floor(configured)) : input.fallbackSuiAmount ?? BigInt(0);
  if (amount <= BigInt(0)) {
    throw new Error(
      'This circle has no SUI security deposit configured, and no amount was supplied.',
    );
  }

  const [depositCoin] = txb.splitCoins(txb.gas, [txb.pure.u64(amount)]);
  txb.moveCall({
    target: `${input.packageId}::njangi_circles::member_deposit_security_deposit`,
    typeArguments: [input.suiCoinType],
    arguments: [
      txb.object(input.circleId),
      txb.object(input.walletId),
      depositCoin,
      txb.object(CLOCK_OBJECT_ID),
    ],
  });
}
