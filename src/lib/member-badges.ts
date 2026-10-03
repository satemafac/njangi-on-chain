// member-badges.ts — facts about a member's own history, held for them.
//
// Spec: marketing/handoff/inbox/003-founder-moments-spec/SPEC.md §1.
//
// A badge is a recorded fact ("you started a circle that completed its first
// full round"), not a score, tier or rating. The rules that keep it that
// way live here and in the callers:
//  * shown ONLY on the member's own /record view (never in member lists,
//    never on a circle page, never in the shared-record payload);
//  * one badge type in v1, no levels;
//  * awarded by the server from on-chain facts (the CyclePaused event stream
//    is the trigger — pending the founder's decision on earn criteria), never
//    by a client request.

import { getSharedPgPool } from './pg-pool';

export const BADGE_TYPES = ['founding_circle'] as const;
export type BadgeType = (typeof BADGE_TYPES)[number];

export interface MemberBadge {
  id: number;
  userAddress: string;
  badgeType: BadgeType;
  circleId: string;
  awardedAtMs: number;
  sourceTx: string | null;
}

let setupPromise: Promise<void> | null = null;

function ensureTable(): Promise<void> {
  if (!setupPromise) {
    setupPromise = getSharedPgPool()
      .query(
        `CREATE TABLE IF NOT EXISTS member_badges (
           id           BIGSERIAL PRIMARY KEY,
           user_address TEXT NOT NULL,
           badge_type   TEXT NOT NULL,
           circle_id    TEXT NOT NULL,
           awarded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           source_tx    TEXT,
           UNIQUE (user_address, badge_type, circle_id)
         );
         CREATE INDEX IF NOT EXISTS member_badges_address_idx
           ON member_badges (user_address);`,
      )
      .then(() => undefined)
      .catch((err) => {
        setupPromise = null;
        throw err;
      });
  }
  return setupPromise;
}

interface Row {
  id: string | number;
  user_address: string;
  badge_type: string;
  circle_id: string;
  awarded_at: Date;
  source_tx: string | null;
}

function toBadge(r: Row): MemberBadge {
  return {
    id: Number(r.id),
    userAddress: r.user_address,
    badgeType: r.badge_type as BadgeType,
    circleId: r.circle_id,
    awardedAtMs: r.awarded_at.getTime(),
    sourceTx: r.source_tx,
  };
}

/** Idempotent: awarding the same badge twice for the same circle is a no-op. */
export async function awardBadge(input: {
  userAddress: string;
  badgeType: BadgeType;
  circleId: string;
  sourceTx?: string;
}): Promise<MemberBadge | null> {
  await ensureTable();
  const { rows } = await getSharedPgPool().query<Row>(
    `INSERT INTO member_badges (user_address, badge_type, circle_id, source_tx)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_address, badge_type, circle_id) DO NOTHING
     RETURNING *`,
    [input.userAddress.toLowerCase(), input.badgeType, input.circleId, input.sourceTx ?? null],
  );
  return rows[0] ? toBadge(rows[0]) : null;
}

export async function listBadges(userAddress: string): Promise<MemberBadge[]> {
  await ensureTable();
  const { rows } = await getSharedPgPool().query<Row>(
    `SELECT * FROM member_badges WHERE user_address = $1 ORDER BY awarded_at ASC`,
    [userAddress.toLowerCase()],
  );
  return rows.map(toBadge);
}
