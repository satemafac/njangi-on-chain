// whatsapp-pii-keys.ts — The per-link data keys behind WhatsApp PII
// envelopes (envelope v2, src/lib/walrus-pii.ts), one Postgres row per link
// in `whatsapp_pii_keys`, keyed by the key id the envelope carries.
//
// Walrus blobs are public, can't be changed or deleted by us, and their ids
// are on chain; the renewal cron also writes a fresh copy every few epochs.
// So a link is erased by deleting its key, not its blobs: the row holds the
// only copy of the link's data key (wrapped under the KEK, see
// scripts/lib/pii-key-wrap.ts), and once it is gone no copy of the envelope
// opens, the anchored one, the renewed ones or one someone kept.
//
// Lifecycle of a row:
//   * Link (admin-link-circle, prepare step): created BEFORE the envelope is
//     uploaded, with the HMAC of the number (the same `phone_hmac` as
//     whatsapp_phone_index), the circle and the link nonce the anchor will
//     carry. An upload that fails deletes it again.
//   * Unlink: admin-unlink-circle marks the circle's rows `unlinked_at`.
//     The whatsapp-circle-events cron deletes the unlinked link's row (by
//     the nonce in the CircleUnlinked event) once the "Circle disconnected"
//     message is settled, since that message needs the number. The daily
//     walrus-renewal cron deletes any row marked longer ago than
//     UNLINKED_KEY_GRACE_HOURS, in case the event is never processed.
//   * Erasure: scripts/process-deletion-request.mjs deletes every row of the
//     number by `phone_hmac`, in the same transaction as its index rows.
//
// Reading: loadLinkDataKey returns null only when no row exists, which means
// the link was erased or unlinked, and readers treat such a blob as holding
// no phone (src/lib/pii-key-errors.ts). A failed read throws PiiKeyReadError
// instead, the same transient class as a failed Walrus read: Postgres down,
// or a row wrapped under a KEK this deployment doesn't hold. A read failure
// is not an erasure.
//
// Without DATABASE_URL (local development only) the rows live in memory, as
// whatsapp-link-index.ts does; production refuses to run that way.

import type { Pool } from 'pg';
import {
  decodePiiMasterKey,
  kekOf,
  newDataKey,
  newKeyId,
  unwrapWithRing,
  wrapDataKey,
  type Kek,
  type KekRing,
} from '../../scripts/lib/pii-key-wrap';
import { assertDatabaseUrlInProduction, getSharedPgPool, isPostgresConfigured } from './pg-pool';
import { PiiKeyReadError } from './pii-key-errors';

/**
 * How long an unlinked link's key outlives the unlink when the
 * whatsapp-circle-events cron never deletes it. That cron sends nothing
 * for an event older than 24 hours, so after this the "Circle disconnected"
 * message can no longer need the key.
 */
export const UNLINKED_KEY_GRACE_HOURS = 48;

/** A link's data key, unwrapped. */
export interface LinkDataKey {
  kid: string;
  dek: Buffer;
}

interface KeyRow {
  kid: string;
  wrapped_dek: string;
  kek_id: string;
  phone_hmac: string;
  circle_id: string;
  link_nonce: string;
  created_at: Date;
  unlinked_at: Date | null;
}

const KEY_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS whatsapp_pii_keys (
    kid TEXT PRIMARY KEY,
    wrapped_dek TEXT NOT NULL,
    kek_id TEXT NOT NULL,
    phone_hmac TEXT NOT NULL,
    circle_id TEXT NOT NULL,
    link_nonce TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    unlinked_at TIMESTAMPTZ
  );
  CREATE INDEX IF NOT EXISTS whatsapp_pii_keys_phone_hmac_idx
    ON whatsapp_pii_keys (phone_hmac);
  CREATE INDEX IF NOT EXISTS whatsapp_pii_keys_circle_idx
    ON whatsapp_pii_keys (circle_id);
  CREATE INDEX IF NOT EXISTS whatsapp_pii_keys_unlinked_idx
    ON whatsapp_pii_keys (unlinked_at) WHERE unlinked_at IS NOT NULL;
