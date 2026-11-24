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
// events) come back whole, as one page.
//
// Hand it only to code that reads. Transactions are built, signed and
// confirmed by the signing client (signing-sui-client.ts), unchanged.
// Methods not listed here (getTransactionBlock, queryTransactionBlocks,
// getOwnedObjects, …) are the pooled client's own, still JSON-RPC.

import type { SuiClient } from '@mysten/sui/client';
import { getCurrentNetwork, type NetworkType } from '@/services/network-config';
import { getPooledSuiClient } from '@/services/sui-rpc-failover';
import { V2_READS_KEY, type V2Reads } from './tx-transport';
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

const readingClients = new Map<NetworkType, SuiClient>();

/** The read-only client for `network` (default: the current one). */
export function getReadingSuiClient(network?: NetworkType): SuiClient {
  const net = network ?? getCurrentNetwork();
  const existing = readingClients.get(net);
  if (existing) return existing;

  const pooled = getPooledSuiClient({ network: net });
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
  const queryEvents: Method<'queryEvents'> = ({ query, order }) =>
    queryEventsCached({ query, ...(order ? { order } : {}) }, opts);
  // The 2.x coin pages carry the fields readers use (coinObjectId, balance, paging).
  const getCoins: Method<'getCoins'> = async (input) =>
    (await reads.getCoins(input)) as unknown as Awaited<ReturnType<SuiClient['getCoins']>>;
  const getBalance: Method<'getBalance'> = async (input) =>
    (await reads.getBalance(input)) as unknown as Awaited<ReturnType<SuiClient['getBalance']>>;
  const waitForTransaction: Method<'waitForTransaction'> = async ({ digest, timeout }) => {
    const transports = await (await loadV2()).v2TxTransports(net);
    let lastError: unknown;
    for (const transport of transports) {
      try {
        return (await transport.waitForTransaction(digest, timeout ? { timeoutMs: timeout } : undefined)) as unknown as Awaited<
          ReturnType<SuiClient['waitForTransaction']>
        >;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError ?? new Error(`[reading-client] ${digest} was not confirmed`);
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
  readingClients.set(net, client);
  return client;
}

/** Drops the cached clients (tests, network switches). */
export function clearReadingSuiClients(): void {
  readingClients.clear();
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
