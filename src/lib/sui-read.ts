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

import type {
  SuiClient,
  SuiObjectResponse,
  SuiObjectDataOptions,
  SuiEventFilter,
  PaginatedEvents,
  EventId,
} from '@mysten/sui/client';
import { getPooledSuiClient } from '@/services/sui-rpc-failover';
import { getCurrentNetwork, type NetworkType } from '@/services/network-config';

/** Default cache window: long enough to collapse a mount burst, short enough
 *  that on-chain state changes surface within a normal interaction. */
export const DEFAULT_READ_TTL_MS = 5_000;

/** For reads of data that never changes for a given id — an object's Move type
 *  / package lineage. Safe to cache aggressively; the only refresh need is a
 *  full page reload. */
export const IMMUTABLE_READ_TTL_MS = 10 * 60_000;

/** Sui caps `multiGetObjects` at 50 ids per request. */
const MAX_MULTIGET_IDS = 50;

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
      if (ttlMs > 0) {
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
  opts: { network?: NetworkType; ttlMs?: number } = {},
): Promise<SuiObjectResponse> {
  const network = opts.network ?? getCurrentNetwork();
  const optionsKey = stableOptionsKey(options);
  const batchKey = `${network}:${optionsKey}`;
  const cacheKey = `obj:${batchKey}:${id}`;
  const ttlMs = opts.ttlMs ?? DEFAULT_READ_TTL_MS;

  return cachedRead(
    cacheKey,
    () => enqueueObjectRead(network, batchKey, id, options),
    ttlMs,
  );
}

/**
 * Read many objects by id, deduped + cached + batched. Resolves to a
 * `SuiObjectResponse` per input id, in the same order.
 */
export function readObjects(
  ids: string[],
  options: SuiObjectDataOptions = DEFAULT_OBJECT_OPTIONS,
  opts: { network?: NetworkType; ttlMs?: number } = {},
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
  const key = `events:${network}:${JSON.stringify(params)}`;
  return cachedRead(
    key,
    () => getPooledSuiClient({ network }).queryEvents(params),
    opts.ttlMs ?? DEFAULT_READ_TTL_MS,
  );
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
    if (key.startsWith('obj:') && key.endsWith(`:${id}`)) {
      responseCache.delete(key);
    }
  }
}

/** Full reset — primarily for tests. */
export function clearSuiReadCache(): void {
  responseCache.clear();
  inFlight.clear();
  objectBatches.clear();
}