`;

let setupPromise: Promise<void> | null = null;
const memoryRows = new Map<string, KeyRow>();
let memoryWarned = false;

function postgresBacked(): boolean {
  if (isPostgresConfigured()) return true;
  assertDatabaseUrlInProduction('whatsapp-pii-keys');
  if (!memoryWarned) {
    console.warn(
      '[whatsapp-pii-keys] DATABASE_URL not configured; keeping WhatsApp data keys in memory. ' +
        'Links made now stop opening when this process exits. Local development only.',
    );
    memoryWarned = true;
  }
  return false;
}

function getPool(): Pool {
  return getSharedPgPool();
}

/**
 * Creates the table on first use in this instance (scripts/migrate-postgres.mjs
 * creates it too). A failed attempt is retried on the next call.
 */
export function ensureLinkKeyTable(): Promise<void> {
  if (!setupPromise) {
    setupPromise = getPool()
      .query(KEY_TABLE_SQL)
      .then(() => undefined)
      .catch((err) => {
        setupPromise = null;
        throw err;
      });
  }
  return setupPromise;
}

function currentKek(): Kek {
  const raw = process.env.WALRUS_PII_MASTER_KEY;
  if (!raw) {
    throw new Error(
      'WALRUS_PII_MASTER_KEY is not set. Generate 32 random bytes (hex or base64) and add it to .env.local before linking WhatsApp circles.',
    );
  }
  return kekOf(decodePiiMasterKey('WALRUS_PII_MASTER_KEY', raw));
}

/**
 * The previous master key, during a rotation. Read only for a row the
 * current key did not wrap, so a malformed value breaks only those rows.
 */
function previousKek(): Kek | null {
  const raw = process.env.WALRUS_PII_PREVIOUS_MASTER_KEY;
  return raw ? kekOf(decodePiiMasterKey('WALRUS_PII_PREVIOUS_MASTER_KEY', raw)) : null;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Generates a data key for a new link and stores it, wrapped under the
 * current master key, before anything is sealed with it. Throws when it
 * can't be stored; the caller must then upload nothing.
 */
export async function createLinkDataKey(params: {
  phoneHmac: string;
  circleId: string;
  /** Hex of the 32-byte nonce the on-chain anchor will carry. */
  linkNonceHex: string;
}): Promise<LinkDataKey> {
  const kek = currentKek();
  const kid = newKeyId();
  const dek = newDataKey();
  const wrapped = wrapDataKey(dek, kek.key, kid);
  const linkNonce = params.linkNonceHex.toLowerCase();

  if (!postgresBacked()) {
    memoryRows.set(kid, {
      kid,
      wrapped_dek: wrapped,
      kek_id: kek.id,
      phone_hmac: params.phoneHmac,
      circle_id: params.circleId,
      link_nonce: linkNonce,
      created_at: new Date(),
      unlinked_at: null,
    });
    return { kid, dek };
  }

  await ensureLinkKeyTable();
  await getPool().query(
    `INSERT INTO whatsapp_pii_keys (kid, wrapped_dek, kek_id, phone_hmac, circle_id, link_nonce)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [kid, wrapped, kek.id, params.phoneHmac, params.circleId, linkNonce],
  );
  return { kid, dek };
}

/**
 * The data key of envelope key id `kid`, or null when its row no longer
 * exists: the link was erased or unlinked. Throws PiiKeyReadError when the
 * row can't be read or unwrapped by this deployment's keys, and a plain
 * Error when the stored wrap has been altered.
 */
export async function loadLinkDataKey(kid: string): Promise<LinkDataKey | null> {
  let row: Pick<KeyRow, 'kid' | 'wrapped_dek' | 'kek_id'> | undefined;
  try {
    if (postgresBacked()) {
      await ensureLinkKeyTable();
      const result = await getPool().query<Pick<KeyRow, 'kid' | 'wrapped_dek' | 'kek_id'>>(
        'SELECT kid, wrapped_dek, kek_id FROM whatsapp_pii_keys WHERE kid = $1',
        [kid],
      );
      row = result.rows[0];
    } else {
      row = memoryRows.get(kid);
    }
  } catch (err) {
    throw new PiiKeyReadError(`Could not read the data key ${kid}: ${messageOf(err)}`, { cause: err });
  }
  if (!row) return null;

  let ring: KekRing;
  try {
    const current = currentKek();
    ring = { current, previous: row.kek_id === current.id ? null : previousKek() };
  } catch (err) {
    throw new PiiKeyReadError(`Could not unwrap the data key ${kid}: ${messageOf(err)}`, { cause: err });
  }

  const unwrapped = unwrapWithRing(row, ring);
  if (unwrapped.ok) return { kid, dek: unwrapped.dek };
  if (unwrapped.reason === 'unknown_kek') {
    throw new PiiKeyReadError(
      `The data key ${kid} is wrapped under a key that is neither WALRUS_PII_MASTER_KEY nor ` +
        `WALRUS_PII_PREVIOUS_MASTER_KEY (kek ${row.kek_id}). During a key rotation, set ` +
        'WALRUS_PII_PREVIOUS_MASTER_KEY to the old key until the keys are re-wrapped (docs/environment.md).',
    );
  }
  throw new Error(`The stored data key ${kid} does not open under its master key: the row was altered.`);
}

