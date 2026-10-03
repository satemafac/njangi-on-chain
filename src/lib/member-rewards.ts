// member-rewards.ts — time-boxed Premium credits granted by the platform.
//
// Spec 003 decision 3 (2026-09-25): a Founding Circle badge comes with one
// free month of Premium for the circle's starter. This is the ONLY kind of
// reward the product gives, and it is deliberately not money: it never
// touches a pot, never waives a fee (there are none on fund flows), and is
// worth exactly the coordination features Premium unlocks.
//
// A reward is a row with a window. entitlement-gate consults
// hasActivePremiumReward() when a billing row resolves to 'free', so the
// grant needs no Stripe customer and expires on its own.

import { getSharedPgPool } from './pg-pool';

export const REWARD_TYPES = ['premium_month'] as const;
export type RewardType = (typeof REWARD_TYPES)[number];

export interface MemberReward {
  id: number;
  userAddress: string;
  rewardType: RewardType;
  months: number;
  source: string;
  startsAtMs: number;
  endsAtMs: number;
  grantedAtMs: number;
}

let setupPromise: Promise<void> | null = null;

function ensureTable(): Promise<void> {
  if (!setupPromise) {
    setupPromise = getSharedPgPool()
      .query(
        `CREATE TABLE IF NOT EXISTS member_rewards (
           id           BIGSERIAL PRIMARY KEY,
           user_address TEXT NOT NULL,
           reward_type  TEXT NOT NULL,
           months       INTEGER NOT NULL DEFAULT 1,
           source       TEXT NOT NULL,
           starts_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           ends_at      TIMESTAMPTZ NOT NULL,
           granted_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           UNIQUE (user_address, source)
         );
         CREATE INDEX IF NOT EXISTS member_rewards_active_idx
           ON member_rewards (user_address, ends_at);`,
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
  reward_type: string;
  months: number;
  source: string;
  starts_at: Date;
  ends_at: Date;
  granted_at: Date;
}

function toReward(r: Row): MemberReward {
  return {
    id: Number(r.id),
    userAddress: r.user_address,
    rewardType: r.reward_type as RewardType,
    months: r.months,
    source: r.source,
    startsAtMs: r.starts_at.getTime(),
    endsAtMs: r.ends_at.getTime(),
    grantedAtMs: r.granted_at.getTime(),
  };
}

/**
 * Grants `months` of Premium starting now. Idempotent per (address, source):
 * re-running the cron that found the same badge never stacks months.
 */
export async function grantPremiumMonths(input: {
  userAddress: string;
  months: number;
  source: string;
}): Promise<MemberReward | null> {
  const months = Math.max(1, Math.min(12, Math.floor(input.months)));
  await ensureTable();
  const { rows } = await getSharedPgPool().query<Row>(
    // $2 is cast explicitly on every use: Postgres deduces one type per
    // parameter, and the first version of this statement used $2 as both an
    // INTEGER and a text operand ("inconsistent types deduced for parameter
    // $2"), which silently lost the first Founding Circle grant in prod.
    `INSERT INTO member_rewards (user_address, reward_type, months, source, starts_at, ends_at)
     VALUES ($1, 'premium_month', $2::int, $3, NOW(), NOW() + make_interval(months => $2::int))
     ON CONFLICT (user_address, source) DO NOTHING
     RETURNING *`,
    [input.userAddress.toLowerCase(), months, input.source],
  );
  return rows[0] ? toReward(rows[0]) : null;
}

/** True when the member holds any reward whose window covers now. */
export async function hasActivePremiumReward(userAddress: string): Promise<boolean> {
  await ensureTable();
  const { rows } = await getSharedPgPool().query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM member_rewards
      WHERE user_address = $1 AND starts_at <= NOW() AND ends_at > NOW()`,
    [userAddress.toLowerCase()],
  );
  return Number(rows[0]?.n ?? 0) > 0;
}

export async function listRewards(userAddress: string): Promise<MemberReward[]> {
  await ensureTable();
  const { rows } = await getSharedPgPool().query<Row>(
    `SELECT * FROM member_rewards WHERE user_address = $1 ORDER BY granted_at DESC`,
    [userAddress.toLowerCase()],
  );
  return rows.map(toReward);
}
