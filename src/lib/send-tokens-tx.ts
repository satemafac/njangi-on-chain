// send-tokens-tx.ts — browser-side builder for a plain wallet transfer.
//
// This was the highest-value target on the old server-signing surface: a
// generic "move `amount` of `coinType` to `recipient`" primitive that, with
// the session cookie, let anyone drain a wallet. It could not be constrained
// by a Move-target allowlist because it makes no Move call at all.
//
// Building it here does not make the operation safer in itself — a transfer is
// a transfer — but it removes the ability from the server entirely. Only the
// key holder can now authorize one.

import type { SuiClient } from '@mysten/sui/client';
import type { Transaction } from '@mysten/sui/transactions';

export const SUI_COIN_TYPE = '0x2::sui::SUI';

export class InsufficientTokenBalanceError extends Error {
  constructor(readonly required: bigint, readonly available: bigint, coinType: string) {
    const symbol = coinType.split('::').pop() ?? 'tokens';
    super(`Not enough ${symbol}. Need ${required.toString()}, have ${available.toString()}.`);
    this.name = 'InsufficientTokenBalanceError';
  }
}

export function isValidSuiAddress(addr: string): boolean {
  const clean = addr.startsWith('0x') ? addr.slice(2) : addr;
  return /^[0-9a-fA-F]+$/.test(clean) && clean.length > 0 && clean.length <= 64;
}

export interface SendTokensInput {
  recipientAddress: string;
  /** Base units — MIST for SUI, micro-units for USDC. */
  amount: bigint;
  coinType: string;
  userAddress: string;
}

/**
 * Populates `txb` with a transfer of `amount` of `coinType` to `recipient`.
 *
 * SUI splits from the gas coin; other coin types gather owned objects
 * largest-first, merge them, then split the exact amount. The recipient is
 * validated here so a malformed address fails before signing rather than
 * producing a transaction that burns gas to abort.
 */
export async function buildSendTokensTx(
  txb: Transaction,
  client: SuiClient,
  input: SendTokensInput,
): Promise<void> {
  if (!isValidSuiAddress(input.recipientAddress)) {
    throw new Error('That does not look like a valid Sui address.');
  }
  if (input.amount <= BigInt(0)) {
    throw new Error('Transfer amount must be greater than zero.');
  }

  const recipient = input.recipientAddress.startsWith('0x')
    ? input.recipientAddress
    : `0x${input.recipientAddress}`;

  if (input.coinType === SUI_COIN_TYPE) {
    // Gas and value share one coin for native SUI, so the split comes off
    // txb.gas. That is also why this transfer can never be gas-sponsored:
    // it would spend the sponsor's coin.
    const [coin] = txb.splitCoins(txb.gas, [txb.pure.u64(input.amount)]);
    txb.transferObjects([coin], txb.pure.address(recipient));
    return;
  }

  const owned: Array<{ coinObjectId: string; balance: string }> = [];
  let cursor: string | null = null;
  do {
    const page = await client.getCoins({
      owner: input.userAddress,
      coinType: input.coinType,
      cursor,
    });
    owned.push(...page.data.map((c) => ({ coinObjectId: c.coinObjectId, balance: c.balance })));
    cursor = page.hasNextPage ? page.nextCursor ?? null : null;
  } while (cursor);

  if (owned.length === 0) {
    throw new InsufficientTokenBalanceError(input.amount, BigInt(0), input.coinType);
  }

  // Largest first, so the common case needs the fewest merges.
  owned.sort((a, b) => (BigInt(b.balance) > BigInt(a.balance) ? 1 : -1));

  const total = owned.reduce((sum, c) => sum + BigInt(c.balance), BigInt(0));
  if (total < input.amount) {
    throw new InsufficientTokenBalanceError(input.amount, total, input.coinType);
  }

  // Take only as many coins as the amount needs, rather than merging the
  // whole wallet into one object on every transfer.
  const selected: string[] = [];
  let running = BigInt(0);
  for (const c of owned) {
    selected.push(c.coinObjectId);
    running += BigInt(c.balance);
    if (running >= input.amount) break;
  }

  const [primary, ...rest] = selected;
  if (rest.length > 0) {
    txb.mergeCoins(txb.object(primary), rest.map((id) => txb.object(id)));
  }
  const [coin] = txb.splitCoins(txb.object(primary), [txb.pure.u64(input.amount)]);
  txb.transferObjects([coin], txb.pure.address(recipient));
}
