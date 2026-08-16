// custody-wallet-discovery.ts — find a circle's custody wallet without
// depending on event retention.
//
// Why this exists: every money-out path in recovery needs the CustodyWallet
// object id, and until 2026-08-15 the only way any page found it was querying
// the `CustodyWalletCreated` event. That event is served by exactly one RPC
// endpoint, and that endpoint's retention window is finite. The failure was
// observed live: a member-majority emergency stop had PASSED (2/2 votes on
// chain, execute_recovery accepted in simulation) and the UI could not submit
// it, because the creation event had aged out and `circle.custody` never
// resolved. Funds were reachable by the contract and unreachable through the
// product.
//
// The on-chain `wallet_id` dynamic field would be the clean answer, but
// njangi_circles.move:584 writes it as a PLACEHOLDER holding the circle's own
// id ("will be populated by wallet_id_updater") and nothing populates it in
// the normal create flow. Correcting that is a contract change gated on a
// testnet publish; this module makes the frontend robust either way.
//
// Three tiers, cheapest and most durable first, every candidate VALIDATED
// before use (object exists, is a `njangi_custody::CustodyWallet`, and its
// `circle_id` points back at this circle — so a wrong or stale pointer can
// mislabel nothing):
//
//   1. the `wallet_id` dynamic field  — one object read, served by every RPC,
//      immune to retention. Skipped while it still holds the placeholder.
//   2. `CustodyWalletCreated` events  — the historical path, kept as-is.
//   3. the caller's own transaction history — a member's security deposit
//      transaction takes the custody wallet as an input, and unlike the
//      events, `queryTransactionBlocks` by sender has answered for the whole
//      lifetime of the circles we tested. Anyone who ever deposited can
//      rediscover the wallet from their own signature trail.

import type { SuiClient } from '@mysten/sui/client';

// Deliberately NOT @mysten/sui's normalizeSuiObjectId: that helper does not
// strip an existing 0x prefix, so normalizing an already-prefixed id yields
// "0x0x…" — every comparison silently fails. Caught by the unit tests here.
const normalizeId = (value: string): string =>
  '0x' + value.toLowerCase().replace(/^0x/, '').padStart(64, '0');

const CLOCK_OBJECT_ID = normalizeId('0x6');
const CUSTODY_WALLET_TYPE_SUFFIX = '::njangi_custody::CustodyWallet';

/** Calls whose inputs are known to include the custody wallet. */
const CUSTODY_TOUCHING_FUNCTIONS = new Set([
  'member_deposit_security_deposit',
  'execute_recovery',
  'trigger_auto_release',
]);

export type CustodyDiscoverySource =
  | 'dynamic_field'
  | 'events'
  | 'transaction_history';

export interface CustodyWalletResolution {
  walletId: string;
  source: CustodyDiscoverySource;
}

/** Shape of the injected event reader (pages pass `queryEventsCached`). */
export type CustodyEventReader = (params: {
  query: { MoveEventType: string };
  limit: number;
}) => Promise<{ data: Array<{ parsedJson?: unknown }> }>;

export interface ResolveCustodyWalletArgs {
  client: SuiClient;
  circleId: string;
  packageId: string;
  /** Enables tier 3. Any address that has ever deposited into the circle. */
  userAddress?: string | null;
  /** Injected so pages reuse their cached read layer; defaults to the client. */
  queryEvents?: CustodyEventReader;
}

/**
 * True only for a real CustodyWallet whose circle_id points at `circleId`.
 * Every tier funnels through this, which is what makes the tier-3 heuristic
 * safe: a wrong candidate cannot validate.
 */
export async function isCustodyWalletForCircle(
  client: SuiClient,
  walletId: string,
  circleId: string,
): Promise<boolean> {
  try {
    const obj = await client.getObject({
      id: walletId,
      options: { showType: true, showContent: true },
    });
    const type = obj.data?.type ?? '';
    if (!type.endsWith(CUSTODY_WALLET_TYPE_SUFFIX)) return false;

    const content = obj.data?.content;
    if (!content || content.dataType !== 'moveObject') return false;
    const fields = content.fields as { circle_id?: string };
    return (
      typeof fields.circle_id === 'string' &&
      normalizeId(fields.circle_id) === normalizeId(circleId)
    );
  } catch {
    return false;
  }
}