/** Deletes one data key (a link whose upload failed). */
export async function deleteLinkDataKey(kid: string): Promise<void> {
  if (!postgresBacked()) {
    memoryRows.delete(kid);
    return;
  }
  await ensureLinkKeyTable();
  await getPool().query('DELETE FROM whatsapp_pii_keys WHERE kid = $1', [kid]);
}

/**
 * Marks the keys of a circle's current links as unlinked, once the admin
 * reports the on-chain unlink. They stay readable until the unlink
 * confirmation is settled (see the header). Returns how many were marked.
 */
export async function markCircleLinkKeysUnlinked(circleId: string): Promise<number> {
  if (!postgresBacked()) {
    let marked = 0;
    for (const row of memoryRows.values()) {
      if (row.circle_id === circleId && row.unlinked_at === null) {
        row.unlinked_at = new Date();
        marked += 1;
      }
    }
    return marked;
  }
  await ensureLinkKeyTable();
  const result = await getPool().query(
    `UPDATE whatsapp_pii_keys SET unlinked_at = NOW()
      WHERE circle_id = $1 AND unlinked_at IS NULL`,
    [circleId],
  );
  return result.rowCount ?? 0;
}

/**
 * Deletes the key of the link a CircleUnlinked event disabled, found by the
 * nonce the event carries, whether or not the admin's unlink call marked it.
 * A later link of the same circle has another nonce and keeps its key.
 * Returns how many rows were deleted (0 for a link made before per-link
 * keys, or one already deleted).
 */
export async function deleteUnlinkedLinkKey(circleId: string, linkNonceHex: string): Promise<number> {
  const linkNonce = linkNonceHex.toLowerCase();
  if (!postgresBacked()) {
    let deleted = 0;
    for (const [kid, row] of memoryRows) {
      if (row.circle_id === circleId && row.link_nonce === linkNonce) {
        memoryRows.delete(kid);
        deleted += 1;
      }
    }
    return deleted;
  }
  await ensureLinkKeyTable();
  const result = await getPool().query(
    'DELETE FROM whatsapp_pii_keys WHERE circle_id = $1 AND link_nonce = $2',
    [circleId, linkNonce],
  );
  return result.rowCount ?? 0;
}

/**
 * Deletes the keys marked unlinked more than `graceHours` ago (see
 * UNLINKED_KEY_GRACE_HOURS). Returns how many rows were deleted.
 */
export async function sweepUnlinkedLinkKeys(graceHours = UNLINKED_KEY_GRACE_HOURS): Promise<number> {
  if (!postgresBacked()) {
    const cutoff = Date.now() - graceHours * 60 * 60 * 1000;
    let deleted = 0;
    for (const [kid, row] of memoryRows) {
      if (row.unlinked_at && row.unlinked_at.getTime() < cutoff) {
        memoryRows.delete(kid);
        deleted += 1;
      }
    }
    return deleted;
  }
  await ensureLinkKeyTable();
  const result = await getPool().query(
    `DELETE FROM whatsapp_pii_keys
      WHERE unlinked_at < NOW() - make_interval(hours => $1)`,
    [graceHours],
  );
  return result.rowCount ?? 0;
}

/**
 * True when the circle has a live (not unlinked) key for this number:
 * whatsapp-link-index.ts indexes a link only then. In-memory mode only;
 * with Postgres the index write checks it in the same statement.
 */
export function hasLiveLinkKeyInMemory(phoneHmac: string, circleId: string): boolean {
  for (const row of memoryRows.values()) {
    if (row.phone_hmac === phoneHmac && row.circle_id === circleId && row.unlinked_at === null) {
      return true;
    }
  }
  return false;
}

/** Test helper: forgets the in-memory rows and the table-setup latch. */
export function __resetWhatsAppPiiKeysForTests(): void {
  setupPromise = null;
  memoryRows.clear();
  memoryWarned = false;
}
