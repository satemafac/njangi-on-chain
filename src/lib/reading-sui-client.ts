// reading-sui-client.ts — a SuiClient for code that only READS, served off
// JSON-RPC.
//
// Many shared helpers take a 1.x `SuiClient` and call its read methods
// (custody-wallet-discovery.ts, circle-config.ts, custody-wallet-balance.ts,
// membership-discovery.ts, v11-circle-tx.ts reads, wait-for-tx-indexed.ts).
// Testnet JSON-RPC is gone, so on the pooled client those reads fail. This
// client is the pooled one with its read methods routed through the shared
// read layer (sui-read.ts: Sui gRPC, then GraphQL; events from GraphQL), in
// the JSON-RPC shapes the helpers already parse. Lists (dynamic fields,
// events) come back whole, as one page, except that queryEvents given a
// cursor or a limit pages over that whole list: it starts after the cursor's
// event, stops at the limit, and throws for a cursor the list does not hold.
//
// Hand it only to code that reads. Transactions are built, signed and
// confirmed by the signing client (signing-sui-client.ts), unchanged.
// Methods not listed here (getTransactionBlock, queryTransactionBlocks,
// getOwnedObjects, …) are the pooled client's own, still JSON-RPC.

import type { EventId, PaginatedEvents, SuiClient, SuiEventFilter } from '@mysten/sui/client';
import { getCurrentNetwork, type NetworkType } from '@/services/network-config';
import { getPooledSuiClient } from '@/services/sui-rpc-failover';
import { V2_READS_KEY, type V2Reads } from './tx-transport';
import { attachedV2ReadSource } from './v2-read-source';
import {
  listDynamicFields,
  queryEventsCached,
  readDynamicFieldObject,
  readObject,
  readObjects,
} from './sui-read';

// Lazy: @mysten/sui 2.x loads on the first read that needs it.
const loadV2 = () => import('./v2-sui-client');

function lazyV2Reads(network: NetworkType): V2Reads {
  const reads = async () => (await loadV2()).v2Reads(network);
  return {
    getCoins: async (input) => (await reads()).getCoins(input),
    getBalance: async (input) => (await reads()).getBalance(input),
    dynamicFieldValueJson: async (parentId, suffix) => (await reads()).dynamicFieldValueJson(parentId, suffix),
  };
}

type Method<K extends keyof SuiClient> = SuiClient[K] extends (...args: infer A) => infer R ? (...args: A) => R : never;

/**
 * The page of `whole` (every matching event, in the order asked for, as the
 * read layer returns it) that starts right after the event `cursor` names and
 * holds at most `limit` events. Throws rather than guess when `whole` is not
 * the whole list, when the cursor is not among its events, or when `limit` is
 * not a positive integer. nextCursor is the last event returned, or `cursor`
 * when none is, so a caller that stores it never falls back to the start.
 */
function pageOfEvents(
  query: SuiEventFilter,
  whole: PaginatedEvents,
  cursor: EventId | null,
  limit: number | null,
): PaginatedEvents {
  const what = `events ${JSON.stringify(query)}`;
  if (!Array.isArray(whole?.data) || whole.hasNextPage !== false) {
    throw new Error(`[reading-client] ${what} did not come back whole, so they cannot be paged`);
  }
  if (limit !== null && (!Number.isInteger(limit) || limit <= 0)) {
    throw new Error(`[reading-client] ${what}: limit ${String(limit)} is not a positive integer`);
  }
  let start = 0;
  if (cursor !== null) {
    const at = whole.data.findIndex(
      (event) => event?.id?.txDigest === cursor.txDigest && event?.id?.eventSeq === cursor.eventSeq,
    );
    if (at < 0) {
      throw new Error(`[reading-client] ${what}: cursor ${cursor.txDigest}#${cursor.eventSeq} is not among the events read`);
    }
    start = at + 1;
  }
  const end = limit === null ? whole.data.length : Math.min(whole.data.length, start + limit);
  const data = whole.data.slice(start, end);
  const last = data[data.length - 1];
  return { data, hasNextPage: end < whole.data.length, nextCursor: last ? last.id : cursor };
}

// Keyed by the pooled client it wraps, so a new pooled client gets a new wrapper.
let readingClients = new WeakMap<object, SuiClient>();

/**
 * The read-only client for `network` (default: the current one). A pooled
 * client without a 2.x read source (a test's stub) is returned as it is,
 * as sui-read.ts keeps JSON-RPC for one.
 */
