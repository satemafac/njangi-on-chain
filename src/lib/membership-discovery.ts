// membership-discovery.ts — Scalable "which circles is this user a member of"
// discovery via owned membership receipts.
//
// The Move contract mints a soulbound `CircleMembership { circle_id, member,
// joined_at }` object to each member when they join. Because it's an
// address-owned object, the chain indexes it: `getOwnedObjects` filtered by
// type returns ONLY this user's receipts — O(the user's memberships), not a
// scan of the global `MemberJoined` event stream (which can't be filtered by
// member address server-side).
//
// The receipt is a discovery HINT, not the source of truth: each returned
// circle id is a candidate that the caller verifies against the circle's
// `members` table. A receipt left behind after a removal is simply filtered out
// at verification time, so we never need to reach into the member's wallet.
//
// IMPORTANT: Move struct types stay anchored to the package's ORIGINAL id
// across upgrades, so the StructType filter MUST use originalId, not
// published-at.
//
// Transport: Sui's GraphQL service is asked first. It lists an address's
// objects by type even when every JSON-RPC endpoint refuses JSON-RPC (NJA-2830).
// `getOwnedObjects` over the JSON-RPC failover pool is the fallback. A failed
// GraphQL read is never "no receipts": it goes to the fallback, and when
// neither source answers the call throws so the caller marks its scan
// incomplete.

import type { SuiClient } from '@mysten/sui/client';
import { getCurrentNetwork, getGraphqlUrlForNetwork, type NetworkType } from '@/services/network-config';
import { getPooledSuiClient } from '@/services/sui-rpc-failover';
import { getPublishedPackageMetadata } from './circle-chain';
import { cachedRead, isGoneObjectResponse } from './sui-read';

const MEMBERSHIP_STRUCT_SUFFIX = 'njangi_circles::CircleMembership';

/** Bound on pagination so a pathological account can't loop forever. Each page
 *  is up to 50 objects, so this covers 1000 memberships — far beyond any real
 *  user. We log if it's ever hit rather than silently truncating. */
const MAX_MEMBERSHIP_PAGES = 20;

interface MembershipReceiptFields {
  circle_id?: string;
}

/** How long one GraphQL page may take before it counts as a failed read. */
const GRAPHQL_TIMEOUT_MS = 8_000;

/** The owner's objects of the receipt type, 50 per page (the size of a
 *  `getOwnedObjects` page, so MAX_MEMBERSHIP_PAGES bounds both sources alike). */
const MEMBERSHIP_RECEIPTS_QUERY = `query ($owner: SuiAddress!, $type: String!, $after: String) {
  address(address: $owner) {
    objects(first: 50, after: $after, filter: { type: $type }) {
      pageInfo { hasNextPage endCursor }
      nodes { address contents { type { repr } json } }
    }
  }
}`;

interface GraphqlReceiptPageBody {
  data?: {
    address?: {
      objects?: {
        pageInfo?: { hasNextPage?: unknown; endCursor?: unknown } | null;
        nodes?: unknown;
      } | null;
    } | null;
  } | null;
  errors?: unknown;
}

interface GraphqlReceiptNode {
  address?: unknown;
  contents?: { json?: { circle_id?: unknown } | null } | null;
}

