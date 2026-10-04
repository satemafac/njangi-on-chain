// recovery-coin-type.ts — the CoinType argument for
// `njangi_circles::execute_recovery<CoinType>` and
// `trigger_auto_release<CoinType>`.
//
// The contract uses CoinType in exactly two places (execute_recovery_internal,
// njangi_circles.move):
//   1. assert!(custody::get_stablecoin_balance<CoinType>(wallet) >= total_stablecoin_refund)
//   2. custody::withdraw_stablecoin_for_recovery<CoinType>(...), only for a
//      member whose stablecoin refund is above zero.
// `get_stablecoin_balance<CoinType>` (njangi_custody.move) adds up two reads:
//   - the typed `dynamic_field<String, Balance<CoinType>>` keyed by CoinType's
//     own type name, counted as 0 when absent, so a type the wallet has no
//     field for reads zero instead of aborting;
//   - the legacy `dynamic_object_field` named "coin_objects". It is found by
//     NAME only and then borrowed as `Coin<CoinType>`, so while it exists
//     every other type argument aborts.
//
// The rule this module implements:
//   1. The wallet holds a stablecoin (a typed Balance<T> field, or the legacy
//      Coin<T> field): pass T. The legacy field's T wins, because the contract
//      borrows that field as Coin<CoinType> whatever else the wallet holds.
//   2. The wallet holds no stablecoin, and every read said so: every type
//      reads a zero balance, so the call passes exactly when the stablecoin
//      refund total is zero, and then nothing is withdrawn in CoinType. The
//      type only has to exist on chain, so use the network's configured USDC
//      (`coinTypes.USDC`). Not SUI: the wallet keeps its SUI in a typed
//      Balance<SUI> field, which a SUI type argument would let a stablecoin
//      refund draw on. Not testnet `tokens.USDC` either: its package
//      (0x9e89…) does not exist on chain, so the transaction would not build.
//   3. Any failed read is an error, never the fallback: "couldn't read the
//      wallet" is not "the wallet holds no stablecoin".
// Holdings no single type argument can refund — two different stablecoins, or
// a legacy SUI coin next to a stablecoin — are refused rather than guessed:
// the contract pays every member's stablecoin refund in CoinType, so the
// members who paid in the other coin would be refunded in the wrong one.
//
// Two facts about the legacy field for whoever touches this next. Recovery
// also reads it as Coin<SUI> (get_total_wallet_balance) before CoinType is
// used, so a legacy field holding any other coin aborts every recovery
// whatever the type argument. And no testnet custody wallet can have one: the
// lineage's original package (2026-06-12) postdates the move to typed Balance
// storage (2026-03), and nothing creates the field any more (all 10 wallets
// checked 2026-10-03). Covering it costs little, so the rule still does.
//
// Before 2026-10-03 the circle page read the type with
// resolveCustodyStablecoinType, which returned null both when the wallet held
// no stablecoin and when the read failed. A circle whose members all paid in
// SUI therefore hit "Stablecoin type is unavailable" and could neither execute
// a passed emergency stop nor trigger auto-release.

import type { SuiClient } from '@mysten/sui/client';
import { normalizeStructTag, normalizeSuiAddress, parseStructTag } from '@mysten/sui/utils';
import { isV11AssetTermsEnabled } from '@/config/feature-flags';
import { readCircleAssetPolicy } from '@/lib/v11-circle-tx';

const FRAMEWORK_ADDRESS = normalizeSuiAddress('0x2');
const SUI_COIN_TYPE = normalizeStructTag('0x2::sui::SUI');
const MOVE_STRING_TYPE = normalizeStructTag('0x1::string::String');

/** Key of the pre-2026-03 storage: one Coin<T> object for the whole wallet. */
const LEGACY_COIN_FIELD = 'coin_objects';

/** A custody wallet carries a handful of fields; this only stops a runaway cursor. */
const MAX_FIELD_PAGES = 20;

const STRUCT_TAG_SHAPE =
  /^(?:0x)?[0-9a-fA-F]{1,64}::[A-Za-z_][A-Za-z0-9_]*::[A-Za-z_][A-Za-z0-9_]*(?:<.+>)?$/;

export type RecoveryCoinTypeErrorReason = 'read_failed' | 'ambiguous_holdings';

export class RecoveryCoinTypeError extends Error {
  readonly reason: RecoveryCoinTypeErrorReason;

  constructor(reason: RecoveryCoinTypeErrorReason, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'RecoveryCoinTypeError';
    this.reason = reason;
  }
}

export interface CustodyCoinHoldings {
  /**
   * Every non-SUI coin type the wallet holds, from its typed Balance<T> fields
   * and its legacy Coin<T> field. Normalized, deduplicated, sorted.
   */
  stablecoinTypes: string[];
  /** T of the legacy `coin_objects` Coin<T> field (SUI included), or null when absent. */
  legacyCoinType: string | null;
}

