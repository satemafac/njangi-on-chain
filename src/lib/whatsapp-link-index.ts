// whatsapp-link-index.ts — O(1) phone → circle resolution for the WhatsApp
// webhook. The Phase 1 implementation scanned every on-chain link and
// fetched + decrypted the corresponding Walrus blob (O(N) per inbound
// message). This module replaces that with a Postgres index keyed by an
// HMAC of the normalized phone number.
//
// The HMAC is computed with `WALRUS_LOOKUP_SALT` (server-only secret) so
// the raw phone number never leaves the encrypted Walrus envelope. The
// salt is rotated independently of the AES master key; rotating the salt
// requires re-running an indexing job over existing on-chain links.

import type { Pool } from 'pg';
import { computeLookupHash } from './walrus-pii';
import { getSharedPgPool, isPostgresConfigured } from './pg-pool';

let setupPromise: Promise<void> | null = null;

const memoryFallback = new Map<string, WhatsAppPhoneIndexRow[]>();
let memoryWarned = false;

export interface WhatsAppPhoneIndexRow {
  circleId: string;
  walrusBlobId: string;
  linkType: 1 | 2;
}

function isPostgresAvailable(): boolean {
  return isPostgresConfigured();
}

// Shared lazy pool (SSL resolved from sslmode/PGSSLMODE, verified TLS by
// default in production) — see src/lib/pg-pool.ts.
function getPool(): Pool {
  return getSharedPgPool();
}

async function ensureTable(): Promise<void> {
  if (!setupPromise) {
    setupPromise = getPool().query(`
      CREATE TABLE IF NOT EXISTS whatsapp_phone_index (
        id SERIAL PRIMARY KEY,
        phone_hmac TEXT NOT NULL,
        circle_id TEXT NOT NULL,
        walrus_blob_id TEXT NOT NULL,
        link_type SMALLINT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(phone_hmac, circle_id)
      );
      CREATE INDEX IF NOT EXISTS whatsapp_phone_index_hmac_idx
        ON whatsapp_phone_index (phone_hmac);
      -- walrus_end_epoch: storage lease end epoch tracked so
      -- /api/cron/walrus-renewal knows when to re-store a blob before it
      -- expires. NULL on rows written before this column existed → the
      -- renewal cron treats them as "expiry unknown, renew once to learn".
      ALTER TABLE whatsapp_phone_index
        ADD COLUMN IF NOT EXISTS walrus_end_epoch BIGINT;
    `).then(() => undefined);
  }
  return setupPromise;
}

function normalizePhone(value: string): string {
  return value.replace(/^\+/, '').trim();
}

function warnFallbackOnce() {
  if (!memoryWarned) {
    console.warn(
      '[whatsapp-link-index] DATABASE_URL not configured; using in-memory index. ' +
        'This is acceptable for local development only — production must configure Postgres.',
    );
    memoryWarned = true;
  }
}

/**
 * Records a (phone_hmac, circle_id, blob_id) tuple at link time. Idempotent
 * via the unique (phone_hmac, circle_id) constraint, so repeated calls for
 * the same link are safe.
 */
export async function indexWhatsAppLink(params: {
  phoneOrGroup: string;
  circleId: string;
  walrusBlobId: string;
  linkType: 1 | 2;
  /** Walrus storage end epoch, when the link flow captured it. */
  walrusEndEpoch?: number | null;
}): Promise<void> {
  const phoneHmac = await computeLookupHash(normalizePhone(params.phoneOrGroup));
  const row: WhatsAppPhoneIndexRow = {
    circleId: params.circleId,
    walrusBlobId: params.walrusBlobId,
    linkType: params.linkType,
  };

  if (!isPostgresAvailable()) {
    warnFallbackOnce();
    const existing = memoryFallback.get(phoneHmac) ?? [];
    if (!existing.some((r) => r.circleId === row.circleId)) {
      existing.push(row);
      memoryFallback.set(phoneHmac, existing);
    }
    return;
  }

  const endEpoch =
    typeof params.walrusEndEpoch === 'number' && Number.isFinite(params.walrusEndEpoch)
      ? params.walrusEndEpoch
      : null;

  await ensureTable();
  await getPool().query(
    `INSERT INTO whatsapp_phone_index (phone_hmac, circle_id, walrus_blob_id, link_type, walrus_end_epoch)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (phone_hmac, circle_id) DO UPDATE
       SET walrus_blob_id = EXCLUDED.walrus_blob_id,
           link_type = EXCLUDED.link_type,
           walrus_end_epoch = EXCLUDED.walrus_end_epoch`,
    [phoneHmac, params.circleId, params.walrusBlobId, params.linkType, endEpoch],
  );
}

