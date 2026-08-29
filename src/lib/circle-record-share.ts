// circle-record-share.ts — expiring, revocable share links for a member's
// own Circle Record.
//
// The member is the sole distributor of their record; we never send it to
// anyone (see the FCRA note in circle-record.ts). This module holds the
// minimum needed to support that: an opaque token, the address it resolves
// to, and an expiry.
//
// Two rules the implementation enforces rather than documents:
//
//   1. EXPIRY IS MANDATORY. A link that never lapses is a permanent
//      disclosure, and the member cannot un-send it. Every token gets an
//      expiry, bounded by MAX_TTL_DAYS.
//   2. THE TOKEN CARRIES NO IDENTITY. It is random bytes. It must never
//      encode the address, `sub`, or anything else about the member — it
//      is handed to third parties by design.

import { randomBytes } from 'crypto';
import { getSharedPgPool, isPostgresConfigured } from './pg-pool';

export const DEFAULT_TTL_DAYS = 30;
export const MAX_TTL_DAYS = 90;
export const MIN_TTL_DAYS = 1;

export interface ShareToken {
  token: string;
  userAddress: string;
  createdAtMs: number;
  expiresAtMs: number;
}

let setupPromise: Promise<void> | null = null;

/** Lazy self-creation race guard, mirroring the other registries. */
function ensureTable(): Promise<void> {
  if (!setupPromise) {
    setupPromise = getSharedPgPool()
      .query(
        `CREATE TABLE IF NOT EXISTS record_share_tokens (
           token        TEXT PRIMARY KEY,
           user_address TEXT NOT NULL,
           created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           expires_at   TIMESTAMPTZ NOT NULL,
           revoked_at   TIMESTAMPTZ
         );
         CREATE INDEX IF NOT EXISTS record_share_tokens_address_idx
           ON record_share_tokens (user_address);
         CREATE INDEX IF NOT EXISTS record_share_tokens_expires_idx
           ON record_share_tokens (expires_at);`,
      )
      .then(() => undefined)
      .catch((err) => {
        setupPromise = null;
        throw err;
      });
  }
  return setupPromise;
}

/** 32 random bytes, URL-safe. Opaque by construction. */
export function generateShareToken(): string {
  return randomBytes(24).toString('base64url');
}

export function clampTtlDays(requested: unknown): number {
  const n = typeof requested === 'number' ? requested : Number(requested);
  if (!Number.isFinite(n)) return DEFAULT_TTL_DAYS;
  return Math.min(MAX_TTL_DAYS, Math.max(MIN_TTL_DAYS, Math.floor(n)));
}

export async function createShareToken(
  userAddress: string,
  ttlDays: number = DEFAULT_TTL_DAYS,
): Promise<ShareToken> {
  await ensureTable();
  const token = generateShareToken();
  const days = clampTtlDays(ttlDays);
  const { rows } = await getSharedPgPool().query(
    `INSERT INTO record_share_tokens (token, user_address, expires_at)
     VALUES ($1, $2, NOW() + ($3::int * INTERVAL '1 day'))
     RETURNING token, user_address, created_at, expires_at`,
    [token, userAddress.trim().toLowerCase(), days],
  );
  const row = rows[0];
  return {
    token: row.token,
    userAddress: row.user_address,
    createdAtMs: new Date(row.created_at).getTime(),
    expiresAtMs: new Date(row.expires_at).getTime(),
  };
}

/**
 * Resolves a token to the address whose record it exposes.
 *
 * Returns null for unknown, expired, or revoked tokens — the caller must
 * not distinguish between them to a visitor, since doing so would leak
 * whether a given token ever existed.
 */
export async function resolveShareToken(token: string): Promise<string | null> {
  if (!token || !isPostgresConfigured()) return null;
  await ensureTable();
  const { rows } = await getSharedPgPool().query(
    `SELECT user_address
       FROM record_share_tokens
      WHERE token = $1
        AND revoked_at IS NULL
        AND expires_at > NOW()`,
    [token],
  );
  return rows[0]?.user_address ?? null;
}

/** Lists a member's live links so they can see what they have handed out. */
export async function listShareTokens(userAddress: string): Promise<ShareToken[]> {
  if (!isPostgresConfigured()) return [];
  await ensureTable();
  const { rows } = await getSharedPgPool().query(
    `SELECT token, user_address, created_at, expires_at
       FROM record_share_tokens
      WHERE user_address = $1
        AND revoked_at IS NULL
        AND expires_at > NOW()
      ORDER BY created_at DESC`,
    [userAddress.trim().toLowerCase()],
  );
  return rows.map((row) => ({
    token: row.token,
    userAddress: row.user_address,
    createdAtMs: new Date(row.created_at).getTime(),
    expiresAtMs: new Date(row.expires_at).getTime(),
  }));
}

/**
 * Revokes a token, but only for its owner — the address is part of the
 * WHERE clause so possessing a token is not sufficient to revoke it.
 * Returns true if a live token was revoked.
 */
export async function revokeShareToken(
  userAddress: string,
  token: string,
): Promise<boolean> {
  await ensureTable();
  const { rowCount } = await getSharedPgPool().query(
    `UPDATE record_share_tokens
        SET revoked_at = NOW()
      WHERE token = $1
        AND user_address = $2
        AND revoked_at IS NULL`,
    [token, userAddress.trim().toLowerCase()],
  );
  return (rowCount ?? 0) > 0;
}
