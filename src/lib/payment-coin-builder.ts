// payment-coin-builder.ts — Build a `Coin<T>` argument of an exact amount
// inside a Sui programmable transaction block without asking the user to
// manually pick or merge coin objects. This replaces the "paste a Coin<T>
// object id" UX for the CycleEscrow contribute flow.
//
// Behavior:
//   1. Fetch the user's owned `Coin<T>` objects from RPC.
//   2. If the total balance is insufficient, throw a clear error.
//   3. Merge secondary coins into the primary coin so the txb has a single
//      base coin to split from.
//   4. Split off the exact contribution amount — returns the TransactionResult
//      arg the caller passes straight to `moveCall` as the contribution arg.
//
// SUI has a native "gas coin" quirk: when CoinType is native SUI we split
// from `txb.gas` so the user doesn't have to hand-select a SUI coin. For
// any other type we select from the `getCoins` result.

import type { SuiClient, CoinStruct } from '@mysten/sui/client';
import type { Transaction, TransactionArgument } from '@mysten/sui/transactions';

const NATIVE_SUI_TYPE =
  '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';

function normalizeCoinType(type: string): string {
  // Sui `0x2::sui::SUI` and the fully-padded form refer to the same type.
  // Use `0*` (not `0+`): the short form `0x2::` has NO leading zeros, and if it
  // isn't expanded the native-SUI check below fails — sending SUI contributions
  // down the generic path, which pulls every SUI coin in as a tx input and
  // leaves none for gas ("No valid gas coins found").
  return type.replace(
    /^0x0*2::/,
    '0x0000000000000000000000000000000000000000000000000000000000000002::',
  );
}

export interface PreparePaymentCoinParams {
  txb: Transaction;
  client: SuiClient;
  owner: string;
  coinType: string;
  /** Amount to split off, in base units (e.g. mist for SUI, micro for USDC). */
  amount: bigint;
}

export interface PreparePaymentCoinResult {
  /** The resulting split coin, ready to hand to `txb.moveCall`. */
  coinArg: TransactionArgument;
  /** Gross balance the user holds in this coin type across all coin objects. */
  availableBalance: bigint;
}

/**
 * Returns a programmable-tx argument referencing a Coin<T> of exactly
 * `amount` base units. Handles both the native-SUI (gas coin) and
 * generic-coin paths.
 */
export async function preparePaymentCoin(
  params: PreparePaymentCoinParams,
): Promise<PreparePaymentCoinResult> {
  const { txb, client, owner, amount } = params;
  if (amount <= 0n) {
    throw new Error('Contribution amount must be positive.');
  }
  const coinType = normalizeCoinType(params.coinType);
  const isNativeSui = coinType === NATIVE_SUI_TYPE;

  if (isNativeSui) {
    // The gas coin already holds the user's SUI balance in a PTB context;
    // we can split from it directly without extra RPC round trips.
    const [coinArg] = txb.splitCoins(txb.gas, [txb.pure.u64(amount)]);
    // Signal the full balance to the caller via a separate getBalance so
    // upstream UIs can still show "you have X SUI".
    const balance = await client.getBalance({ owner, coinType });
    return {
      coinArg,
      availableBalance: BigInt(balance.totalBalance ?? '0'),
    };
  }

  const coins = await collectAllCoins(client, owner, coinType);
  const totalBalance = coins.reduce(
    (sum, c) => sum + BigInt(c.balance),
    0n,
  );
  if (totalBalance < amount) {
    throw new Error(
      `Insufficient ${coinType} balance: need ${amount.toString()} but wallet holds ${totalBalance.toString()}.`,
    );
  }

  if (coins.length === 0) {
    throw new Error(`No ${coinType} coins found in wallet.`);
  }

  // Sort coins largest-first so we operate on the fewest objects.
  const sorted = [...coins].sort((a, b) =>
    BigInt(a.balance) < BigInt(b.balance) ? 1 : -1,
  );
  const [primary, ...rest] = sorted;
  const primaryRef = txb.object(primary.coinObjectId);

  if (rest.length > 0) {
    const mergeRefs = rest.map((c) => txb.object(c.coinObjectId));
    txb.mergeCoins(primaryRef, mergeRefs);
  }

  const [coinArg] = txb.splitCoins(primaryRef, [txb.pure.u64(amount)]);
  return {
    coinArg,
    availableBalance: totalBalance,
  };
}

async function collectAllCoins(
  client: SuiClient,
  owner: string,
  coinType: string,
): Promise<CoinStruct[]> {
  const all: CoinStruct[] = [];
  let cursor: string | null | undefined = null;
  for (let page = 0; page < 10; page += 1) {
    const response = await client.getCoins({ owner, coinType, cursor });
    all.push(...response.data);
    if (!response.hasNextPage || !response.nextCursor) break;
    cursor = response.nextCursor;
  }
  return all;
}
