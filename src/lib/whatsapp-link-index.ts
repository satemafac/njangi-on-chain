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

  await ensureTable();
  await getPool().query(
    `INSERT INTO whatsapp_phone_index (phone_hmac, circle_id, walrus_blob_id, link_type)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (phone_hmac, circle_id) DO UPDATE
       SET walrus_blob_id = EXCLUDED.walrus_blob_id,
           link_type = EXCLUDED.link_type`,
    [phoneHmac, params.circleId, params.walrusBlobId, params.linkType],
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
