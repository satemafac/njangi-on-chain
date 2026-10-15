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

import type { SuiClient } from '@mysten/sui/client';
import { getCurrentNetwork, type NetworkType } from '@/services/network-config';
import { getPooledSuiClient } from '@/services/sui-rpc-failover';
import { getPublishedPackageMetadata } from './circle-chain';
import { cachedRead } from './sui-read';

const MEMBERSHIP_STRUCT_SUFFIX = 'njangi_circles::CircleMembership';

/** Bound on pagination so a pathological account can't loop forever. Each page
 *  is up to 50 objects, so this covers 1000 memberships — far beyond any real
 *  user. We log if it's ever hit rather than silently truncating. */
const MAX_MEMBERSHIP_PAGES = 20;

interface MembershipReceiptFields {
  circle_id?: string;
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
  }, opts.ttlMs);
}

// The chain's own words for "this object is not there", as opposed to "could
// not be read".
const OBJECT_GONE = new Set(['notExists', 'deleted']);

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
    return OBJECT_GONE.has(circle.error.code) ? false : null;
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
