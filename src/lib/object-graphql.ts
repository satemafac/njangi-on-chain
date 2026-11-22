// object-graphql.ts — one Move object, by id, from Sui's GraphQL service.
//
// Sui GraphQL still answers when every JSON-RPC endpoint refuses JSON-RPC
// (NJA-2830), so object reads ask it first and keep JSON-RPC as their
// fallback. A read that fails is not a fact: every answer that is not whole
// throws, and the only "gone" is `object: null` with no `errors`.

import { getCurrentNetwork, getGraphqlUrlForNetwork } from '@/services/network-config';

/** How long one GraphQL request may take before it counts as a failed read. */
const GRAPHQL_TIMEOUT_MS = 8_000;

/** One object by id, with its version, full Move type and fields. */
const OBJECT_QUERY = `query ($id: SuiAddress!) {
  object(address: $id) { version asMoveObject { contents { type { repr } json } } }
}`;

/** A Move object as Sui GraphQL returned it. */
export interface GraphqlMoveObject {
  /** The object's version, in decimal. */
  version: string;
  /** Its full Move type (`contents.type.repr`). */
  type: string;
  /** Its fields in Sui GraphQL's JSON form (`contents.json`). */
  json: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `value[key]` when `value` is a plain object, otherwise undefined. */
function readField(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failedRead(message: string, cause?: unknown): Error {
  const error = new Error(`[object-graphql] ${message}`);
  return cause === undefined ? error : Object.assign(error, { cause });
}

/** The version in decimal (GraphQL sends a UInt53 number), or null when it is unreadable. */
function readVersion(value: unknown): string | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  }
  if (typeof value === 'string') {
    return /^\d+$/.test(value) ? value : null;
  }
  return null;
}

/**
 * The Move object `objectId`, read from Sui GraphQL on the current network.
 * Resolves to null only when the service answers `object: null` with no
 * `errors`: a confirmed gone object. Throws on everything else that is not a
 * whole answer (no GraphQL URL or fetch, a failed, aborted or timed-out
 * request, a non-2xx status, a body that does not parse, any `errors` entry
 * even beside `data`, no `data` or no `object` in it, or an object without
 * `asMoveObject.contents` carrying a string `type.repr` and a `json` object,
 * or without a readable `version`): a failed read is never "gone".
 */
export async function readObjectViaGraphql(objectId: string): Promise<GraphqlMoveObject | null> {
  const url: unknown = getGraphqlUrlForNetwork(getCurrentNetwork());
  if (typeof url !== 'string' || url === '') {
    throw failedRead(`no Sui GraphQL URL for the current network, so ${objectId} was not read`);
  }
  if (typeof fetch !== 'function') {
    throw failedRead(`fetch is unavailable, so ${objectId} was not read`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GRAPHQL_TIMEOUT_MS);
  let body: unknown;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query: OBJECT_QUERY, variables: { id: objectId } }),
      signal: controller.signal,
    }).catch((error: unknown) => {
      throw failedRead(`GraphQL ${url} did not answer for ${objectId}: ${describeError(error)}`, error);
    });
    if (!response.ok) {
      throw failedRead(`GraphQL ${url} answered ${response.status} for ${objectId}`);
    }
    body = await response.json().catch((error: unknown) => {
      throw failedRead(`GraphQL ${url} sent an unreadable body for ${objectId}: ${describeError(error)}`, error);
    });
  } finally {
    clearTimeout(timer);
  }

  const errors = readField(body, 'errors');
  if (errors !== undefined && errors !== null && !(Array.isArray(errors) && errors.length === 0)) {
    const reason = Array.isArray(errors) ? readField(errors[0], 'message') : undefined;
    throw failedRead(`GraphQL ${url} returned errors for ${objectId}${typeof reason === 'string' ? `: ${reason}` : ''}`);
  }
  const data = readField(body, 'data');
  if (!isRecord(data) || !('object' in data)) {
    throw failedRead(`GraphQL ${url} returned no data for ${objectId}`);
  }
  const object = data.object;
  if (object === null) {
    return null; // `object: null` with no errors: the object is gone.
  }
  const contents = readField(readField(object, 'asMoveObject'), 'contents');
  const type = readField(readField(contents, 'type'), 'repr');
  const json = readField(contents, 'json');
  const version = readVersion(readField(object, 'version'));
  if (typeof type !== 'string' || type === '' || !isRecord(json) || version === null) {
    throw failedRead(`GraphQL ${url} returned ${objectId} without a readable version, Move type and json`);
  }
  return { version, type, json };
}

/**
 * A Move object's GraphQL `json` in the shape JSON-RPC gives its
 * `content.fields`, for callers written against JSON-RPC: a UID (`id`, a
 * string in GraphQL) becomes `{ id }` and a nested struct (a plain object in
 * GraphQL) becomes `{ fields }`, so a Table `members: { id, size }` reads as
 * `members.fields.id.id`. Strings, numbers, booleans, vectors and empty
 * options already have one form in both.
 */
export function moveJsonToRpcFields(json: Record<string, unknown>): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(json)) {
    fields[key] = key === 'id' && typeof value === 'string' ? { id: value } : moveJsonValueToRpc(value);
  }
  return fields;
}

function moveJsonValueToRpc(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(moveJsonValueToRpc);
  if (isRecord(value)) return { fields: moveJsonToRpcFields(value) };
  return value;
}
