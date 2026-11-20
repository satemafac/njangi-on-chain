// signing-sui-client.ts — the client every signing path builds and submits with.
//
// It is the pooled 1.x client (sui-rpc-failover.ts) with two additions:
//   - a transaction transport (tx-transport.ts) that builds, submits and
//     confirms through Sui's gRPC, then GraphQL, then JSON-RPC, so signing
//     no longer depends on a JSON-RPC provider surviving;
//   - the coin reads the payment builders make (`getCoins`, `getBalance`),
//     served the same way. Every other method is the pooled client's own.
//
// Failing over a submission is safe. A retry carries the same signed bytes,
// hence the same digest, and Sui executes a digest at most once: the next
// endpoint either lands it or answers with the effects already recorded.
// Nothing can be paid twice, which is not true of a user who retries by hand
// after an error and signs a fresh transaction.

import type { SuiClient } from '@mysten/sui/client';
import { getCurrentNetwork, type NetworkType } from '@/services/network-config';
import { getPooledSuiClient } from '@/services/sui-rpc-failover';
import {
  failoverTxTransport,
  jsonRpcTxTransport,
  TX_TRANSPORT_KEY,
  V2_READS_KEY,
  type TxTransport,
  type V2Reads,
} from './tx-transport';
import { isTxTransportError } from './v2-tx-mapping';

// Lazy: @mysten/sui 2.x loads on the first signature, not with the page.
const loadV2 = () => import('./v2-sui-client');

function lazyV2Transport(network: NetworkType, index: 0 | 1): TxTransport {
  const resolve = async () => (await (await loadV2()).v2TxTransports(network))[index];
  return {
    name: index === 0 ? 'v2-grpc' : 'v2-graphql',
    build: async (tx, opts) => (await resolve()).build(tx, opts),
    execute: async (bytes, signature) => (await resolve()).execute(bytes, signature),
    waitForTransaction: async (digest, opts) => (await resolve()).waitForTransaction(digest, opts),
  };
}

function lazyV2Reads(network: NetworkType): V2Reads {
  const reads = async () => (await loadV2()).v2Reads(network);
  return {
    getCoins: async (input) => (await reads()).getCoins(input),
    getBalance: async (input) => (await reads()).getBalance(input),
    dynamicFieldValueJson: async (parentId, suffix) => (await reads()).dynamicFieldValueJson(parentId, suffix),
  };
}

async function v2ThenJsonRpc<T>(what: string, v2: () => Promise<T>, jsonRpc: () => Promise<T>): Promise<T> {
  try {
    return await v2();
  } catch (error) {
    if (!isTxTransportError(error)) throw error;
    console.warn(`[signing-client] ${what} via 2.x failed, using JSON-RPC:`, error instanceof Error ? error.message : error);
    return jsonRpc();
  }
}

export function getSigningSuiClient(network?: NetworkType): SuiClient {
  const net = network ?? getCurrentNetwork();
  const pooled = getPooledSuiClient({ network: net });
  const reads = lazyV2Reads(net);
  const overrides: Record<PropertyKey, unknown> = {
    [TX_TRANSPORT_KEY]: failoverTxTransport(
      [lazyV2Transport(net, 0), lazyV2Transport(net, 1), jsonRpcTxTransport(pooled)],
      isTxTransportError,
    ),
    [V2_READS_KEY]: reads,
    // The 2.x pages carry the fields the builders read (coinObjectId, balance,
    // paging), not every JSON-RPC field, hence the casts.
    getCoins: (input: Parameters<SuiClient['getCoins']>[0]) =>
      v2ThenJsonRpc(
        'getCoins',
        async () => (await reads.getCoins(input)) as unknown as Awaited<ReturnType<SuiClient['getCoins']>>,
        () => pooled.getCoins(input),
      ),
    getBalance: (input: Parameters<SuiClient['getBalance']>[0]) =>
      v2ThenJsonRpc(
        'getBalance',
        async () => (await reads.getBalance(input)) as unknown as Awaited<ReturnType<SuiClient['getBalance']>>,
        () => pooled.getBalance(input),
      ),
  };
  return new Proxy(pooled, {
    get(target, prop) {
      if (Object.prototype.hasOwnProperty.call(overrides, prop)) return overrides[prop];
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
