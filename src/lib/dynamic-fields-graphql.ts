// dynamic-fields-graphql.ts — an object's dynamic-field list over Sui GraphQL.
//
// The dashboard listed each circle's dynamic fields only through JSON-RPC
// `getDynamicFields`, so when every configured JSON-RPC endpoint refused
// (NJA-2830) every circle was counted unreadable while Sui's GraphQL service
// would have answered. This is the GraphQL read. Callers try it first and keep
// JSON-RPC as the fallback (readDynamicFieldsViaJsonRpc, below), as
// src/lib/wallet-balances.ts does for balances.
//
// A read that fails is not a fact. A non-2xx status, a GraphQL `errors` body, a
// missing address or connection, an unreadable node or a list cut short by
// paging all throw, on either transport, so the caller falls back (or counts
// the object unreadable) instead of using a partial list: a circle whose
// CircleConfig field is missing from its list shows default amounts as if
// real. No field is ever dropped and no name, type or id is ever defaulted.

import type { SuiClient } from '@mysten/sui/client';
import { getGraphqlUrlForNetwork, type NetworkType } from '@/services/network-config';

const DYNAMIC_FIELDS_QUERY =
  'query DynamicFields($parent: SuiAddress!, $after: String) { address(address: $parent) { dynamicFields(first: 50, after: $after) { pageInfo { hasNextPage endCursor } nodes { address name { type { repr } json } value { __typename ... on MoveValue { type { repr } } ... on MoveObject { address contents { type { repr } } } } } } } }';
const GRAPHQL_TIMEOUT_MS = 8_000;

/** Pages followed (on either transport) before giving up; a longer list throws rather than coming back partial. */
export const DYNAMIC_FIELDS_MAX_PAGES = 20;

/** A dynamic field's name, as JSON-RPC's DynamicFieldInfo carries it. */
export interface DynamicFieldNameReading {
  /** The name's Move type, e.g. `0x1::string::String` or `vector<u8>`. */
  type: string;
  /** The name as JSON. From GraphQL a `vector<u8>` name is its UTF-8 text (its byte list when it is not UTF-8). */
  value: unknown;
}

/** One dynamic field, in the keys of JSON-RPC's DynamicFieldInfo that its readers use. */
export interface DynamicFieldReading {
  /** The Field object's id for a dynamic field; the child object's id for a dynamic object field. */
  objectId: string;
  /** The value's Move type; the child object's type for a dynamic object field. */
  objectType: string;
  type: 'DynamicField' | 'DynamicObject';
  name: DynamicFieldNameReading;
}

/** The client the JSON-RPC fallback lists with. */
export type DynamicFieldsJsonRpcClient = Pick<SuiClient, 'getDynamicFields'>;
type DynamicFieldsJsonRpcPage = Awaited<ReturnType<DynamicFieldsJsonRpcClient['getDynamicFields']>>;

interface DynamicFieldsPage {
  fields: DynamicFieldReading[];
  hasNextPage: boolean;
  endCursor: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isObjectAddress(value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-fA-F]+$/.test(value);
}

/** The `repr` of a GraphQL MoveType, or null when it is missing or empty (the caller throws). */
function typeRepr(type: unknown): string | null {
  const repr = isRecord(type) ? type.repr : undefined;
  return typeof repr === 'string' && repr.trim() !== '' ? repr : null;
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** The bytes of a padded base64 string, or null when it is not valid base64 (the caller throws). */
function decodeBase64(encoded: string): number[] | null {
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+\/]*={0,2}$/.test(encoded)) {
    return null;
  }
  const bytes: number[] = [];
  for (let i = 0; i < encoded.length; i += 4) {
    // '=' is not in the alphabet: -1 marks padding, which the check above allows only at the end.
    const sextets = [0, 1, 2, 3].map((k) => BASE64_ALPHABET.indexOf(encoded.charAt(i + k)));
    const bits = sextets.reduce((acc, sextet) => (acc << 6) | Math.max(sextet, 0), 0);
    bytes.push((bits >> 16) & 0xff);
    if (sextets[2] >= 0) bytes.push((bits >> 8) & 0xff);
    if (sextets[3] >= 0) bytes.push(bits & 0xff);
  }
  return bytes;
}