/**
 * Removes index rows for a circle (e.g. after `unlink_circle`). Without this,
 * the webhook would route messages to disabled links.
 */
export async function deindexWhatsAppLinksForCircle(circleId: string): Promise<void> {
  if (!isPostgresAvailable()) {
    warnFallbackOnce();
    for (const [hmac, rows] of memoryFallback.entries()) {
      const filtered = rows.filter((r) => r.circleId !== circleId);
      if (filtered.length === 0) {
        memoryFallback.delete(hmac);
      } else if (filtered.length !== rows.length) {
        memoryFallback.set(hmac, filtered);
      }
    }
    return;
  }
  await ensureTable();
  await getPool().query('DELETE FROM whatsapp_phone_index WHERE circle_id = $1', [circleId]);
}

/**
 * Returns the Walrus blob ids linked to a circle, newest first. The
 * whatsapp-circle-events cron uses this for O(1) circle → phone
 * resolution (decrypting only the matched blob) before falling back to
 * the on-chain registry scan. The phone itself is never stored here —
 * only its HMAC — so callers must still decrypt the blob.
 */
export async function lookupBlobsForCircle(
  circleId: string,
): Promise<string[]> {
  if (!isPostgresAvailable()) {
    warnFallbackOnce();
    const blobs: string[] = [];
    for (const rows of memoryFallback.values()) {
      for (const row of rows) {
        if (row.circleId === circleId) blobs.push(row.walrusBlobId);
      }
    }
    return blobs.reverse();
  }

  await ensureTable();
  const result = await getPool().query<{ walrus_blob_id: string }>(
    `SELECT walrus_blob_id FROM whatsapp_phone_index
      WHERE circle_id = $1
      ORDER BY id DESC`,
    [circleId],
  );
  return result.rows.map((row) => row.walrus_blob_id);
}

/**
 * Returns every circle linked to the supplied phone number. The webhook
 * uses this to skip the O(N) Walrus scan and fall straight through to the
 * decrypt step (which still happens, but only for the matched blob).
 */
export async function lookupCirclesForPhone(
  phoneOrGroup: string,
): Promise<WhatsAppPhoneIndexRow[]> {
  const phoneHmac = await computeLookupHash(normalizePhone(phoneOrGroup));

  if (!isPostgresAvailable()) {
    warnFallbackOnce();
    return memoryFallback.get(phoneHmac) ?? [];
  }

  await ensureTable();
  const result = await getPool().query<{
    circle_id: string;
    walrus_blob_id: string;
    link_type: number;
  }>(
    'SELECT circle_id, walrus_blob_id, link_type FROM whatsapp_phone_index WHERE phone_hmac = $1',
    [phoneHmac],
  );

  return result.rows.map((row) => ({
    circleId: row.circle_id,
    walrusBlobId: row.walrus_blob_id,
    linkType: row.link_type === 2 ? 2 : 1,
  }));
}

// ---------------------------------------------------------------------------
// Walrus blob renewal support (/api/cron/walrus-renewal)
// ---------------------------------------------------------------------------

let renewalAuditTableReady: Promise<void> | null = null;

/** One row the renewal cron may re-store. */
export interface RenewableLinkRow {
  id: number;
  circleId: string;
  walrusBlobId: string;
  walrusEndEpoch: number | null;
}

function ensureRenewalAuditTable(): Promise<void> {
  if (!renewalAuditTableReady) {
    renewalAuditTableReady = getPool()
      .query(`
        CREATE TABLE IF NOT EXISTS walrus_renewal_audit (
          id BIGSERIAL PRIMARY KEY,
          index_row_id INTEGER NOT NULL,
          circle_id TEXT NOT NULL,
          old_blob_id TEXT NOT NULL,
          new_blob_id TEXT NOT NULL,
          old_end_epoch BIGINT,
          new_end_epoch BIGINT,
          renewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS walrus_renewal_audit_circle_idx
          ON walrus_renewal_audit (circle_id, renewed_at DESC);
      `)
      .then(() => undefined)
      .catch((err) => {
        renewalAuditTableReady = null;
        throw err;
      });
  }
  return renewalAuditTableReady;
}

