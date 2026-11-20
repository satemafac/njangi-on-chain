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

/**
 * Whether `userAddress` is CURRENTLY the admin or a member of `circleId`, read
 * live from the circle and its members table: the verification step a receipt
 * needs. Null when the chain could not be read. An RPC outage is not "not a
 * member", and treating it as one hid the user's circles on a bad RPC day.
 */
export async function isCurrentMemberOrAdmin(
  client: SuiClient,
  circleId: string,
  userAddress: string,
): Promise<boolean | null> {
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