/** `bytes` as UTF-8 text, or null when they are not valid UTF-8. */
function decodeUtf8(bytes: number[]): string | null {
  if (typeof TextDecoder !== 'function') {
    throw new Error('No TextDecoder is available to read a vector<u8> dynamic-field name');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    return null;
  }
}

/**
 * A `vector<u8>` name's value. Sui GraphQL renders the bytes as base64; they
 * are decoded to the UTF-8 text a byte-string key such as b"circle_config"
 * spells, so isCircleConfigDynamicField still matches it, or kept as the byte
 * list JSON-RPC shows when they are not UTF-8. Throws when the bytes cannot be
 * read.
 */
function readByteName(json: unknown, fieldAddress: string, url: string): string | number[] {
  const bytes =
    typeof json === 'string'
      ? decodeBase64(json)
      : Array.isArray(json) && json.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
        ? (json as number[])
        : null;
  if (!bytes) {
    throw new Error(`GraphQL ${url} returned dynamic field ${fieldAddress} with an unreadable vector<u8> name`);
  }
  return decodeUtf8(bytes) ?? bytes;
}

function parseName(name: unknown, fieldAddress: string, url: string): DynamicFieldNameReading {
  const record: Record<string, unknown> = isRecord(name) ? name : {};
  const type = typeRepr(record.type);
  if (!type) {
    throw new Error(`GraphQL ${url} returned dynamic field ${fieldAddress} without a name type`);
  }
  const json = record.json;
  if (json === undefined || json === null) {
    throw new Error(`GraphQL ${url} returned dynamic field ${fieldAddress} without a readable name`);
  }
  return { type, value: type === 'vector<u8>' ? readByteName(json, fieldAddress, url) : json };
}

/** One dynamic-field node, or a throw: a node is never skipped and no key of it is ever defaulted. */
function parseNode(node: unknown, index: number, url: string): DynamicFieldReading {
  const record: Record<string, unknown> = isRecord(node) ? node : {};
  const fieldAddress = record.address;
  if (!isObjectAddress(fieldAddress)) {
    throw new Error(`GraphQL ${url} returned dynamic field node ${index} without an address`);
  }
  const name = parseName(record.name, fieldAddress, url);
  const rawValue = record.value;
  const value: Record<string, unknown> = isRecord(rawValue) ? rawValue : {};
  if (value.__typename === 'MoveValue') {
    const objectType = typeRepr(value.type);
    if (objectType) {
      return { objectId: fieldAddress, objectType, type: 'DynamicField', name };
    }
  } else if (value.__typename === 'MoveObject') {
    const objectId = value.address;
    const contents = value.contents;
    const objectType = typeRepr(isRecord(contents) ? contents.type : undefined);
    if (isObjectAddress(objectId) && objectType) {
      return { objectId, objectType, type: 'DynamicObject', name };
    }
  }
  throw new Error(`GraphQL ${url} returned dynamic field ${fieldAddress} with an unreadable value`);
}