/**
 * Every active link, for the renewal cron to evaluate. The phone HMAC is
 * intentionally NOT returned — renewal re-stores by blob id and never needs
 * the phone. Requires Postgres (the in-memory fallback has no expiry data
 * and is dev-only); throws when unavailable so the cron fails closed rather
 * than silently renewing nothing.
 */
export async function listActiveLinksForRenewal(): Promise<RenewableLinkRow[]> {
  if (!isPostgresAvailable()) {
    throw new Error(
      'listActiveLinksForRenewal requires Postgres; the in-memory index has no expiry data.',
    );
  }
  await ensureTable();
  const result = await getPool().query<{
    id: number;
    circle_id: string;
    walrus_blob_id: string;
    walrus_end_epoch: string | number | null;
  }>(
    `SELECT id, circle_id, walrus_blob_id, walrus_end_epoch
       FROM whatsapp_phone_index
      ORDER BY id ASC`,
  );
  return result.rows.map((row) => ({
    id: row.id,
    circleId: row.circle_id,
    walrusBlobId: row.walrus_blob_id,
    // BIGINT comes back as a string from node-pg; normalize to number|null.
    walrusEndEpoch:
      row.walrus_end_epoch === null || row.walrus_end_epoch === undefined
        ? null
        : Number(row.walrus_end_epoch),
  }));
}

/**
 * Compare-and-set: points index row `id` at the renewed blob + end epoch
 * AND records an audit row, in ONE transaction, but only while the row
 * still references `expectedBlobId`. Returns false when the row no longer
 * matches (an overlapping renewal run already advanced it) so the caller
 * counts it as a raced duplicate, never a double-renew. The audit row is
 * only written when the UPDATE lands, so the audit log never claims a
 * renewal that did not take effect.
 */
export async function applyWalrusRenewal(params: {
  id: number;
  expectedBlobId: string;
  newBlobId: string;
  newEndEpoch: number;
}): Promise<boolean> {
  if (!isPostgresAvailable()) {
    throw new Error('applyWalrusRenewal requires Postgres.');
  }
  await ensureTable();
  await ensureRenewalAuditTable();

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    // Capture the pre-update end epoch (and circle id, for the audit row)
    // BEFORE the UPDATE overwrites it, gated on the same blob id so the
    // SELECT and UPDATE see a consistent row inside the transaction.
    const before = await client.query<{
      circle_id: string;
      walrus_end_epoch: string | number | null;
    }>(
      `SELECT circle_id, walrus_end_epoch
         FROM whatsapp_phone_index
        WHERE id = $1 AND walrus_blob_id = $2
        FOR UPDATE`,
      [params.id, params.expectedBlobId],
    );

    if ((before.rowCount ?? 0) === 0) {
      // Row already renewed by an overlapping run (CAS missed). No audit row.
      await client.query('ROLLBACK');
      return false;
    }

    const beforeRow = before.rows[0];
    const oldEndEpoch =
      beforeRow.walrus_end_epoch === null || beforeRow.walrus_end_epoch === undefined
        ? null
        : Number(beforeRow.walrus_end_epoch);

    await client.query(
      `UPDATE whatsapp_phone_index
          SET walrus_blob_id = $2, walrus_end_epoch = $3
        WHERE id = $1`,
      [params.id, params.newBlobId, params.newEndEpoch],
    );

    await client.query(
      `INSERT INTO walrus_renewal_audit
         (index_row_id, circle_id, old_blob_id, new_blob_id, old_end_epoch, new_end_epoch)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        params.id,
        beforeRow.circle_id,
        params.expectedBlobId,
        params.newBlobId,
        oldEndEpoch,
        params.newEndEpoch,
      ],
    );
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Test helper — resets the renewal-audit table-creation latch. */
export function __resetWhatsAppLinkIndexForTests(): void {
  setupPromise = null;
  renewalAuditTableReady = null;
}
