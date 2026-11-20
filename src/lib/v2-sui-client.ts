// v2-sui-client.ts — the only module that loads @mysten/sui 2.x (installed as
// `@mysten/sui-v2`). It is ESM-only and needs Node 22+, so it is imported
// lazily, on the first signature, never at page load or in Jest.
//
// gRPC first (Sui's own fullnodes: fast, current state, no history), GraphQL
// second (graphql.<net>.sui.io: full history). Both are keyless, answer
// browsers (CORS *), and return identical object JSON (checked 2026-10-17,
// docs/testnet-rpc-after-publicnode.md).

import type { Transaction } from '@mysten/sui/transactions';
import { getGraphqlUrlForNetwork, type NetworkType } from '@/services/network-config';
import type { TxTransport, V2Reads } from './tx-transport';
import {
  isTxTransportError,
  toDryRunError,
  toJsonRpcBalance,
  toJsonRpcCoinPage,
  toJsonRpcExecution,
  type V2TransactionResult,
} from './v2-tx-mapping';

// Statically referenced so Next inlines them into the browser bundle.
const GRPC_URLS: Record<NetworkType, string> = {
  testnet: process.env.NEXT_PUBLIC_TESTNET_GRPC_URL || 'https://fullnode.testnet.sui.io:443',
  mainnet: process.env.NEXT_PUBLIC_MAINNET_GRPC_URL || 'https://fullnode.mainnet.sui.io:443',
};

type V2Client = import('@mysten/sui-v2/grpc').SuiGrpcClient | import('@mysten/sui-v2/graphql').SuiGraphQLClient;
type V2TransactionClass = typeof import('@mysten/sui-v2/transactions').Transaction;

interface V2Endpoint {
  name: string;
  client: V2Client;
}

let modules: Promise<{ Transaction: V2TransactionClass; endpointsFor: (network: NetworkType) => V2Endpoint[] }> | null =
  null;

function loadV2() {
  modules ??= Promise.all([
    import('@mysten/sui-v2/transactions'),
    import('@mysten/sui-v2/grpc'),
    import('@mysten/sui-v2/graphql'),
  ]).then(([tx, grpc, graphql]) => {
    const cache = new Map<NetworkType, V2Endpoint[]>();
    return {
      Transaction: tx.Transaction,
      endpointsFor(network: NetworkType) {
        let endpoints = cache.get(network);
        if (!endpoints) {
          endpoints = [
            { name: 'grpc', client: new grpc.SuiGrpcClient({ baseUrl: GRPC_URLS[network], network }) },
            {
              name: 'graphql',
              client: new graphql.SuiGraphQLClient({ url: getGraphqlUrlForNetwork(network), network }),
            },
          ];
          cache.set(network, endpoints);
        }
        return endpoints;
      },
    };
  });
  return modules;
}

function transportFor(endpoint: V2Endpoint, Tx2: V2TransactionClass): TxTransport {
  const { client } = endpoint;
  return {
    name: `v2-${endpoint.name}`,
    async build(tx: Transaction, opts) {
      // 1.x and 2.x share the serialized transaction format, so the app's
      // builders keep using 1.x and only resolution moves.
      const tx2 = Tx2.from(await tx.toJSON());
      try {
        return await tx2.build({ client, onlyTransactionKind: opts?.onlyTransactionKind });
      } catch (error) {
        throw toDryRunError(error) ?? error;
      }
    },
    async execute(bytes, signature) {
      const result = await client.core.executeTransaction({
        transaction: bytes,
        signatures: [signature],
        include: { effects: true, events: true },
      });
      return toJsonRpcExecution(result as unknown as V2TransactionResult);
    },
    async waitForTransaction(digest, opts) {
      const result = await client.core.waitForTransaction({
        digest,
        include: { effects: true },
        ...(opts?.timeoutMs ? { timeout: opts.timeoutMs } : {}),
      });
      return toJsonRpcExecution(result as unknown as V2TransactionResult);
    },
  };
}

/** One transport per 2.x endpoint, gRPC first. */
export async function v2TxTransports(network: NetworkType): Promise<TxTransport[]> {
  const v2 = await loadV2();
  return v2.endpointsFor(network).map((endpoint) => transportFor(endpoint, v2.Transaction));
}

/** Runs `read` on each 2.x endpoint in turn, moving on only after a transport failure. */
async function firstAnswer<T>(network: NetworkType, read: (client: V2Client) => Promise<T>): Promise<T> {
  const endpoints = (await loadV2()).endpointsFor(network);
  let lastError: unknown;
  for (const [index, endpoint] of endpoints.entries()) {
    try {
      return await read(endpoint.client);
    } catch (error) {
      lastError = error;
      if (index === endpoints.length - 1 || !isTxTransportError(error)) throw error;
    }
  }
  throw lastError;
}

export function v2Reads(network: NetworkType): V2Reads {
  return {
    getCoins: ({ owner, coinType, cursor, limit }) =>
      firstAnswer(network, async (client) =>
        toJsonRpcCoinPage(
          await client.core.listCoins({
            owner,
            ...(coinType ? { coinType } : {}),
            ...(cursor ? { cursor } : {}),
            ...(limit ? { limit } : {}),
          }),
        ),
      ),
    getBalance: ({ owner, coinType }) =>
      firstAnswer(network, async (client) =>
        toJsonRpcBalance((await client.core.getBalance({ owner, ...(coinType ? { coinType } : {}) })).balance),
      ),
    dynamicFieldValueJson: (parentId, keyTypeSuffix) =>
      firstAnswer(network, async (client) => {
        let cursor: string | null = null;
        do {
          const page: { dynamicFields: Array<{ fieldId: string; name: { type: string } }>; hasNextPage: boolean; cursor: string | null } =
            await client.core.listDynamicFields({ parentId, ...(cursor ? { cursor } : {}) });
          const entry = page.dynamicFields.find((field) => field.name.type.endsWith(keyTypeSuffix));
          if (entry) {
            const { objects } = await client.core.getObjects({ objectIds: [entry.fieldId], include: { json: true } });
            const field = objects[0];
            if (!field || field instanceof Error) throw field ?? new Error(`dynamic field ${entry.fieldId} could not be read`);
            const json = field.json as { value?: unknown } | null;
            if (!json || !('value' in json)) throw new Error(`dynamic field ${entry.fieldId} has no value`);
            return json.value;
          }
          cursor = page.hasNextPage ? page.cursor : null;
        } while (cursor);
        return null;
      }),
  };
}
