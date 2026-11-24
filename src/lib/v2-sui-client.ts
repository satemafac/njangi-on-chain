// v2-sui-client.ts — the only module that loads @mysten/sui 2.x (installed as
// `@mysten/sui-v2`). It is ESM-only and needs Node 22+, so it is imported
// lazily, on the first signature, never at page load or in Jest.
//
// gRPC first (Sui's own fullnodes: fast, current state, no history), GraphQL
// second (graphql.<net>.sui.io: full history). Both are keyless, answer
// browsers (CORS *), and return identical object JSON (checked 2026-10-17,
// docs/testnet-rpc-after-publicnode.md).

import type { Transaction } from '@mysten/sui/transactions';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { getGraphqlUrlForNetwork, type NetworkType } from '@/services/network-config';
import type { TxTransport, V2Reads } from './tx-transport';
import type { V2DynamicFieldRecord, V2ObjectResult } from './v2-read-source';
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
          if (page.hasNextPage && (!page.cursor || page.cursor === cursor)) {
            // A list cut short is not "no such field".
            throw new Error(`dynamic fields of ${parentId}: a next page without a new cursor`);
          }
          cursor = page.hasNextPage ? page.cursor : null;
        } while (cursor);
        return null;
      }),
  };
}

// ---------------------------------------------------------------------------
// Object reads for the shared read layer (sui-read.ts via v2-read-source.ts)
// ---------------------------------------------------------------------------

/** Pages of a dynamic-field list read before the list counts as unreadable. */
export const MAX_DYNAMIC_FIELD_PAGES = 50;

function describe(endpoint: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return Object.assign(new Error(`[v2-read:${endpoint}] ${message}`), { cause: error });
}

/** A per-object error that says the object does not exist (both transports mark it `notFound`). */
function isNotFoundAnswer(error: Error): boolean {
  const { reason, code } = error as Error & { reason?: string; code?: string };
  return reason === 'notFound' || code === 'notExists' || code === 'notFound';
}

/**
 * `ids` read with `core.getObjects({ include: { json: true } })`, gRPC first,
 * GraphQL for whatever gRPC did not answer. An id is `gone` only when gRPC,
 * which serves the fullnode's current state, said it does not exist. GraphQL
 * is an indexer that lags the chain, so its "not found" can be a circle or a
 * member record created a moment ago: it counts as a failed read. An answer
 * for another id, or a Move object without its JSON, does not count either,
 * and an id no source answered is `failed`.
 */
export async function v2GetObjects(
  network: NetworkType,
  ids: string[],
  include: { previousTransaction?: boolean } = {},
): Promise<V2ObjectResult[]> {
  const endpoints = (await loadV2()).endpointsFor(network);
  const wanted = ids.map((id) => normalizeSuiAddress(id));
  const results = new Map<string, V2ObjectResult>();
  const errors = new Map<string, unknown>();
  let pending = Array.from(new Set(wanted));

  for (const endpoint of endpoints) {
    if (pending.length === 0) break;
    let objects: unknown[];
    try {
      const response = await endpoint.client.core.getObjects({
        objectIds: pending,
        include: { json: true, ...(include.previousTransaction ? { previousTransaction: true } : {}) },
      });
      objects = response.objects as unknown[];
      if (!Array.isArray(objects) || objects.length !== pending.length) {
        throw new Error(`answered ${Array.isArray(objects) ? objects.length : 'no'} objects for ${pending.length} ids`);
      }
    } catch (error) {
      for (const id of pending) errors.set(id, describe(endpoint.name, error));
      continue;
    }
    pending.forEach((id, index) => {
      const answer = objects[index];
      if (answer instanceof Error) {
        if (isNotFoundAnswer(answer) && endpoint.name === 'grpc') results.set(id, { kind: 'gone' });
        else errors.set(id, describe(endpoint.name, answer));
        return;
      }
      const object = answer as {
        objectId?: string;
        version?: string;
        digest?: string;
        type?: string;
        owner?: unknown;
        json?: Record<string, unknown> | null;
        previousTransaction?: string | null;
      };
      if (typeof object?.objectId !== 'string' || normalizeSuiAddress(object.objectId) !== id) {
        errors.set(id, describe(endpoint.name, `answered ${String(object?.objectId)} for ${id}`));
        return;
      }
      const isPackage = object.type === 'package';
      if (typeof object.type !== 'string' || object.type === '' || (!isPackage && (object.json === null || typeof object.json !== 'object'))) {
        errors.set(id, describe(endpoint.name, `answered ${id} without its Move type and JSON`));
        return;
      }
      results.set(id, {
        kind: 'found',
        object: {
          objectId: id,
          version: String(object.version),
          digest: String(object.digest),
          type: object.type,
          owner: object.owner,
          json: isPackage ? null : (object.json as Record<string, unknown>),
          previousTransaction: object.previousTransaction ?? null,
        },
      });
    });
    pending = pending.filter((id) => !results.has(id));
  }

  return wanted.map(
    (id) => results.get(id) ?? { kind: 'failed', error: errors.get(id) ?? new Error(`[v2-read] no source read ${id}`) },
  );
}

/**
 * `parentId`'s whole dynamic-field list, read with `core.listDynamicFields`
 * through every page on one transport (cursors do not carry across), gRPC
 * first, then GraphQL from the start. Throws when neither reads it to the end.
 */
export async function v2ListDynamicFields(network: NetworkType, parentId: string): Promise<V2DynamicFieldRecord[]> {
  const endpoints = (await loadV2()).endpointsFor(network);
  let lastError: unknown = new Error(`[v2-read] no source listed ${parentId}`);
  for (const endpoint of endpoints) {
    try {
      const fields: V2DynamicFieldRecord[] = [];
      let cursor: string | null = null;
      for (let page = 1; ; page += 1) {
        if (page > MAX_DYNAMIC_FIELD_PAGES) throw new Error(`more than ${MAX_DYNAMIC_FIELD_PAGES} pages of dynamic fields`);
        const response: {
          dynamicFields: Array<{
            $kind: string;
            fieldId: string;
            childId?: string;
            name: { type: string; bcs: Uint8Array };
            valueType: string;
          }>;
          hasNextPage: boolean;
          cursor: string | null;
        } = await endpoint.client.core.listDynamicFields({ parentId, ...(cursor ? { cursor } : {}) });
        if (!Array.isArray(response?.dynamicFields) || typeof response.hasNextPage !== 'boolean') {
          throw new Error('answered without a dynamic-field list');
        }
        for (const entry of response.dynamicFields) {
          if (
            (entry.$kind !== 'DynamicField' && entry.$kind !== 'DynamicObject') ||
            typeof entry.fieldId !== 'string' ||
            typeof entry.name?.type !== 'string' ||
            !(entry.name?.bcs instanceof Uint8Array) ||
            typeof entry.valueType !== 'string' ||
            (entry.$kind === 'DynamicObject' && typeof entry.childId !== 'string')
          ) {
            throw new Error('answered a dynamic field without its kind, id, name or value type');
          }
          fields.push({
            kind: entry.$kind,
            fieldId: entry.fieldId,
            ...(entry.childId ? { childId: entry.childId } : {}),
            nameType: entry.name.type,
            nameBcs: entry.name.bcs,
            valueType: entry.valueType,
          });
        }
        if (!response.hasNextPage) return fields;
        if (!response.cursor || response.cursor === cursor) throw new Error('a next page without a new cursor');
        cursor = response.cursor;
      }
    } catch (error) {
      lastError = describe(endpoint.name, error);
    }
  }
  throw lastError;
}