interface ReceiptPage {
  circleIds: string[];
  nextCursor: string | null;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One page of `owner`'s receipts from Sui GraphQL. Throws on any failed or
 * partial read (error status, an `errors` body, no `nodes` list, no
 * `pageInfo`, a next page without a cursor, a receipt without a readable
 * `circle_id`): a bad answer is never read as "no receipts", and no receipt is
 * silently skipped.
 */
async function fetchReceiptPageViaGraphql(
  url: string,
  owner: string,
  structType: string,
  after: string | null,
): Promise<ReceiptPage> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GRAPHQL_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        query: MEMBERSHIP_RECEIPTS_QUERY,
        variables: { owner, type: structType, after },
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`GraphQL ${url} answered ${response.status}`);
    }
    const body = (await response.json()) as GraphqlReceiptPageBody | null;
    const errors = body?.errors;
    if (errors !== undefined && errors !== null && !(Array.isArray(errors) && errors.length === 0)) {
      const reason = Array.isArray(errors) ? (errors[0] as { message?: unknown } | null)?.message : undefined;
      throw new Error(`GraphQL ${url} returned errors${typeof reason === 'string' ? `: ${reason}` : ''}`);
    }
    const objects = body?.data?.address?.objects;
    const nodes = objects?.nodes;
    if (!Array.isArray(nodes)) {
      throw new Error(`GraphQL ${url} returned no object list for ${owner}`);
    }
    const pageInfo = objects?.pageInfo;
    if (!pageInfo || typeof pageInfo.hasNextPage !== 'boolean') {
      throw new Error(`GraphQL ${url} returned no pageInfo for ${owner}`);
    }
    let nextCursor: string | null = null;
    if (pageInfo.hasNextPage) {
      const endCursor = pageInfo.endCursor;
      if (typeof endCursor !== 'string' || endCursor === '') {
        throw new Error(`GraphQL ${url} reported another page for ${owner} without a cursor`);
      }
      nextCursor = endCursor;
    }
    const circleIds = nodes.map((node: GraphqlReceiptNode | null) => {
      const circleId = node?.contents?.json?.circle_id;
      if (typeof circleId !== 'string' || circleId === '') {
        throw new Error(`GraphQL ${url} returned receipt ${String(node?.address)} without a readable circle_id`);
      }
      return circleId;
    });
    return { circleIds, nextCursor };
  } finally {
    clearTimeout(timer);
  }
}

/** Every receipt of `userAddress` from Sui GraphQL, following `endCursor` while
 *  `hasNextPage`. Throws if any page fails, so a partial list is never returned. */
async function readReceiptsViaGraphql(
  network: NetworkType,
  userAddress: string,
  structType: string,
): Promise<string[]> {
  const url = getGraphqlUrlForNetwork(network);
  const circleIds = new Set<string>();
  let cursor: string | null = null;
  let pages = 0;

  do {
    const page: ReceiptPage = await fetchReceiptPageViaGraphql(url, userAddress, structType, cursor);
    for (const circleId of page.circleIds) {
      circleIds.add(circleId);
    }

    cursor = page.nextCursor;
    pages += 1;

    if (pages >= MAX_MEMBERSHIP_PAGES && cursor) {
      console.warn(
        `[membership-discovery] Stopped after ${MAX_MEMBERSHIP_PAGES} pages for ${userAddress}; some memberships may be omitted.`,
      );
      break;
    }
  } while (cursor);

  return Array.from(circleIds);
}

/** Every receipt of `userAddress` from `getOwnedObjects` over the JSON-RPC
 *  failover pool: the fallback when GraphQL fails. */
async function readReceiptsViaJsonRpc(
  network: NetworkType,
  userAddress: string,
  structType: string,
): Promise<string[]> {
  const client = getPooledSuiClient({ network });
  const circleIds = new Set<string>();
  let cursor: string | null | undefined;
  let pages = 0;

  do {
    const res = await client.getOwnedObjects({
      owner: userAddress,
      filter: { StructType: structType },
      options: { showContent: true },
      cursor: cursor ?? undefined,
    });

    for (const item of res.data) {
      const content = item.data?.content;
      if (content && 'fields' in content) {
        const fields = content.fields as MembershipReceiptFields;
        if (fields.circle_id) {
          circleIds.add(fields.circle_id);
        }
      }
    }

    cursor = res.hasNextPage ? res.nextCursor : null;
    pages += 1;

    if (pages >= MAX_MEMBERSHIP_PAGES && cursor) {
      console.warn(
        `[membership-discovery] Stopped after ${MAX_MEMBERSHIP_PAGES} pages for ${userAddress}; some memberships may be omitted.`,
      );
      break;
    }
  } while (cursor);

  return Array.from(circleIds);
}

/**
 * Returns the set of circle ids this address holds a membership receipt for.
 * Server-side filtered + cursor-paginated + cached. Empty array if the package
 * lineage is unknown or the user holds no receipts (e.g. memberships predating
 * the receipt upgrade — those still surface via the legacy event scan).
 */