export function getReadingSuiClient(network?: NetworkType): SuiClient {
  const net = network ?? getCurrentNetwork();
  const pooled = getPooledSuiClient({ network: net });
  if (!attachedV2ReadSource(pooled)) return pooled;
  const existing = readingClients.get(pooled);
  if (existing) return existing;

  const opts = { network: net };
  const reads = lazyV2Reads(net);

  const getObject: Method<'getObject'> = ({ id, options }) => readObject(id, options ?? {}, opts);
  const multiGetObjects: Method<'multiGetObjects'> = ({ ids, options }) => readObjects(ids, options ?? {}, opts);
  const getDynamicFields: Method<'getDynamicFields'> = async ({ parentId }) =>
    ({
      data: await listDynamicFields(parentId, opts),
      hasNextPage: false,
      nextCursor: null,
    }) as unknown as Awaited<ReturnType<SuiClient['getDynamicFields']>>;
  const getDynamicFieldObject: Method<'getDynamicFieldObject'> = ({ parentId, name }) =>
    readDynamicFieldObject(parentId, name, opts);
  // Reads the whole list as before (read failures propagate unchanged); a
  // cursor or a limit then pages over it (pageOfEvents), so a cron resuming
  // from its stored id gets only what came after it.
  const queryEvents: Method<'queryEvents'> = async ({ query, cursor, limit, order }) => {
    const whole = await queryEventsCached({ query, ...(order ? { order } : {}) }, opts);
    if (cursor == null && limit == null) return whole;
    return pageOfEvents(query, whole, cursor ?? null, limit ?? null);
  };
  // The 2.x coin pages carry the fields readers use (coinObjectId, balance, paging).
  const getCoins: Method<'getCoins'> = async (input) =>
    (await reads.getCoins(input)) as unknown as Awaited<ReturnType<SuiClient['getCoins']>>;
  const getBalance: Method<'getBalance'> = async (input) =>
    (await reads.getBalance(input)) as unknown as Awaited<ReturnType<SuiClient['getBalance']>>;
  // Resolves once BOTH Sui transports have the transaction. The fullnode
  // (gRPC) sees it first, but the refresh that follows reads GraphQL first
  // (circle-config.ts, every event list), and GraphQL indexes a little later:
  // waiting on gRPC alone let the old tally, delegate or "Execute" button
  // come back. Throws when GraphQL has not indexed it in time
  // (waitForTxIndexed then refreshes anyway, as before).
  const waitForTransaction: Method<'waitForTransaction'> = async ({ digest, timeout }) => {
    const [grpc, graphql] = await (await loadV2()).v2TxTransports(net);
    const deadline = Date.now() + (timeout ?? 60_000);
    let confirmed: unknown;
    try {
      confirmed = await grpc.waitForTransaction(digest, { timeoutMs: Math.max(1_000, deadline - Date.now()) });
    } catch {
      // GraphQL below decides.
    }
    const indexed = await graphql.waitForTransaction(digest, { timeoutMs: Math.max(1_000, deadline - Date.now()) });
    return (confirmed ?? indexed) as Awaited<ReturnType<SuiClient['waitForTransaction']>>;
  };

  const overrides: Record<PropertyKey, unknown> = {
    getObject,
    multiGetObjects,
    getDynamicFields,
    getDynamicFieldObject,
    queryEvents,
    getCoins,
    getBalance,
    waitForTransaction,
    // v11-circle-tx.ts reads the asset policy through these when present.
    [V2_READS_KEY]: reads,
  };
  const client = new Proxy(pooled, {
    get(target, prop) {
      if (Object.prototype.hasOwnProperty.call(overrides, prop)) return overrides[prop];
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  readingClients.set(pooled, client);
  return client;
}

/** Drops the cached clients (tests). */
export function clearReadingSuiClients(): void {
  readingClients = new WeakMap();
}

/**
 * `owner`'s whole balance of `coinType` (default SUI), off JSON-RPC (2.x
 * `getBalance`, gRPC then GraphQL). Throws when it cannot be read: a failed
 * read is not a zero balance.
 */
export async function readBalance(
  owner: string,
  coinType?: string | null,
  network?: NetworkType,
): Promise<{ coinType: string; totalBalance: string; coinObjectCount: number }> {
  const balance = await getReadingSuiClient(network).getBalance({ owner, ...(coinType ? { coinType } : {}) });
  if (typeof balance?.totalBalance !== 'string' || !/^\d+$/.test(balance.totalBalance)) {
    throw new Error(`[reading-client] balance of ${owner} (${coinType ?? 'SUI'}) could not be read`);
  }
  return { coinType: balance.coinType, totalBalance: balance.totalBalance, coinObjectCount: balance.coinObjectCount };
}
