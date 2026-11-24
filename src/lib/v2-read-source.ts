// v2-read-source.ts — where the shared read layer (sui-read.ts) reads chain
// state when it is not reading JSON-RPC.
//
// Objects and dynamic-field lists: @mysten/sui 2.x `core` on Sui's gRPC
// fullnode first, Sui GraphQL second (v2-sui-client.ts). Event history and
// Move type layouts: Sui GraphQL (sui-graphql-reads.ts).
//
// The pooled client (sui-rpc-failover.ts getPooledSuiClient) carries a source,
// as the signing client carries its transport (tx-transport.ts). A client
// without one — a test's stub, any other SuiClient — keeps sui-read's JSON-RPC
// behaviour.

import type { NetworkType } from '@/services/network-config';
import {
  fetchTypeLayout,
  readAllEventsViaGraphql,
  type GraphqlEventFilter,
  type GraphqlEventRecord,
  type TypeLayoutReading,
} from './sui-graphql-reads';

/** An object as 2.x returned it, checked to be the object asked for. */
export interface V2ObjectRecord {
  /** The id asked for, at full width. */
  objectId: string;
  version: string;
  digest: string;
  /** Its full Move type (`package` for a package). */
  type: string;
  /** The 2.x owner (`{ $kind, … }`). */
  owner: unknown;
  /** Its fields as 2.x JSON; null only for a package. */
  json: Record<string, unknown> | null;
  previousTransaction?: string | null;
}

/**
 * One object read. `gone` only when a source answered that the object does
 * not exist; `failed` when no source gave a complete answer for it.
 */
export type V2ObjectResult =
  | { kind: 'found'; object: V2ObjectRecord }
  | { kind: 'gone' }
  | { kind: 'failed'; error: unknown };

/** One entry of a dynamic-field list, as 2.x returns it. */
export interface V2DynamicFieldRecord {
  kind: 'DynamicField' | 'DynamicObject';
  /** The Field object's id. */
  fieldId: string;
  /** For a dynamic object field, the child object's id. */
  childId?: string;
  nameType: string;
  nameBcs: Uint8Array;
  /** The value's type; for a dynamic object field, the child's type. */
  valueType: string;
}

export interface V2ReadSource {
  readonly network: NetworkType;
  /** One result per id, in order. Never throws for one object; throws only if it cannot run at all. */
  getObjects(ids: string[], include?: { previousTransaction?: boolean }): Promise<V2ObjectResult[]>;
  /** The parent's whole dynamic-field list; throws rather than return part of it. */
  listDynamicFields(parentId: string): Promise<V2DynamicFieldRecord[]>;
  /** Every event matching the filter, oldest first; throws rather than return part of it. */
  readAllEvents(filter: GraphqlEventFilter): Promise<GraphqlEventRecord[]>;
  /** The Move layout of a type. */
  typeLayout(type: string): Promise<TypeLayoutReading>;
}

export const V2_READ_SOURCE_KEY = Symbol.for('njangi.v2ReadSource');

/** The source a client carries, if any. */
export function attachedV2ReadSource(client: unknown): V2ReadSource | undefined {
  if (typeof client !== 'object' || client === null) return undefined;
  return (client as Record<symbol, V2ReadSource | undefined>)[V2_READ_SOURCE_KEY];
}

/** Gives `client` a source (non-enumerable, so it never shows in equality checks or logs). */
export function attachV2ReadSource<T extends object>(client: T, source: V2ReadSource): T {
  Object.defineProperty(client, V2_READ_SOURCE_KEY, { value: source, enumerable: false, configurable: true });
  return client;
}

// Lazy: @mysten/sui 2.x is ESM-only and loads on the first read, not with the page.
const loadV2 = () => import('./v2-sui-client');

export function lazyV2ReadSource(network: NetworkType): V2ReadSource {
  return {
    network,
    getObjects: async (ids, include) => (await loadV2()).v2GetObjects(network, ids, include),
    listDynamicFields: async (parentId) => (await loadV2()).v2ListDynamicFields(network, parentId),
    readAllEvents: (filter) => readAllEventsViaGraphql(network, filter),
    typeLayout: (type) => fetchTypeLayout(network, type),
  };
}