export type RecoveryCoinTypeSource =
  | 'legacy_coin'
  | 'stablecoin_balance'
  | 'no_stablecoin'
  // v11: the circle's pinned settlement coin (NEXT_PUBLIC_V11_ENABLED).
  | 'pinned_terms';

export interface RecoveryCoinType {
  coinType: string;
  source: RecoveryCoinTypeSource;
}

/** Normalized `address::module::Name<…>`, or null for anything that isn't one. */
function normalizeTypeTag(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!STRUCT_TAG_SHAPE.test(trimmed)) return null;
  try {
    return normalizeStructTag(trimmed);
  } catch {
    return null;
  }
}

/** T of a framework `0x2::<module>::<name><T>` type, normalized; null for anything else. */
function frameworkTypeParam(objectType: unknown, module: string, name: string): string | null {
  const normalized = normalizeTypeTag(objectType);
  if (!normalized) return null;
  const tag = parseStructTag(normalized);
  if (tag.address !== FRAMEWORK_ADDRESS || tag.module !== module || tag.name !== name) return null;
  if (tag.typeParams.length !== 1) return null;
  const [param] = tag.typeParams;
  return typeof param === 'string' ? null : normalizeStructTag(param);
}

function isLegacyCoinFieldName(name: unknown): boolean {
  const value = (name as { value?: unknown } | null | undefined)?.value;
  if (value === LEGACY_COIN_FIELD) return true;
  // The JSON-RPC reports a dynamic object field's name unwrapped; accept the
  // `dynamic_object_field::Wrapper { name }` shape too, so a reader that keeps
  // the wrapper cannot hide the one field that pins the type argument.
  return (value as { name?: unknown } | null | undefined)?.name === LEGACY_COIN_FIELD;
}

/**
 * Lists every dynamic field of the custody wallet, all pages, and reports the
 * coins it holds as `get_stablecoin_balance` sees them. Throws
 * RecoveryCoinTypeError('read_failed') when the listing cannot be read in
 * full: an incomplete listing proves nothing about what the wallet holds.
 */
export async function readCustodyCoinHoldings(
  client: Pick<SuiClient, 'getDynamicFields'>,
  walletId: string,
): Promise<CustodyCoinHoldings> {
  const stablecoins = new Set<string>();
  let legacyCoinType: string | null = null;
  let cursor: string | null = null;

  for (let pageCount = 0; ; pageCount += 1) {
    if (pageCount >= MAX_FIELD_PAGES) {
      throw new RecoveryCoinTypeError(
        'read_failed',
        `Custody wallet ${walletId} lists more than ${MAX_FIELD_PAGES} pages of dynamic fields`,
      );
    }

    let page: Awaited<ReturnType<SuiClient['getDynamicFields']>>;
    try {
      page = await client.getDynamicFields({ parentId: walletId, cursor });
    } catch (error) {
      throw new RecoveryCoinTypeError(
        'read_failed',
        `Could not list the dynamic fields of custody wallet ${walletId}`,
        error,
      );
    }
    if (!page || !Array.isArray(page.data)) {
      throw new RecoveryCoinTypeError(
        'read_failed',
        `Malformed dynamic field page for custody wallet ${walletId}`,
      );
    }

    for (const entry of page.data) {
      if (entry.type === 'DynamicObject' && isLegacyCoinFieldName(entry.name)) {
        const coinType = frameworkTypeParam(entry.objectType, 'coin', 'Coin');
        if (!coinType) {
          // The contract will borrow this field as Coin<CoinType>; without its
          // T there is no type argument that is known not to abort.
          throw new RecoveryCoinTypeError(
            'read_failed',
            `Legacy coin field of custody wallet ${walletId} holds an unrecognized object: ${String(entry.objectType)}`,
          );
        }
        legacyCoinType = coinType;
        if (coinType !== SUI_COIN_TYPE) stablecoins.add(coinType);
        continue;
      }

      if (entry.type !== 'DynamicField') continue;
      if (normalizeTypeTag(entry.name?.type) !== MOVE_STRING_TYPE) continue;
      const coinType = frameworkTypeParam(entry.objectType, 'balance', 'Balance');
      // Only a Balance<T> stored under T's own type name is one that
      // get_stablecoin_balance<T> reads (the key is unprefixed on chain).
      if (!coinType || normalizeTypeTag(entry.name?.value) !== coinType) continue;
      if (coinType !== SUI_COIN_TYPE) stablecoins.add(coinType);
    }

    if (!page.hasNextPage) break;
    if (!page.nextCursor || page.nextCursor === cursor) {
      throw new RecoveryCoinTypeError(
        'read_failed',
        `Dynamic field listing of custody wallet ${walletId} stopped before its last page`,
      );
    }
    cursor = page.nextCursor;
  }

  return { stablecoinTypes: Array.from(stablecoins).sort(), legacyCoinType };
}

