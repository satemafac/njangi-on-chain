/**
 * Per-link data keys for WhatsApp PII envelopes: generating them and wrapping
 * them. Shared by the app (src/lib/whatsapp-pii-keys.ts) and the re-wrap
 * script for key rotations (scripts/rewrap-whatsapp-pii-keys.mjs).
 *
 * Each link's envelope (src/lib/walrus-pii.ts, envelope v2) is sealed with a
 * random 256-bit data key of its own, the DEK. The DEK is stored only in
 * Postgres (`whatsapp_pii_keys`), wrapped with AES-256-GCM under a
 * key-encryption key, the KEK. Today the KEK is WALRUS_PII_MASTER_KEY (and,
 * during a rotation, WALRUS_PII_PREVIOUS_MASTER_KEY can still unwrap). The
 * wrap is bound to the link's key id, so a wrapped DEK copied onto another
 * row does not open.
 *
 * Deleting a link's row deletes the only copy of its DEK: every copy of its
 * envelope stops opening, the blob anchored on chain, each copy the renewal
 * cron made and any copy someone else kept. The KEK alone opens nothing.
 *
 * Node runs this file directly for the script (type stripping; the
 * package.json next to it marks the folder as ESM, so Node does not warn),
 * the app bundles it, and jest runs src/__tests__/scripts/pii-key-wrap.test.ts
 * against it. Keep it erasable TypeScript: no enums, namespaces or parameter
 * properties, and no imports except Node's own.
 */

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

/** Length of a DEK and of a KEK: AES-256. */
export const PII_KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const WRAPPED_BYTES = IV_BYTES + PII_KEY_BYTES + TAG_BYTES;

/**
 * Decodes WALRUS_PII_MASTER_KEY or WALRUS_PII_PREVIOUS_MASTER_KEY the way
 * the app always has: exactly 64 hex digits, else base64. Anything that is
 * not 32 bytes throws, naming the variable but never echoing its value.
 */
export function decodePiiMasterKey(name: string, raw: string): Buffer {
  const key =
    /^[0-9a-fA-F]+$/.test(raw) && raw.length === PII_KEY_BYTES * 2
      ? Buffer.from(raw, 'hex')
      : Buffer.from(raw, 'base64');
  if (key.length !== PII_KEY_BYTES) {
    throw new Error(`${name} must decode to exactly ${PII_KEY_BYTES} bytes (got ${key.length}).`);
  }
  return key;
}

/**
 * A public name for a KEK: the first 16 hex digits of an HMAC under it. It
 * is stored next to each wrapped DEK (`kek_id`), so the app unwraps with the
 * right key without trial and error, and a rotation can count the rows the
 * new key has not re-wrapped yet. It reveals nothing about the key.
 */
export function kekIdOf(kek: Buffer): string {
  return createHmac('sha256', kek).update('njangi/whatsapp-pii/kek-id/v1').digest('hex').slice(0, 16);
}

/** A new key id: 32 random hex digits. Envelopes carry it in the clear. */
export function newKeyId(): string {
  return randomBytes(16).toString('hex');
}

/** True for a value shaped like a key id from newKeyId. */
export function isKeyId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
}

/** A new DEK. */
export function newDataKey(): Buffer {
  return randomBytes(PII_KEY_BYTES);
}

function wrapAad(kid: string): Buffer {
  return Buffer.from(`njangi/whatsapp-pii/dek/v1:${kid}`, 'utf8');
}

