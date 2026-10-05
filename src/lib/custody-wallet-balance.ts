// custody-wallet-balance.ts — A custody wallet's coin balance, and the
// contract's refusal to delete a circle whose wallet still holds funds.
//
// Sui JSON-RPC renders a `0x2::balance::Balance<T>` field as a plain string
// of base units (testnet, 2026-10-02: `"balance": "0"`), not the
// `{ fields: { value } }` of an ordinary struct. The delete-circle pre-check
// read only the nested form, so it saw no balance on any wallet and its
// "withdraw all funds first" refusal never fired. The contract refuses anyway
// (below), so nothing could be lost, but the admin got a raw abort instead.

import type { SuiClient } from '@mysten/sui/client';
import { normalizeStructTag, normalizeSuiAddress, parseStructTag } from '@mysten/sui/utils';
import { normalizeCoinType } from '@/lib/supported-coins';

/**
 * The value of a `Balance<T>` field in base units, accepting the plain form
 * JSON-RPC returns and the nested struct form. Null when it does not read as
 * a balance: unknown, never zero.
 */
export function readBalanceField(raw: unknown): bigint | null {
  let value = raw;
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const record = raw as { fields?: { value?: unknown }; value?: unknown };
    value = record.fields?.value ?? record.value;
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  return null;
}

/**
 * True when a failed transaction is `njangi_circles::delete_circle` refusing
 * because the custody wallet still holds SUI or a stablecoin. Both checks
 * abort with EInsufficientDeposit (6), in the current source and in the
 * original package's on-chain bytecode alike, so this cannot tell which.
 */
export function isDeleteCircleWalletFundsAbort(message: string): boolean {
  return (
    message.includes('Identifier("njangi_circles")') &&
    /function_name:\s*Some\("delete_circle"\)\s*\},\s*6\)/.test(message)
  );
}

// ---------------------------------------------------------------------------
// Every balance a custody wallet holds, as the manage page shows it
// ---------------------------------------------------------------------------
//
// The manage page read the wallet twice, two different ways. The first load
// expected the nested `{ fields: { value } }` form of `CustodyWallet.balance`,
// so it read 0 whenever the RPC returned the plain string, and both paths
// counted a SUI security deposit only as a legacy `Coin<SUI>` object.
// Security deposits are stored as typed `dynamic_field<String, Balance<T>>`
// fields (the pre-v11 deposit path, njangi_custody.move), SUI included, so a
// SUI deposit showed on neither path. Both paths now use this reader.
//
// From package v11 on, a circle's security deposits are v11 deposit records
// in the same wallet: `dynamic_field<DepositBalanceKey { asset }, Balance<T>>`
// (njangi_custody::DepositBalanceKey). A circle created on v11 keeps its
// deposits only there, and converting an older circle moves its deposits
// there, so the reader counts both shapes.

export interface CustodyBalances {
  /** `CustodyWallet.balance`: SUI from the retired contribution rail. */
  suiMain: bigint;
  /**
   * SUI held as security deposits: the v11 deposit record for SUI, the typed
   * `Balance<SUI>` field, and any legacy `Coin<SUI>`.
   */
  suiDeposits: bigint;
  /**
   * The network's USDC: the v11 deposit record for USDC, the typed
   * `Balance<USDC>` field, and any legacy `Coin<USDC>`.
   */
  usdc: bigint;
  /**
   * The parts of `suiDeposits` and `usdc` held in v11 deposit records
   * (`DepositBalanceKey`). Those records hold security deposits only, so
   * callers can label them without estimating from member records (which v11
   * circles no longer fill).
   */
  suiDepositRecords: bigint;
  usdcDepositRecords: bigint;
}

type CustodyBalanceClient = Pick<SuiClient, 'getObject' | 'getDynamicFields'>;

/** A custody wallet carries a handful of fields; this only stops a runaway cursor. */
const MAX_CUSTODY_FIELD_PAGES = 20;
const FRAMEWORK_ADDRESS = normalizeSuiAddress('0x2');
const MOVE_STRING_TYPE = normalizeStructTag('0x1::string::String');
const SUI_TYPE = normalizeStructTag('0x2::sui::SUI');

/** T of a framework `0x2::<module>::<name><T>` type, normalized; null for anything else. */
function frameworkTypeParam(objectType: unknown, module: string, name: string): string | null {
  if (typeof objectType !== 'string') return null;
  try {
    const tag = parseStructTag(normalizeStructTag(objectType));
    if (tag.address !== FRAMEWORK_ADDRESS || tag.module !== module || tag.name !== name) return null;
    const [param] = tag.typeParams;
    return tag.typeParams.length === 1 && typeof param !== 'string' ? normalizeStructTag(param) : null;
  } catch {
    return null;
  }
}

/**
 * True for the name type of a v11 deposit record:
 * `<package>::njangi_custody::DepositBalanceKey`. The package is the version
 * of this lineage that defined the key (v11), which is a different id from
 * the lineage's original one. Only this lineage's njangi_custody module can
 * add fields to a CustodyWallet, so a field on the wallet whose name has this
 * type is one of its deposit records whatever the package address reads.
 */
function isDepositBalanceKeyType(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    const tag = parseStructTag(normalizeStructTag(value));
    return tag.module === 'njangi_custody' && tag.name === 'DepositBalanceKey' && tag.typeParams.length === 0;
  } catch {
    return false;
  }
}

/**
 * The coin type a v11 deposit record is keyed by. JSON-RPC renders the key as
 * `{ asset: [..bytes] }`, the bytes of the canonical type name without `0x`
 * (a `vector<u8>` inside a struct is an array of byte numbers). Null when it
 * does not decode to a coin type.
 */