/**
 * The rule itself (see the header), on holdings that were read in full.
 * `fallbackCoinType` is the network's configured USDC — `coinTypes.USDC`.
 */
export function chooseRecoveryCoinType(
  holdings: CustodyCoinHoldings,
  fallbackCoinType: string,
): RecoveryCoinType {
  const { stablecoinTypes, legacyCoinType } = holdings;

  if (stablecoinTypes.length > 1) {
    throw new RecoveryCoinTypeError(
      'ambiguous_holdings',
      `Custody wallet holds more than one stablecoin: ${stablecoinTypes.join(', ')}`,
    );
  }

  if (legacyCoinType) {
    if (legacyCoinType === SUI_COIN_TYPE && stablecoinTypes.length > 0) {
      throw new RecoveryCoinTypeError(
        'ambiguous_holdings',
        `Custody wallet holds a legacy SUI coin next to ${stablecoinTypes[0]}`,
      );
    }
    return { coinType: legacyCoinType, source: 'legacy_coin' };
  }

  if (stablecoinTypes.length === 1) {
    return { coinType: stablecoinTypes[0], source: 'stablecoin_balance' };
  }

  const fallback = fallbackCoinType.trim();
  const normalizedFallback = normalizeTypeTag(fallback);
  if (!normalizedFallback || normalizedFallback === SUI_COIN_TYPE) {
    throw new Error(`No usable USDC coin type is configured for this network (got "${fallbackCoinType}")`);
  }
  return { coinType: fallback, source: 'no_stablecoin' };
}

/**
 * Reads the wallet, then applies the rule. Throws instead of guessing.
 *
 * v11 (NEXT_PUBLIC_V11_ENABLED): a circle with pinned asset terms refunds
 * from its v11 deposit records, one asset per call, so the type argument is
 * the circle's pinned settlement coin, whatever else legacy storage holds.
 * A circle without pinned terms keeps the wallet-holdings rule above.
 */
export async function resolveRecoveryCoinType(
  client: Pick<SuiClient, 'getDynamicFields' | 'getObject'>,
  walletId: string,
  fallbackCoinType: string,
): Promise<RecoveryCoinType> {
  if (isV11AssetTermsEnabled()) {
    const pinned = await readPinnedSettlementCoinType(client, walletId);
    if (pinned) return { coinType: pinned, source: 'pinned_terms' };
  }
  return chooseRecoveryCoinType(await readCustodyCoinHoldings(client, walletId), fallbackCoinType);
}

/** The settlement coin pinned by the circle this wallet is bound to, or null. */
async function readPinnedSettlementCoinType(
  client: Pick<SuiClient, 'getDynamicFields' | 'getObject'>,
  walletId: string,
): Promise<string | null> {
  let circleId: string | null = null;
  try {
    const wallet = await client.getObject({ id: walletId, options: { showContent: true } });
    const content = wallet.data?.content;
    const fields = content && 'fields' in content ? (content.fields as Record<string, unknown>) : null;
    circleId = typeof fields?.circle_id === 'string' ? fields.circle_id : null;
  } catch (error) {
    throw new RecoveryCoinTypeError('read_failed', `Could not read custody wallet ${walletId}`, error);
  }
  if (!circleId) {
    throw new RecoveryCoinTypeError('read_failed', `Custody wallet ${walletId} names no circle`);
  }

  let policy: Awaited<ReturnType<typeof readCircleAssetPolicy>>;
  try {
    policy = await readCircleAssetPolicy(client, circleId);
  } catch (error) {
    throw new RecoveryCoinTypeError('read_failed', `Could not read the asset terms of circle ${circleId}`, error);
  }
  if (!policy) return null;
  if (normalizeSuiAddress(policy.walletId) !== normalizeSuiAddress(walletId)) return null;
  return normalizeTypeTag(policy.settlement.coinType);
}

/** What the recovery controls say when there is no type argument to sign with. */
export function recoveryCoinTypeErrorMessage(error: unknown): string {
  if (error instanceof RecoveryCoinTypeError && error.reason === 'ambiguous_holdings') {
    return "The circle's wallet holds coins this app can't refund in one step, so nothing was sent. Please contact support.";
  }
  if (error instanceof RecoveryCoinTypeError) {
    return "We couldn't read the circle's wallet just now, so nothing was sent. Please try again in a moment.";
  }
  return "We couldn't prepare the refund, so nothing was sent. Please try again in a moment.";
}
