// sui-read.ts — L2 shared client read layer for Sui RPC.
//
// The scaling problem this solves: the app fans out many identical/overlapping
// reads per page (e.g. the same circle object fetched 4x by different
// functions), each a direct RPC round-trip against a rate-limited public node.
// Cost grew linearly with users for no benefit.
//
// This module sits on top of the failover client (`getPooledSuiClient`) and
// adds three resilience primitives, all in-memory and rebuildable from chain —
// NO centralized database, Sui stays the source of truth:
//
//   1. Single-flight dedup  — concurrent identical reads share one promise.
//   2. TTL micro-cache      — a short window collapses a page's mount burst.
//   3. Object-read batching  — distinct object ids requested in the same tick
//      are coalesced into one `multiGetObjects` call (chunked to 50).
//
// Design rule (L1): use these for *current state* (object reads). Event history
// should move to cursor-paginated queries / the chain's GraphQL indexer, not
// global `queryEvents` scans. See the rpc-scalability-architecture memo.

//
// Transport (stage 2 of the move off JSON-RPC, docs/testnet-rpc-after-publicnode.md):
// the pooled client carries a 2.x read source (v2-read-source.ts). Objects are
// read with `core.getObjects({ include: { json: true } })`, Sui's gRPC first
// and GraphQL second; dynamic-field lists the same way; events from Sui
// GraphQL, read through every page. Answers keep the JSON-RPC shapes callers
// parse (`data.content.fields`, `parsedJson`), converted exactly from each
// type's Move layout (move-json-rpc.ts). A client without a source (tests'
// stubs) keeps the JSON-RPC calls.
//
// A read that fails is never a fact. An object is "gone" only when a source
// answered that it does not exist; an answer for another id, of an
// unexpected Move type, or that cannot be read throws a SuiReadError.

import type {
  SuiClient,
  SuiObjectResponse,
  SuiObjectDataOptions,
  SuiEventFilter,
  SuiEvent,
  PaginatedEvents,
  EventId,
  DynamicFieldInfo,
  DynamicFieldName,
} from '@mysten/sui/client';
import { deriveDynamicFieldID, toBase58 } from '@mysten/sui/utils';
import { getPooledSuiClient } from '@/services/sui-rpc-failover';
import { getCurrentNetwork, type NetworkType } from '@/services/network-config';
import {
  bcsToRpcFlatValue,
  knownLayout,
  moveJsonToRpcContentFields,
  moveJsonToRpcParsedJson,
  ownerToRpc,
  rpcValueToBcs,
  toLongTypeString,
  toRpcTypeString,
  typeArguments,
  type MoveLayout,
} from './move-json-rpc';
import { attachedV2ReadSource, type V2ObjectRecord, type V2ReadSource } from './v2-read-source';
import type { GraphqlEventFilter, GraphqlEventRecord } from './sui-graphql-reads';

/** Default cache window: long enough to collapse a mount burst, short enough
 *  that on-chain state changes surface within a normal interaction. */
export const DEFAULT_READ_TTL_MS = 5_000;

/** For reads of data that never changes for a given id — an object's Move type
 *  / package lineage. Safe to cache aggressively; the only refresh need is a
 *  full page reload. */
export const IMMUTABLE_READ_TTL_MS = 10 * 60_000;

/** Sui caps `multiGetObjects` at 50 ids per request. */
const MAX_MULTIGET_IDS = 50;

/** Pages of a JSON-RPC list (events, dynamic fields) read before it counts as unreadable. */
const MAX_JSON_RPC_LIST_PAGES = 50;

/** A Move type's layout never changes, so it is kept until the cache is cleared. */
const LAYOUT_TTL_MS = Number.POSITIVE_INFINITY;

export type SuiReadFailure = 'unavailable' | 'unexpected-type' | 'unreadable' | 'unsupported';

/**
 * A read with no complete answer: no source answered (`unavailable`), the
 * answer was not the expected Move type (`unexpected-type`), it could not be
 * read (`unreadable`), or the read asked for something this layer does not
 * serve (`unsupported`). Never a fact about the object.
 */
export class SuiReadError extends Error {
  readonly reason: SuiReadFailure;
  constructor(message: string, reason: SuiReadFailure, options?: { cause?: unknown }) {
    super(`[sui-read] ${message}`);
    this.name = 'SuiReadError';
    this.reason = reason;
    if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }
}

