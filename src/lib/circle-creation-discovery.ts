import { isResolvedSuiObjectId } from '@/lib/sui-object-id';

/**
 * Resolving the circle a creation transaction just made.
 *
 * The invite step used to find it by scanning up to 100 `CircleCreated`
 * events and taking the most recent one whose admin matched. That has two
 * problems, and production hit both on 2026-08-20: event history is served by
 * only some RPC endpoints and is the first thing rate-limited (the organiser
 * gets no invite link at all), and "most recent by this admin" is a guess —
 * create two circles in quick succession and it can name the wrong one.
 *
 * The signing call already returns the digest. That transaction's object
 * changes name the circle exactly, in one request, with no event history and
 * no heuristic.
 */

/** Type identity keeps the ORIGINAL package id across upgrades, so match the suffix. */
const CIRCLE_TYPE_SUFFIX = '::njangi_circles::Circle';

interface ObjectChangeLike {
  type?: string;
  objectType?: string;
  objectId?: string;
}

/**
 * Picks the created Circle out of a transaction's object changes.
 *
 * Returns null rather than a best guess when the transaction created no
 * circle, or somehow created more than one — a wrong id here would be spent
 * on an invite link, or worse reach a transaction builder.
 */
export function extractCreatedCircleId(
  objectChanges: readonly (ObjectChangeLike | null | undefined)[] | null | undefined,
): string | null {
  if (!objectChanges) return null;

  const created = objectChanges.filter((change) => {
    if (!change || change.type !== 'created') return false;
    const objectType = typeof change.objectType === 'string' ? change.objectType : '';
    // Exact suffix, so `CircleMembership` and friends never match.
    return objectType.endsWith(CIRCLE_TYPE_SUFFIX);
  });

  if (created.length !== 1) return null;

  const objectId = created[0]?.objectId;
  // Never hand an unresolved or zeroed id onward.
  return isResolvedSuiObjectId(objectId) ? objectId : null;
}

type CreationTxClient = {
  getTransactionBlock: (args: {
    digest: string;
    options?: { showObjectChanges?: boolean };
  }) => Promise<{ objectChanges?: readonly (ObjectChangeLike | null)[] | null }>;
};

export async function resolveCreatedCircleId(
  client: CreationTxClient,
  digest: string | null | undefined,
): Promise<string | null> {
  if (typeof digest !== 'string' || digest.trim().length === 0) return null;

  const tx = await client.getTransactionBlock({
    digest: digest.trim(),
    options: { showObjectChanges: true },
  });

  return extractCreatedCircleId(tx.objectChanges);
}