export async function discoverMemberCircleIds(
  userAddress: string,
  opts: { network?: NetworkType; ttlMs?: number } = {},
): Promise<string[]> {
  const network = opts.network ?? getCurrentNetwork();
  const { originalId } = getPublishedPackageMetadata(network);
  if (!originalId) {
    return [];
  }

  const structType = `${originalId}::${MEMBERSHIP_STRUCT_SUFFIX}`;
  const cacheKey = `membership:${network}:${userAddress}`;

  return cachedRead(cacheKey, async () => {
    let graphqlError: unknown;
    try {
      return await readReceiptsViaGraphql(network, userAddress, structType);
    } catch (error) {
      graphqlError = error;
      console.warn(
        `[membership-discovery] GraphQL receipt read failed on ${network}, trying JSON-RPC: ${describeError(error)}`,
      );
    }

    // Partial GraphQL pages are discarded: the JSON-RPC answer stands alone.
    try {
      return await readReceiptsViaJsonRpc(network, userAddress, structType);
    } catch (rpcError) {
      // Neither source answered: throw (never `[]`) so the caller marks its
      // scan incomplete; `cachedRead` does not cache the failure.
      throw Object.assign(
        new Error(
          `[membership-discovery] no source listed the receipts of ${userAddress} on ${network}. GraphQL: ${describeError(graphqlError)}. JSON-RPC: ${describeError(rpcError)}`,
        ),
        { cause: rpcError },
      );
    }
  }, opts.ttlMs);
}

/** The circle, read through object(...): its `json` carries `admin` and
 *  `members` as `{ id, size }`. */
const CIRCLE_MEMBERSHIP_QUERY = `query ($id: SuiAddress!) {
  object(address: $id) { asMoveObject { contents { json } } }
}`;

/** One entry of a circle's members table, read through address(...) on the
 *  table id and named by the member's BCS bytes (its 32 address bytes). A
 *  Table's id is not an object, so object(address: <table id>) answers
 *  `object: null` for every table (NJA-2909); address(...) answers
 *  `dynamicField: null` for a non-member. */
const MEMBERS_ENTRY_QUERY = `query ($table: SuiAddress!, $bcs: Base64!) {
  address(address: $table) {
    dynamicField(name: { type: "address", bcs: $bcs }) { name { json } }
  }
}`;

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** `value[key]` when `value` is a plain object, otherwise undefined. */
function readField(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/** The 64 lowercase hex digits of a Sui address (left-padded), or null when
 *  `address` is not one. */
function addressHex(address: string): string | null {
  const hex = address.toLowerCase().replace(/^0x/, '');
  return hex !== '' && hex.length <= 64 && /^[0-9a-f]+$/.test(hex) ? hex.padStart(64, '0') : null;
}

/** Base64 of the bytes an even-length hex string spells. */
function hexToBase64(hex: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < hex.length; i += 2) {
    bytes.push(parseInt(hex.slice(i, i + 2), 16));
  }
  let encoded = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const triple = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    encoded += BASE64_ALPHABET.charAt((triple >> 18) & 63);
    encoded += BASE64_ALPHABET.charAt((triple >> 12) & 63);
    encoded += i + 1 < bytes.length ? BASE64_ALPHABET.charAt((triple >> 6) & 63) : '=';
    encoded += i + 2 < bytes.length ? BASE64_ALPHABET.charAt(triple & 63) : '=';
  }
  return encoded;
}

/** The `data` of one Sui GraphQL query. Throws on a failed or timed-out
 *  request, an error status, an `errors` body or no `data` object: none of
 *  them is an answer. */