/** True for any error this layer throws for a read that failed. */
export function isSuiReadError(error: unknown): error is SuiReadError {
  return error instanceof SuiReadError;
}

const DEFAULT_OBJECT_OPTIONS: SuiObjectDataOptions = {
  showContent: true,
  showType: true,
};

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

// Single shared cache + in-flight map, keyed by a fully-qualified read key
// (network + method + args). Values are immutable snapshots of chain state.
const responseCache = new Map<string, CacheEntry<unknown>>();
const inFlight = new Map<string, Promise<unknown>>();

/**
 * Generic single-flight + TTL cache wrapper. Identical concurrent calls (same
 * `key`) share one in-flight promise; successful results are cached for
 * `ttlMs`. Errors are never cached, so a transient failure doesn't poison the
 * key — the next caller retries.
 *
 * Use this for any idempotent read (dynamic fields, paginated events, derived
 * lookups). For plain object reads prefer `readObject` (it also batches).
 */
export async function cachedRead<T>(
  key: string,
  loader: () => Promise<T>,
  ttlMs: number = DEFAULT_READ_TTL_MS,
  /** Whether to keep this result; an absence answer is not kept, since the object or field may appear any moment. */
  keep: (value: T) => boolean = () => true,
): Promise<T> {
  const cached = responseCache.get(key) as CacheEntry<T> | undefined;
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const existing = inFlight.get(key) as Promise<T> | undefined;
  if (existing) {
    return existing;
  }

  const promise = (async () => {
    try {
      const value = await loader();
      if (ttlMs > 0 && keep(value)) {
        responseCache.set(key, { value, expiresAt: Date.now() + ttlMs });
      }
      return value;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, promise);
  return promise;
}

// ---------------------------------------------------------------------------
// Object-read batching
// ---------------------------------------------------------------------------

interface ObjectWaiter {
  resolve: (value: SuiObjectResponse) => void;
  reject: (error: unknown) => void;
}

interface ObjectBatch {
  client: SuiClient;
  options: SuiObjectDataOptions;
  waiters: Map<string, ObjectWaiter[]>;
  scheduled: boolean;
}

// One batch per (network, options) — responses for different option sets can't
// be mixed in a single multiGetObjects call.
const objectBatches = new Map<string, ObjectBatch>();

function stableOptionsKey(options: SuiObjectDataOptions): string {
  // Option objects are small and flat; JSON key order is stable enough here.
  return JSON.stringify(options);
}

function enqueueObjectRead(
  network: NetworkType,
  batchKey: string,
  id: string,
  options: SuiObjectDataOptions,
): Promise<SuiObjectResponse> {
  let batch = objectBatches.get(batchKey);
  if (!batch) {
    batch = {
      client: getPooledSuiClient({ network }),
      options,
      waiters: new Map(),
      scheduled: false,
    };
    objectBatches.set(batchKey, batch);
  }

  const currentBatch = batch;

  return new Promise<SuiObjectResponse>((resolve, reject) => {
    const waiters = currentBatch.waiters.get(id) ?? [];
    waiters.push({ resolve, reject });
    currentBatch.waiters.set(id, waiters);

    if (!currentBatch.scheduled) {
      currentBatch.scheduled = true;
      // Flush at the end of the current microtask: coalesces every read issued
      // synchronously in this tick into a single multiGetObjects round-trip.
      queueMicrotask(() => void flushObjectBatch(batchKey));
    }
  });
}

async function flushObjectBatch(batchKey: string): Promise<void> {
  const batch = objectBatches.get(batchKey);
  if (!batch) {
    return;
  }
  // Detach immediately so reads issued during the await open a fresh batch.
  objectBatches.delete(batchKey);

  const ids = Array.from(batch.waiters.keys());
  const source = attachedV2ReadSource(batch.client);
  if (source) {
    await flushObjectBatchV2(source, batch, ids);
    return;
  }

  for (let i = 0; i < ids.length; i += MAX_MULTIGET_IDS) {
    const chunk = ids.slice(i, i + MAX_MULTIGET_IDS);
    try {
      const responses = await batch.client.multiGetObjects({
        ids: chunk,
        options: batch.options,
      });
      chunk.forEach((id, index) => {
        const waiters = batch.waiters.get(id) ?? [];
        const response = responses[index];
        // A per-object error (e.g. deleted/notExists) is a valid response shape
        // (`{ error }`) — resolve with it; callers inspect `.data` / `.error`.
        waiters.forEach((waiter) => waiter.resolve(response));
      });
    } catch (error) {
      // Whole-call failure (network / rate-limit). Reject every waiter in the
      // chunk so each caller's transient-aware catch can degrade gracefully.
      chunk.forEach((id) => {
        const waiters = batch.waiters.get(id) ?? [];
        waiters.forEach((waiter) => waiter.reject(error));
      });
    }
  }
}

// ---------------------------------------------------------------------------
// 2.x answers in JSON-RPC's shape
// ---------------------------------------------------------------------------

const UNSUPPORTED_OBJECT_OPTIONS = ['showBcs', 'showDisplay', 'showStorageRebate'] as const;

/** The layout of `type`, from the fixed ones or (once per type) from Sui GraphQL. */
async function layoutOf(source: V2ReadSource, type: string): Promise<{ layout: MoveLayout; abilities: string[] }> {
  const known = knownLayout(type);
  if (known) return { layout: known, abilities: [] };
  try {
    return await cachedRead(
      `layout:${source.network}:${toLongTypeString(type)}`,
      () => source.typeLayout(type),
      LAYOUT_TTL_MS,
    );
  } catch (error) {
    throw new SuiReadError(`the Move layout of ${type} could not be read`, 'unavailable', { cause: error });
  }
}

function goneObjectResponse(id: string): SuiObjectResponse {
  return { error: { code: 'notExists', object_id: id } } as SuiObjectResponse;
}

async function toSuiObjectResponse(
  source: V2ReadSource,
  record: V2ObjectRecord,
  options: SuiObjectDataOptions,
): Promise<SuiObjectResponse> {
  const isPackage = record.type === 'package';
  const type = isPackage ? 'package' : toRpcTypeString(record.type);
  const data: Record<string, unknown> = {
    objectId: record.objectId,
    version: record.version,
    digest: record.digest,
  };
  if (options.showType) data.type = type;
  if (options.showOwner) data.owner = ownerToRpc(record.owner);
  if (options.showPreviousTransaction) data.previousTransaction = record.previousTransaction ?? undefined;
  if (options.showContent) {
    if (isPackage) {
      data.content = { dataType: 'package', disassembled: {} };
    } else {
      const { layout, abilities } = await layoutOf(source, record.type);
      let fields: Record<string, unknown>;
      try {
        fields = moveJsonToRpcContentFields(record.json, layout);
      } catch (error) {
        throw new SuiReadError(`${record.objectId} (${type}) could not be read`, 'unreadable', { cause: error });
      }
      data.content = { dataType: 'moveObject', type, hasPublicTransfer: abilities.includes('STORE'), fields };
    }
  }
  return { data } as unknown as SuiObjectResponse;
}

async function flushObjectBatchV2(source: V2ReadSource, batch: ObjectBatch, ids: string[]): Promise<void> {
  const unsupported = UNSUPPORTED_OBJECT_OPTIONS.filter((option) => batch.options[option]);
  for (let i = 0; i < ids.length; i += MAX_MULTIGET_IDS) {
    const chunk = ids.slice(i, i + MAX_MULTIGET_IDS);
    const rejectChunk = (error: unknown) =>
      chunk.forEach((id) => (batch.waiters.get(id) ?? []).forEach((waiter) => waiter.reject(error)));
    if (unsupported.length > 0) {
      rejectChunk(new SuiReadError(`${unsupported.join(', ')} is not served off JSON-RPC`, 'unsupported'));
      continue;
    }
    let results;
    try {
      results = await source.getObjects(chunk, { previousTransaction: Boolean(batch.options.showPreviousTransaction) });
    } catch (error) {
      rejectChunk(new SuiReadError(`objects ${chunk.join(', ')} could not be read`, 'unavailable', { cause: error }));
      continue;
    }
    await Promise.all(
      chunk.map(async (id, index) => {
        const waiters = batch.waiters.get(id) ?? [];
        const result = results[index];
        try {
          let response: SuiObjectResponse;
          if (result?.kind === 'found') response = await toSuiObjectResponse(source, result.object, batch.options);
          else if (result?.kind === 'gone') response = goneObjectResponse(id);
          else {
            throw new SuiReadError(`no source read ${id}`, 'unavailable', {
              cause: result?.kind === 'failed' ? result.error : undefined,
            });
          }
          waiters.forEach((waiter) => waiter.resolve(response));
        } catch (error) {
          waiters.forEach((waiter) => waiter.reject(error));
        }
      }),
    );
  }
}

/**
 * Whether `actualType` is `expected`: an exact type (`0x…::m::S<…>`), a type
 * without arguments (any arguments match), or `::module::Struct` for any
 * package (structs added in a package upgrade carry that version's id).
 */
export function isExpectedMoveType(actualType: string | null | undefined, expected: string): boolean {
  if (typeof actualType !== 'string' || actualType === '') return false;
  const actual = toLongTypeString(actualType);
  const open = actual.indexOf('<');
  const actualBase = open < 0 ? actual : actual.slice(0, open);
  if (expected.startsWith('::')) {
    return actualBase.endsWith(expected) && actualBase.split('::').length === 3;
  }
  const wanted = toLongTypeString(expected);
  return wanted.includes('<') ? actual === wanted : actualBase === wanted;
}

function checkExpectedType(id: string, response: SuiObjectResponse, expected: string): SuiObjectResponse {
  if (response.data && !isExpectedMoveType(response.data.type, expected)) {
    throw new SuiReadError(
      `${id} is a ${response.data.type ?? 'object of unknown type'}, not a ${expected}`,
      'unexpected-type',
    );
  }
  return response;
}

/** Read options for one object (`network`, cache window, and the Move type the answer must have). */
export interface ReadObjectOpts {
  network?: NetworkType;
  ttlMs?: number;
  /** The answer counts only if the object is of this type (see isExpectedMoveType); otherwise the read throws. */
  expectType?: string;
}

/**
 * Read a single object by id, deduped + cached + batched. Multiple callers
 * asking for the same id (within the TTL) share one result; distinct ids asked
 * in the same tick collapse into one `multiGetObjects` call.
 *
 * Returns the raw `SuiObjectResponse` (with `.data` / `.error`), matching
 * `client.getObject`, so it's a near drop-in replacement at call sites.
 */
export function readObject(
  id: string,
  options: SuiObjectDataOptions = DEFAULT_OBJECT_OPTIONS,
  opts: ReadObjectOpts = {},
): Promise<SuiObjectResponse> {
  const network = opts.network ?? getCurrentNetwork();
  const effectiveOptions = opts.expectType && !options.showType ? { ...options, showType: true } : options;
  const optionsKey = stableOptionsKey(effectiveOptions);
  const batchKey = `${network}:${optionsKey}`;
  const cacheKey = `obj:${batchKey}:${id}`;
  const ttlMs = opts.ttlMs ?? DEFAULT_READ_TTL_MS;

  const read = cachedRead(
    cacheKey,
    () => enqueueObjectRead(network, batchKey, id, effectiveOptions),
    ttlMs,
    // A just-created object (a member's new table entry) must not read as gone for the TTL.
    (response) => !isGoneObjectResponse(response),
  );
  const expected = opts.expectType;
  return expected ? read.then((response) => checkExpectedType(id, response, expected)) : read;
}

/**
 * Read many objects by id, deduped + cached + batched. Resolves to a
 * `SuiObjectResponse` per input id, in the same order.
 */
export function readObjects(
  ids: string[],
  options: SuiObjectDataOptions = DEFAULT_OBJECT_OPTIONS,
  opts: ReadObjectOpts = {},
): Promise<SuiObjectResponse[]> {
  return Promise.all(ids.map((id) => readObject(id, options, opts)));
}

// ---------------------------------------------------------------------------
// Event queries (deduped + cached)
// ---------------------------------------------------------------------------

export interface QueryEventsParams {
  query: SuiEventFilter;
  limit?: number;
  order?: 'ascending' | 'descending';
  cursor?: EventId | null;
}

/**
 * Deduped + cached `queryEvents`, routed through the failover client. A
 * near drop-in for `client.queryEvents(params)` — returns the same
 * `PaginatedEvents`, so existing `.data` / `.hasNextPage` / `.nextCursor`
 * usage is unchanged.
 *
 * The win: pages that scan the same event type from several functions in one
 * mount (the manage page queries 4 event types *twice* in a single fetch)
 * collapse to one RPC per (filter, limit, order, cursor) within the TTL.
 *
 * NOTE — this preserves the existing `MoveEventType` + client-side-filter
 * pattern, which is bounded by `limit` and does NOT scale to a global event
 * log. It's a dedup/resilience win, not the final fix. True history at scale
 * should move to cursor pagination / the chain's GraphQL indexer (L3). See the
 * rpc-scalability-architecture memo.
 */
export function queryEventsCached(
  params: QueryEventsParams,
  opts: { network?: NetworkType; ttlMs?: number } = {},
): Promise<PaginatedEvents> {
  const network = opts.network ?? getCurrentNetwork();
  const client = getPooledSuiClient({ network });
  const source = attachedV2ReadSource(client);
  if (source) {
    // Sui GraphQL, read to the end: callers get the whole list as one page,
    // so a scan "bounded by limit" can no longer pass a partial list as all.
    const ttlMs = opts.ttlMs ?? DEFAULT_READ_TTL_MS;
    return readAllEventsV2(source, params.query, ttlMs).then((events) => ({
      data: params.order === 'descending' ? [...events].reverse() : events,
      hasNextPage: false,
      nextCursor: null,
    }));
  }
  const key = `events:${network}:${JSON.stringify(params)}`;
  return cachedRead(
    key,
    () => client.queryEvents(params),
    opts.ttlMs ?? DEFAULT_READ_TTL_MS,
  );
}

/** A JSON-RPC event filter as Sui GraphQL's EventFilter; throws for filters GraphQL cannot express. */
function toGraphqlEventFilter(query: SuiEventFilter): GraphqlEventFilter {
  const filter = query as Record<string, unknown>;
  if (typeof filter.MoveEventType === 'string') return { type: filter.MoveEventType };
  const eventModule = filter.MoveEventModule as { package?: string; module?: string } | undefined;
  if (eventModule?.package && eventModule.module) return { type: `${eventModule.package}::${eventModule.module}` };
  const moveModule = filter.MoveModule as { package?: string; module?: string } | undefined;
  if (moveModule?.package && moveModule.module) return { module: `${moveModule.package}::${moveModule.module}` };
  if (typeof filter.Sender === 'string') return { sender: filter.Sender };
  throw new SuiReadError(`event filter ${JSON.stringify(query)} is not served off JSON-RPC`, 'unsupported');
}

async function toSuiEvent(source: V2ReadSource, record: GraphqlEventRecord): Promise<SuiEvent> {
  const { layout } = await layoutOf(source, record.type);
  let parsedJson: Record<string, unknown>;
  try {
    parsedJson = moveJsonToRpcParsedJson(record.json, layout);
  } catch (error) {
    throw new SuiReadError(`event ${record.txDigest}#${record.eventSeq} could not be read`, 'unreadable', { cause: error });
  }
  return {
    id: { txDigest: record.txDigest, eventSeq: record.eventSeq },
    packageId: record.packageId,
    transactionModule: record.transactionModule,
    sender: record.sender,
    type: toRpcTypeString(record.type),
    parsedJson,
    bcs: record.bcs ?? '',
    bcsEncoding: 'base64',
    timestampMs: record.timestampMs,
  } as SuiEvent;
}

function readAllEventsV2(source: V2ReadSource, query: SuiEventFilter, ttlMs: number): Promise<SuiEvent[]> {
  let filter: GraphqlEventFilter;
  try {
    filter = toGraphqlEventFilter(query);
  } catch (error) {
    return Promise.reject(error);
  }
  return cachedRead(
    `events:${source.network}:all:${JSON.stringify(filter)}`,
    async () => {
      let records: GraphqlEventRecord[];
      try {
        records = await source.readAllEvents(filter);
      } catch (error) {
        throw new SuiReadError(`events ${JSON.stringify(filter)} could not be read to the end`, 'unavailable', {
          cause: error,
        });
      }
      return Promise.all(records.map((record) => toSuiEvent(source, record)));
    },
    ttlMs,
  );
}

/**
 * Every event matching `query`, oldest first (newest first with `order:
 * 'descending'`), read through every page. Throws when the list cannot be
 * read to its end: the first page of a list is not the list.
 */
export async function readAllEvents(
  query: SuiEventFilter,
  opts: { network?: NetworkType; ttlMs?: number; order?: 'ascending' | 'descending' } = {},
): Promise<SuiEvent[]> {
  const network = opts.network ?? getCurrentNetwork();
  const ttlMs = opts.ttlMs ?? DEFAULT_READ_TTL_MS;
  const client = getPooledSuiClient({ network });
  const source = attachedV2ReadSource(client);
  let events: SuiEvent[];
  if (source) {
    events = await readAllEventsV2(source, query, ttlMs);
  } else {
    events = [];
    let cursor: EventId | null = null;
    for (let page = 1; ; page += 1) {
      if (page > MAX_JSON_RPC_LIST_PAGES) {
        throw new SuiReadError(`events ${JSON.stringify(query)}: more than ${MAX_JSON_RPC_LIST_PAGES} pages`, 'unavailable');
      }
      const result: PaginatedEvents = await queryEventsCached(
        { query, limit: 50, ...(cursor ? { cursor } : {}) },
        { network, ttlMs },
      );
      events.push(...result.data);
      if (!result.hasNextPage) break;
      const next: EventId | null = result.nextCursor ?? null;
      if (!next || JSON.stringify(next) === JSON.stringify(cursor)) {
        throw new SuiReadError(`events ${JSON.stringify(query)}: a next page without a new cursor`, 'unavailable');
      }
      cursor = next;
    }
  }
  return opts.order === 'descending' ? [...events].reverse() : events;
}

// ---------------------------------------------------------------------------
// Dynamic fields
// ---------------------------------------------------------------------------

/** One dynamic field as JSON-RPC's getDynamicFields lists it (no version or digest off JSON-RPC). */
export type DynamicFieldEntry = Omit<DynamicFieldInfo, 'version' | 'digest'> & { version?: string; digest?: string };

/**
 * `parentId`'s whole dynamic-field list, in JSON-RPC's DynamicFieldInfo
 * shape, read through every page. Throws when it cannot be read to its end:
 * a partial list would hide a field (a circle's config) as missing.
 */
export function listDynamicFields(
  parentId: string,
  opts: { network?: NetworkType; ttlMs?: number } = {},
): Promise<DynamicFieldEntry[]> {
  const network = opts.network ?? getCurrentNetwork();
  const client = getPooledSuiClient({ network });
  const source = attachedV2ReadSource(client);
  return cachedRead(
    `dfs:${network}:${parentId}`,
    async () => {
      if (!source) {
        const entries: DynamicFieldEntry[] = [];
        let cursor: string | null = null;
        for (let page = 1; ; page += 1) {
          if (page > MAX_JSON_RPC_LIST_PAGES) {
            throw new SuiReadError(`dynamic fields of ${parentId}: more than ${MAX_JSON_RPC_LIST_PAGES} pages`, 'unavailable');
          }
          const result: Awaited<ReturnType<SuiClient['getDynamicFields']>> = await client.getDynamicFields({
            parentId,
            ...(cursor ? { cursor } : {}),
          });
          entries.push(...result.data);
          if (!result.hasNextPage) return entries;
          if (!result.nextCursor || result.nextCursor === cursor) {
            throw new SuiReadError(`dynamic fields of ${parentId}: a next page without a new cursor`, 'unavailable');
          }
          cursor = result.nextCursor;
        }
      }
      let records;
      try {
        records = await source.listDynamicFields(parentId);
      } catch (error) {
        throw new SuiReadError(`dynamic fields of ${parentId} could not be read to the end`, 'unavailable', { cause: error });
      }
      return Promise.all(
        records.map(async (record): Promise<DynamicFieldEntry> => {
          const { layout } = await layoutOf(source, record.nameType);
          let value: unknown;
          try {
            value = bcsToRpcFlatValue(record.nameBcs, layout);
          } catch (error) {
            throw new SuiReadError(`a dynamic field name of ${parentId} could not be read`, 'unreadable', { cause: error });
          }
          return {
            name: { type: toRpcTypeString(record.nameType), value },
            bcsName: toBase58(record.nameBcs),
            bcsEncoding: 'base58',
            type: record.kind,
            objectId: record.kind === 'DynamicObject' && record.childId ? record.childId : record.fieldId,
            objectType: toRpcTypeString(record.valueType),
          } as DynamicFieldEntry;
        }),
      );
    },
    opts.ttlMs ?? DEFAULT_READ_TTL_MS,
  );
}

const FIELD_TYPE = '0x2::dynamic_field::Field';
const DOF_WRAPPER = '0x2::dynamic_object_field::Wrapper';

function dynamicFieldMissing(parentId: string): SuiObjectResponse {
  return { error: { code: 'dynamicFieldNotFound', parent_object_id: parentId } } as SuiObjectResponse;
}

/** True when a dynamic-field read answered that the parent has no such field (a confirmed absence). */
export function isDynamicFieldMissingResponse(
  response: { error?: { code?: string } | null } | null | undefined,
): boolean {
  return response?.error?.code === 'dynamicFieldNotFound';
}

/**
 * The dynamic field `name` of `parentId`, as JSON-RPC's getDynamicFieldObject
 * returns it: the Field object, or for a dynamic object field the child
 * object. Its id is derived from the parent and the name, so the read is one
 * object read. `{ error: { code: 'dynamicFieldNotFound' } }` only when a
 * source answered that no such field exists; any failed read throws.
 */
export async function readDynamicFieldObject(
  parentId: string,
  name: DynamicFieldName,
  opts: { network?: NetworkType; ttlMs?: number } = {},
): Promise<SuiObjectResponse> {
  const network = opts.network ?? getCurrentNetwork();
  const client = getPooledSuiClient({ network });
  const source = attachedV2ReadSource(client);
  if (!source) {
    return cachedRead(
      `dfo:${network}:${parentId}:${JSON.stringify(name)}`,
      () => client.getDynamicFieldObject({ parentId, name }),
      opts.ttlMs ?? DEFAULT_READ_TTL_MS,
      (response) => !isDynamicFieldMissingResponse(response) && !isGoneObjectResponse(response),
    );
  }

  const { layout } = await layoutOf(source, name.type);
  let key: Uint8Array;
  try {
    key = rpcValueToBcs(name.value, layout);
  } catch (error) {
    throw new SuiReadError(`dynamic field name ${JSON.stringify(name)} is not a ${name.type}`, 'unsupported', { cause: error });
  }
  const options: SuiObjectDataOptions = { showContent: true, showType: true, showOwner: true };
  const readOpts = { network, ttlMs: opts.ttlMs };
  const nameType = toLongTypeString(name.type);

  const fieldId = deriveDynamicFieldID(parentId, name.type, key);
  const field = await readObject(fieldId, options, { ...readOpts, expectType: FIELD_TYPE });
  if (field.data) {
    if (toLongTypeString(typeArguments(field.data.type ?? '')[0] ?? '') !== nameType) {
      throw new SuiReadError(`${fieldId} is a ${field.data.type}, not a field named by ${name.type}`, 'unexpected-type');
    }
    return field;
  }

  const wrapperId = deriveDynamicFieldID(parentId, `${DOF_WRAPPER}<${name.type}>`, key);
  const wrapper = await readObject(wrapperId, options, { ...readOpts, expectType: FIELD_TYPE });
  if (!wrapper.data) return dynamicFieldMissing(parentId);
  const content = wrapper.data.content as { fields?: { value?: unknown } } | undefined;
  const childId = content?.fields?.value;
  if (typeof childId !== 'string') {
    throw new SuiReadError(`${wrapperId} does not name its child object`, 'unreadable');
  }
  const child = await readObject(childId, options, readOpts);
  if (!child.data) {
    throw new SuiReadError(`dynamic object field ${wrapperId} names ${childId}, which could not be read`, 'unavailable');
  }
  return child;
}

// ---------------------------------------------------------------------------
// Cache control (call after a write mutates an object you just read)
// ---------------------------------------------------------------------------

/** Drop cached reads. With no prefix, clears everything; otherwise only keys
 *  beginning with `keyPrefix` (e.g. `"obj:"` or a specific `cacheKey`). */
export function invalidateSuiRead(keyPrefix?: string): void {
  if (!keyPrefix) {
    responseCache.clear();
    return;
  }
  for (const key of responseCache.keys()) {
    if (key.startsWith(keyPrefix)) {
      responseCache.delete(key);
    }
  }
}

/** Invalidate every cached read of a specific object id, across all option
 *  sets / networks. Call this right after a transaction that mutates it. */
export function invalidateObject(id: string): void {
  for (const key of responseCache.keys()) {
    if ((key.startsWith('obj:') || key.startsWith('dfs:')) && key.endsWith(`:${id}`)) {
      responseCache.delete(key);
    }
  }
}

/** Full reset — primarily for tests. */
/**
 * True only when the chain itself says the object is not there (`notExists`,
 * `deleted`). Any other error, or no response at all, means the read failed,
 * which says nothing about whether the object exists.
 */
export function isGoneObjectResponse(
  response: { error?: { code?: string } | null } | null | undefined,
): boolean {
  const code = response?.error?.code;
  return code === 'notExists' || code === 'deleted';
}

export function clearSuiReadCache(): void {
  responseCache.clear();
  inFlight.clear();
  objectBatches.clear();
}