async function readDynamicFieldsPage(url: string, parentId: string, after: string | null): Promise<DynamicFieldsPage> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GRAPHQL_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query: DYNAMIC_FIELDS_QUERY, variables: { parent: parentId, after } }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`GraphQL ${url} answered ${response.status}`);
    }
    const body: unknown = await response.json();
    if (!isRecord(body)) {
      throw new Error(`GraphQL ${url} answered with a body that is not an object`);
    }
    const errors = body.errors;
    if (errors !== undefined && errors !== null && !(Array.isArray(errors) && errors.length === 0)) {
      const first: unknown = Array.isArray(errors) ? errors[0] : undefined;
      const message = isRecord(first) ? first.message : undefined;
      throw new Error(`GraphQL ${url} returned errors${typeof message === 'string' ? `: ${message}` : ''}`);
    }
    const data = body.data;
    const address = isRecord(data) ? data.address : undefined;
    if (!isRecord(address)) {
      throw new Error(`GraphQL ${url} returned no address for ${parentId}`);
    }
    const connection = address.dynamicFields;
    const nodes = isRecord(connection) ? connection.nodes : undefined;
    if (!isRecord(connection) || !Array.isArray(nodes)) {
      throw new Error(`GraphQL ${url} returned no dynamic-field list for ${parentId}`);
    }
    const pageInfo = connection.pageInfo;
    const hasNextPage = isRecord(pageInfo) ? pageInfo.hasNextPage : undefined;
    const endCursor = isRecord(pageInfo) ? pageInfo.endCursor : undefined;
    if (typeof hasNextPage !== 'boolean') {
      throw new Error(`GraphQL ${url} returned the dynamic fields of ${parentId} without page info, so the list may be partial`);
    }
    if (hasNextPage && (typeof endCursor !== 'string' || endCursor === '')) {
      throw new Error(`GraphQL ${url} reported more dynamic fields of ${parentId} without a cursor to read them`);
    }
    return {
      fields: nodes.map((node, index) => parseNode(node, index, url)),
      hasNextPage,
      endCursor: typeof endCursor === 'string' ? endCursor : null,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Every dynamic field of `parentId` on `network`, read from Sui GraphQL across
 * all pages, in the DynamicFieldInfo keys JSON-RPC getDynamicFields gives.
 * Throws on a failed, malformed or partial read so the caller falls back to
 * JSON-RPC; it never returns a shortened or defaulted list. An empty list
 * means GraphQL answered, completely, that the object has no dynamic fields.
 */
export async function readDynamicFieldsViaGraphql(
  network: NetworkType,
  parentId: string,
): Promise<DynamicFieldReading[]> {
  const url = getGraphqlUrlForNetwork(network);
  if (!url) {
    throw new Error(`No Sui GraphQL URL is configured for ${network}`);
  }
  const fields: DynamicFieldReading[] = [];
  let after: string | null = null;
  for (let page = 0; page < DYNAMIC_FIELDS_MAX_PAGES; page += 1) {
    const result: DynamicFieldsPage = await readDynamicFieldsPage(url, parentId, after);
    fields.push(...result.fields);
    if (!result.hasNextPage) {
      return fields;
    }
    after = result.endCursor;
  }
  throw new Error(
    `GraphQL ${url} listed more than ${DYNAMIC_FIELDS_MAX_PAGES} pages of dynamic fields for ${parentId}; not returning a partial list`,
  );
}

/**
 * Every dynamic field of `parentId` read with JSON-RPC getDynamicFields,
 * following nextCursor to the last page: the fallback when Sui GraphQL cannot
 * answer. Fields come back exactly as JSON-RPC lists them. Throws when a page
 * fails or is unreadable, when more fields are reported without a cursor, or
 * past DYNAMIC_FIELDS_MAX_PAGES; the first page (or any partial list) is never
 * returned as the whole list.
 */
export async function readDynamicFieldsViaJsonRpc(
  client: DynamicFieldsJsonRpcClient,
  parentId: string,
): Promise<DynamicFieldReading[]> {
  const fields: DynamicFieldReading[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < DYNAMIC_FIELDS_MAX_PAGES; page += 1) {
    // The first page is asked for by parentId alone; a cursor is sent only
    // when following the nextCursor of the page before.
    const result: DynamicFieldsJsonRpcPage = await client.getDynamicFields(
      cursor === null ? { parentId } : { parentId, cursor },
    );
    if (!result || !Array.isArray(result.data) || typeof result.hasNextPage !== 'boolean') {
      throw new Error(`JSON-RPC getDynamicFields returned an unreadable page of dynamic fields for ${parentId}`);
    }
    fields.push(...result.data);
    if (!result.hasNextPage) {
      return fields;
    }
    if (typeof result.nextCursor !== 'string' || result.nextCursor === '') {
      throw new Error(`JSON-RPC getDynamicFields reported more dynamic fields for ${parentId} without a cursor to read them`);
    }
    cursor = result.nextCursor;
  }
  throw new Error(
    `JSON-RPC listed more than ${DYNAMIC_FIELDS_MAX_PAGES} pages of dynamic fields for ${parentId}; not returning a partial list`,
  );
}