function depositBalanceKeyCoinType(nameValue: unknown): string | null {
  if (!nameValue || typeof nameValue !== 'object' || Array.isArray(nameValue)) return null;
  const record = nameValue as { asset?: unknown; fields?: { asset?: unknown } };
  const asset = record.asset ?? record.fields?.asset;
  if (!Array.isArray(asset) || asset.length === 0) return null;
  if (!asset.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 0x7f)) return null;
  return normalizeCoinType(String.fromCharCode(...(asset as number[])));
}

function isMoveStringType(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    return normalizeStructTag(value) === MOVE_STRING_TYPE;
  } catch {
    return false;
  }
}

async function readObjectBalance(
  client: CustodyBalanceClient,
  objectId: string,
  key: 'value' | 'balance',
): Promise<bigint> {
  const response = await client.getObject({ id: objectId, options: { showContent: true } });
  const content = response.data?.content;
  const value =
    content && content.dataType === 'moveObject'
      ? readBalanceField((content.fields as Record<string, unknown>)[key])
      : null;
  if (value === null) throw new Error(`Custody balance object ${objectId} did not read as a balance`);
  return value;
}

/**
 * The wallet's SUI and USDC in base units. Throws when any read fails or
 * does not parse: a balance that could not be read is not zero. So does a
 * USDC type that is not a coin type (USDC unconfigured or malformed), which
 * would otherwise skip every USDC field and read as holding none.
 */
export async function readCustodyBalances(
  client: CustodyBalanceClient,
  walletId: string,
  usdcCoinType: string,
): Promise<CustodyBalances> {
  const usdcType = normalizeCoinType(usdcCoinType);
  if (!usdcType) {
    throw new Error(`Cannot read custody balances without a USDC coin type (got "${usdcCoinType}")`);
  }

  const wallet = await client.getObject({ id: walletId, options: { showContent: true } });
  const walletContent = wallet.data?.content;
  const suiMain =
    walletContent && walletContent.dataType === 'moveObject'
      ? readBalanceField((walletContent.fields as Record<string, unknown>).balance)
      : null;
  if (suiMain === null) throw new Error(`Custody wallet ${walletId} did not read`);

  const reads: Array<{ coin: 'sui' | 'usdc'; objectId: string; key: 'value' | 'balance'; record?: true }> = [];
  let cursor: string | null = null;
  for (let page = 0; ; page += 1) {
    if (page >= MAX_CUSTODY_FIELD_PAGES) {
      throw new Error(`Custody wallet ${walletId} lists more than ${MAX_CUSTODY_FIELD_PAGES} pages of fields`);
    }
    const listing: Awaited<ReturnType<SuiClient['getDynamicFields']>> = await client.getDynamicFields({
      parentId: walletId,
      cursor,
    });
    for (const entry of listing.data) {
      if (entry.type === 'DynamicField' && isDepositBalanceKeyType(entry.name?.type)) {
        // A v11 deposit record: the asset in its key and the Balance<T> it
        // holds must name the same coin. A record that does not read that
        // way is an unreadable balance, never zero.
        const keyCoinType = depositBalanceKeyCoinType(entry.name?.value);
        const valueCoinType = frameworkTypeParam(entry.objectType, 'balance', 'Balance');
        if (!keyCoinType || !valueCoinType || keyCoinType !== valueCoinType) {
          throw new Error(`Custody wallet ${walletId} holds a deposit record that did not read`);
        }
        if (keyCoinType === SUI_TYPE) reads.push({ coin: 'sui', objectId: entry.objectId, key: 'value', record: true });
        else if (keyCoinType === usdcType) reads.push({ coin: 'usdc', objectId: entry.objectId, key: 'value', record: true });
      } else if (entry.type === 'DynamicField') {
        // A typed balance is stored under its own coin type's name.
        const coinType = frameworkTypeParam(entry.objectType, 'balance', 'Balance');
        if (!coinType || !isMoveStringType(entry.name?.type)) continue;
        if (normalizeCoinType(entry.name?.value) !== coinType) continue;
        if (coinType === SUI_TYPE) reads.push({ coin: 'sui', objectId: entry.objectId, key: 'value' });
        else if (coinType === usdcType) reads.push({ coin: 'usdc', objectId: entry.objectId, key: 'value' });
      } else if (entry.type === 'DynamicObject') {
        const coinType = frameworkTypeParam(entry.objectType, 'coin', 'Coin');
        if (coinType === SUI_TYPE) reads.push({ coin: 'sui', objectId: entry.objectId, key: 'balance' });
        else if (coinType && coinType === usdcType) {
          reads.push({ coin: 'usdc', objectId: entry.objectId, key: 'balance' });
        }
      }
    }
    if (!listing.hasNextPage) break;
    if (!listing.nextCursor || listing.nextCursor === cursor) {
      throw new Error(`Custody wallet ${walletId} field listing stopped before its last page`);
    }
    cursor = listing.nextCursor;
  }

  const values = await Promise.all(reads.map((read) => readObjectBalance(client, read.objectId, read.key)));
  let suiDeposits = 0n;
  let usdc = 0n;
  let suiDepositRecords = 0n;
  let usdcDepositRecords = 0n;
  reads.forEach((read, index) => {
    if (read.coin === 'sui') {
      suiDeposits += values[index];
      if (read.record) suiDepositRecords += values[index];
    } else {
      usdc += values[index];
      if (read.record) usdcDepositRecords += values[index];
    }
  });
  return { suiMain, suiDeposits, usdc, suiDepositRecords, usdcDepositRecords };
}