async function queryGraphqlData(url: string, query: string, variables: Record<string, string>): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GRAPHQL_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`GraphQL ${url} answered ${response.status}`);
    }
    const body: unknown = await response.json();
    const errors = readField(body, 'errors');
    if (errors !== undefined && errors !== null && !(Array.isArray(errors) && errors.length === 0)) {
      const reason = Array.isArray(errors) ? readField(errors[0], 'message') : undefined;
      throw new Error(`GraphQL ${url} returned errors${typeof reason === 'string' ? `: ${reason}` : ''}`);
    }
    const data = readField(body, 'data');
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      throw new Error(`GraphQL ${url} returned no data`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether `userAddress` is the admin or a member of `circleId`, from Sui
 * GraphQL. Resolves only on a confirmed answer: true for the admin or an entry
 * in the members table; false when the service says the circle is not there
 * (`object: null`) or the table holds no entry for the address
 * (`dynamicField: null`). Throws on anything else (a failed request, `errors`,
 * no `data`, `address: null`, a circle without a string `admin` and
 * `members.id`), so an unreadable answer is never "not a member".
 */
async function readMembershipViaGraphql(url: string, circleId: string, userAddress: string): Promise<boolean> {
  const userHex = addressHex(userAddress);
  if (userHex === null) {
    throw new Error(`${userAddress} is not a Sui address`);
  }

  const circle = readField(await queryGraphqlData(url, CIRCLE_MEMBERSHIP_QUERY, { id: circleId }), 'object');
  if (circle === null) {
    return false; // `object: null` with no errors: the circle is gone.
  }
  const json = readField(readField(readField(circle, 'asMoveObject'), 'contents'), 'json');
  const admin = readField(json, 'admin');
  const membersTableId = readField(readField(json, 'members'), 'id');
  const adminHex = typeof admin === 'string' ? addressHex(admin) : null;
  if (adminHex === null || typeof membersTableId !== 'string' || membersTableId === '') {
    throw new Error(`GraphQL ${url} returned circle ${circleId} without a readable admin and members table`);
  }
  if (adminHex === userHex) {
    return true;
  }

  const table = readField(
    await queryGraphqlData(url, MEMBERS_ENTRY_QUERY, { table: membersTableId, bcs: hexToBase64(userHex) }),
    'address',
  );
  const entry = readField(table, 'dynamicField');
  // `address: null`, no `address`, or no `dynamicField` in it: not an answer.
  if (entry === undefined) {
    throw new Error(`GraphQL ${url} returned no answer for members table ${membersTableId}`);
  }
  if (entry === null) {
    return false; // The table answered and holds no entry for this address.
  }
  if (typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`GraphQL ${url} returned an unreadable members entry in ${membersTableId}`);
  }
  return true;
}

/** The current network's GraphQL URL, or null when there is none to ask (no
 *  configured URL, no `fetch`): then only JSON-RPC is asked. */
function membershipGraphqlUrl(): string | null {
  if (
    typeof fetch !== 'function' ||
    typeof getCurrentNetwork !== 'function' ||
    typeof getGraphqlUrlForNetwork !== 'function'
  ) {
    return null;
  }
  const url: unknown = getGraphqlUrlForNetwork(getCurrentNetwork());
  return typeof url === 'string' && url !== '' ? url : null;
}

/**
 * Whether `userAddress` is CURRENTLY the admin or a member of `circleId`, read
 * live from the circle and its members table: the verification step a receipt
 * needs. Null when the chain could not be read. An RPC outage is not "not a
 * member", and treating it as one hid the user's circles on a bad RPC day.
 *
 * Sui GraphQL is asked first, as for receipt discovery: it still answers when
 * every JSON-RPC endpoint refuses JSON-RPC (NJA-2830). A GraphQL read that is
 * not a confirmed answer goes to `client.getObject` /
 * `client.getDynamicFieldObject`, whose answer stands alone; when that read
 * fails too the answer is null, never false.
 */
export async function isCurrentMemberOrAdmin(
  client: SuiClient,
  circleId: string,
  userAddress: string,
): Promise<boolean | null> {
  try {
    const url = membershipGraphqlUrl();
    if (url !== null) {
      return await readMembershipViaGraphql(url, circleId, userAddress);
    }
  } catch (error) {
    console.warn(
      `[membership-discovery] GraphQL membership read of ${circleId} failed, trying JSON-RPC: ${describeError(error)}`,
    );
  }

  let circle;
  try {
    circle = await client.getObject({ id: circleId, options: { showContent: true } });
  } catch {
    return null;
  }
  if (circle.error) {
    return isGoneObjectResponse(circle) ? false : null;
  }
  const content = circle.data?.content;
  if (!content || content.dataType !== 'moveObject') return null;
  const fields = content.fields as {
    admin?: string;
    members?: { fields?: { id?: { id?: string } } };
  };
  if (fields.admin === userAddress) return true;
  const membersTableId = fields.members?.fields?.id?.id;
  if (!membersTableId) return null;

  let member;
  try {
    member = await client.getDynamicFieldObject({
      parentId: membersTableId,
      name: { type: 'address', value: userAddress },
    });
  } catch {
    return null;
  }
  if (member.error) {
    return member.error.code === 'dynamicFieldNotFound' ? false : null;
  }
  return member.data?.content ? true : null;
}