/** Wraps `dek` under `kek` for key id `kid`: base64 of IV, ciphertext, tag. */
export function wrapDataKey(dek: Buffer, kek: Buffer, kid: string): string {
  if (dek.length !== PII_KEY_BYTES) {
    throw new Error(`A data key must be ${PII_KEY_BYTES} bytes (got ${dek.length}).`);
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', kek, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(wrapAad(kid));
  const ct = Buffer.concat([cipher.update(dek), cipher.final()]);
  return Buffer.concat([iv, ct, cipher.getAuthTag()]).toString('base64');
}

/**
 * Unwraps a DEK, or returns null when GCM authentication fails: `kek` did
 * not wrap it, the stored value was altered, or it was wrapped for another
 * key id. Throws when the value is not even the right length.
 */
export function unwrapDataKey(wrapped: string, kek: Buffer, kid: string): Buffer | null {
  const raw = Buffer.from(wrapped, 'base64');
  if (raw.length !== WRAPPED_BYTES) {
    throw new Error(`The wrapped data key for ${kid} is ${raw.length} bytes, not ${WRAPPED_BYTES}.`);
  }
  const decipher = createDecipheriv('aes-256-gcm', kek, raw.subarray(0, IV_BYTES), {
    authTagLength: TAG_BYTES,
  });
  decipher.setAAD(wrapAad(kid));
  decipher.setAuthTag(raw.subarray(IV_BYTES + PII_KEY_BYTES));
  const head = decipher.update(raw.subarray(IV_BYTES, IV_BYTES + PII_KEY_BYTES));
  try {
    return Buffer.concat([head, decipher.final()]);
  } catch {
    return null;
  }
}

/** One KEK and its public name. */
export interface Kek {
  key: Buffer;
  id: string;
}

/**
 * The KEKs a deployment holds: `current` wraps every new DEK; `previous`
 * only unwraps, and only during a rotation.
 */
export interface KekRing {
  current: Kek;
  previous: Kek | null;
}

export function kekOf(key: Buffer): Kek {
  return { key, id: kekIdOf(key) };
}

/** A `whatsapp_pii_keys` row, as far as unwrapping it goes. */
export interface WrappedKeyRow {
  kid: string;
  wrapped_dek: string;
  kek_id: string;
}

export type UnwrapResult =
  | { ok: true; dek: Buffer; kek: 'current' | 'previous' }
  /** The row names a KEK this deployment does not hold (a rotation gone wrong). */
  | { ok: false; reason: 'unknown_kek' }
  /** The KEK matched but the wrap did not open: the row was altered. */
  | { ok: false; reason: 'corrupt' };

/** Unwraps a row with whichever key of the ring its `kek_id` names. */
export function unwrapWithRing(row: WrappedKeyRow, ring: KekRing): UnwrapResult {
  let which: 'current' | 'previous';
  let kek: Kek;
  if (row.kek_id === ring.current.id) {
    which = 'current';
    kek = ring.current;
  } else if (ring.previous && row.kek_id === ring.previous.id) {
    which = 'previous';
    kek = ring.previous;
  } else {
    return { ok: false, reason: 'unknown_kek' };
  }
  let dek: Buffer | null;
  try {
    dek = unwrapDataKey(row.wrapped_dek, kek.key, row.kid);
  } catch {
    dek = null;
  }
  return dek ? { ok: true, dek, kek: which } : { ok: false, reason: 'corrupt' };
}

export type RewrapPlan =
  /** Already wrapped under the current KEK. */
  | { action: 'keep' }
  /** Wrapped under the previous KEK: store this instead. */
  | { action: 'rewrap'; wrappedDek: string; kekId: string }
  | { action: 'unknown_kek' }
  | { action: 'corrupt' };

/**
 * What a rotation does with one row: keep it, or re-wrap its DEK under the
 * current KEK. The DEK itself never changes, so the link's envelopes keep
 * opening; only the wrap does.
 */
export function planRewrap(row: WrappedKeyRow, ring: KekRing): RewrapPlan {
  const unwrapped = unwrapWithRing(row, ring);
  if (!unwrapped.ok) return { action: unwrapped.reason };
  if (unwrapped.kek === 'current') return { action: 'keep' };
  return {
    action: 'rewrap',
    wrappedDek: wrapDataKey(unwrapped.dek, ring.current.key, row.kid),
    kekId: ring.current.id,
  };
}