async function fromDynamicField(
  client: SuiClient,
  circleId: string,
): Promise<string | null> {
  try {
    const field = await client.getDynamicFieldObject({
      parentId: circleId,
      name: { type: '0x1::string::String', value: 'wallet_id' },
    });
    const content = field.data?.content;
    if (!content || content.dataType !== 'moveObject') return null;
    const value = (content.fields as { value?: string }).value;
    if (typeof value !== 'string') return null;
    // The create flow seeds this field with the circle's OWN id as a
    // placeholder. Treat that as "not set" rather than a candidate.
    if (normalizeId(value) === normalizeId(circleId)) return null;
    return value;
  } catch {
    return null;
  }
}

async function fromEvents(
  args: Required<Pick<ResolveCustodyWalletArgs, 'client' | 'circleId' | 'packageId'>> &
    Pick<ResolveCustodyWalletArgs, 'queryEvents'>,
): Promise<string | null> {
  try {
    const read: CustodyEventReader =
      args.queryEvents ??
      ((params) => args.client.queryEvents(params) as ReturnType<CustodyEventReader>);
    const events = await read({
      query: {
        MoveEventType: `${args.packageId}::njangi_custody::CustodyWalletCreated`,
      },
      limit: 50,
    });
    const hit = events.data.find((event) => {
      const parsed = event.parsedJson as { circle_id?: string } | undefined;
      return (
        typeof parsed?.circle_id === 'string' &&
        normalizeId(parsed.circle_id) === normalizeId(args.circleId)
      );
    });
    const walletId = (hit?.parsedJson as { wallet_id?: string } | undefined)?.wallet_id;
    return typeof walletId === 'string' ? walletId : null;
  } catch {
    return null;
  }
}

async function fromTransactionHistory(
  client: SuiClient,
  circleId: string,
  userAddress: string,
): Promise<string[]> {
  try {
    const page = await client.queryTransactionBlocks({
      filter: { FromAddress: userAddress },
      options: { showInput: true },
      limit: 50,
      order: 'descending',
    });

    const normalizedCircle = normalizeId(circleId);
    const candidates: string[] = [];

    for (const tx of page.data) {
      const data = tx.transaction?.data?.transaction;
      if (!data || data.kind !== 'ProgrammableTransaction') continue;

      const touchesCustody = data.transactions.some((command) => {
        const call = (command as { MoveCall?: { function?: string } }).MoveCall;
        return !!call?.function && CUSTODY_TOUCHING_FUNCTIONS.has(call.function);
      });
      if (!touchesCustody) continue;

      const objectIds = data.inputs
        .map((input) => (input as { objectId?: string }).objectId)
        .filter((id): id is string => typeof id === 'string')
        .map(normalizeId);

      if (!objectIds.includes(normalizedCircle)) continue;

      for (const id of objectIds) {
        if (id === normalizedCircle || id === CLOCK_OBJECT_ID) continue;
        if (!candidates.includes(id)) candidates.push(id);
      }
    }
    return candidates;
  } catch {
    return [];
  }
}

/**
 * Resolve the custody wallet for a circle, or null if every tier fails.
 *
 * Null must be handled as "unresolved", not "the circle has no wallet" —
 * gate the actions that need it, and say why they are gated.
 */
export async function resolveCustodyWalletId(
  args: ResolveCustodyWalletArgs,
): Promise<CustodyWalletResolution | null> {
  const { client, circleId, packageId, userAddress } = args;

  const fromField = await fromDynamicField(client, circleId);
  if (fromField && (await isCustodyWalletForCircle(client, fromField, circleId))) {
    return { walletId: fromField, source: 'dynamic_field' };
  }

  const fromEvent = await fromEvents({ client, circleId, packageId, queryEvents: args.queryEvents });
  if (fromEvent && (await isCustodyWalletForCircle(client, fromEvent, circleId))) {
    return { walletId: fromEvent, source: 'events' };
  }

  if (userAddress) {
    for (const candidate of await fromTransactionHistory(client, circleId, userAddress)) {
      if (await isCustodyWalletForCircle(client, candidate, circleId)) {
        return { walletId: candidate, source: 'transaction_history' };
      }
    }
  }

  return null;
}
