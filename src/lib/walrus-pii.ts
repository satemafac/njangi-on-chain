// walrus-pii.ts — Encrypt-and-store WhatsApp PII payloads in Sui Walrus.
//
// The Move `whatsapp_integration` module no longer stores phone numbers,
// group IDs, or group names on chain. Instead, the server encrypts the
// payload here, uploads the ciphertext to Walrus, and anchors only the
// returned blob ID + an opaque correlation nonce on chain. Decryption
// happens server-side when the WhatsApp webhook needs to route a message.
//
// Key management (envelope v2, every new link): each link's payload is
// sealed with AES-256-GCM under a random data key of its own, and the
// envelope names that key by id (`kid`, also bound into the GCM additional
// data). The data key lives only in Postgres, wrapped under
// WALRUS_PII_MASTER_KEY (src/lib/whatsapp-pii-keys.ts). Deleting a link's
// key, as unlink and erasure do, makes every copy of its envelope
// unreadable, wherever it is stored; the master key alone opens nothing.
// Renewal re-seals a v2 envelope under the SAME data key, so one key row
// covers the anchored blob and every renewed copy.
//
// Envelope v1 (links made before per-link keys) is sealed with
// WALRUS_PII_MASTER_KEY itself and carries no key id. It still opens, and
// renewal still re-seals it as v1, exactly as before.
//
// Rotating WALRUS_PII_MASTER_KEY: set WALRUS_PII_PREVIOUS_MASTER_KEY to the
// old key and WALRUS_PII_MASTER_KEY to the new one, redeploy, then re-wrap
// the data keys (scripts/rewrap-whatsapp-pii-keys.mjs). Decryption of a v1
// envelope tries the current key, then the previous one (the GCM tag tells
// which one sealed it), and v1 renewals use the current key. Procedure:
// docs/environment.md, "Rotating the WhatsApp PII keys".

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import {
  WalrusReadError,
  isRefusedWalrusStatus,
  isTransientWalrusStatus,
} from './walrus-read-error';
import { decodePiiMasterKey, isKeyId } from '../../scripts/lib/pii-key-wrap';
import { normalizePhone } from '../../scripts/lib/whatsapp-phone';
import { PiiKeyErasedError } from './pii-key-errors';
import {
  createLinkDataKey,
  deleteLinkDataKey,
  loadLinkDataKey,
  type LinkDataKey,
} from './whatsapp-pii-keys';

const AES_ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const SCHEMA_VERSION = 1;

export type WhatsAppPiiPayload = {
  schema_version: typeof SCHEMA_VERSION;
  link_type: 'individual' | 'group';
  phone_e164?: string;
  group_id?: string;
  group_name?: string;
  created_at: string;
};

/** Legacy envelope, sealed with WALRUS_PII_MASTER_KEY itself. Never written for a new link. */
export type EncryptedEnvelopeV1 = {
  v: 1;
  iv: string; // base64
  ct: string; // base64 ciphertext (without tag)
  tag: string; // base64 GCM auth tag
};

/** Per-link envelope, sealed with the data key `kid` names (src/lib/whatsapp-pii-keys.ts). */
export type EncryptedEnvelopeV2 = {
  v: 2;
  kid: string; // 32 hex digits
  iv: string; // base64
  ct: string; // base64 ciphertext (without tag)
  tag: string; // base64 GCM auth tag
};

export type EncryptedEnvelope = EncryptedEnvelopeV1 | EncryptedEnvelopeV2;

export type StoredPiiPointer = {
  walrusBlobId: string; // returned by Walrus publisher
  linkNonce: Uint8Array; // 32 random bytes anchored on chain
  // Storage lease end epoch from the publisher (null when not reported).
  // Tracked off chain so /api/cron/walrus-renewal knows when to re-store.
  walrusEndEpoch: number | null;
};

const DEFAULT_TESTNET_PUBLISHER = 'https://publisher.walrus-testnet.walrus.space';
const DEFAULT_TESTNET_AGGREGATOR = 'https://aggregator.walrus-testnet.walrus.space';
const DEFAULT_MAINNET_PUBLISHER = 'https://publisher.walrus.space';
const DEFAULT_MAINNET_AGGREGATOR = 'https://aggregator.walrus.space';

function loadMasterKey(): Buffer {
  const raw = process.env.WALRUS_PII_MASTER_KEY;
  if (!raw) {
    throw new Error(
      'WALRUS_PII_MASTER_KEY is not set. Generate 32 random bytes (hex or base64) and add it to .env.local before linking WhatsApp circles.',
    );
  }
  return decodePiiMasterKey('WALRUS_PII_MASTER_KEY', raw);
}

/**
 * The key WALRUS_PII_MASTER_KEY held before a rotation, or null when no
 * rotation is in progress. Decrypt-only: nothing is ever sealed with it.
 * Read only after the current key fails, so a malformed value breaks the
 * blobs that need it and never the ones the current key opens.
 */
function loadPreviousMasterKey(): Buffer | null {
  const raw = process.env.WALRUS_PII_PREVIOUS_MASTER_KEY;
  if (!raw) return null;
  return decodePiiMasterKey('WALRUS_PII_PREVIOUS_MASTER_KEY', raw);
}

function walrusEndpoints(): { publisher: string; aggregator: string } {
  const network = (process.env.NEXT_PUBLIC_SUI_NETWORK || 'testnet').toLowerCase();
  if (network === 'mainnet') {
    return {
      publisher: process.env.WALRUS_PUBLISHER_URL || DEFAULT_MAINNET_PUBLISHER,
      aggregator: process.env.WALRUS_AGGREGATOR_URL || DEFAULT_MAINNET_AGGREGATOR,
    };
  }
  return {
    publisher: process.env.WALRUS_PUBLISHER_URL || DEFAULT_TESTNET_PUBLISHER,
    aggregator: process.env.WALRUS_AGGREGATOR_URL || DEFAULT_TESTNET_AGGREGATOR,
  };
}

/**
 * Seals a payload as a LEGACY v1 envelope, under WALRUS_PII_MASTER_KEY
 * itself. Only the renewal of a v1 blob calls it. New links get v2
 * envelopes (sealPiiPayload), whose key unlink and erasure can delete.
 */
export function encryptPiiPayload(payload: WhatsAppPiiPayload): EncryptedEnvelopeV1 {
  const key = loadMasterKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(AES_ALGO, key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  if (tag.length !== GCM_TAG_BYTES) {
    throw new Error(`Unexpected GCM tag length: ${tag.length}`);
  }
  return {
    v: 1,
    iv: iv.toString('base64'),
    ct: ct.toString('base64'),
    tag: tag.toString('base64'),
  };
}

/**
 * Opens an envelope with one key. Returns null when GCM authentication
 * fails: this key did not seal the envelope, or the envelope was altered.
 * The unauthenticated output of update() is dropped in that case.
 */
function openWithKey(
  key: Buffer,
  iv: Buffer,
  ct: Buffer,
  tag: Buffer,
  aad?: Buffer,
): Buffer | null {
  const decipher = createDecipheriv(AES_ALGO, key, iv, { authTagLength: GCM_TAG_BYTES });
  if (aad) decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  const head = decipher.update(ct);
  try {
    return Buffer.concat([head, decipher.final()]);
  } catch {
    return null;
  }
}

function parsePayload(plaintext: Buffer): WhatsAppPiiPayload {
  const parsed = JSON.parse(plaintext.toString('utf8')) as WhatsAppPiiPayload;
  if (parsed.schema_version !== SCHEMA_VERSION) {
    throw new Error(`Unsupported PII schema version: ${parsed.schema_version}`);
  }
  return parsed;
}

/** GCM additional data of a v2 envelope: binds the ciphertext to its key id. */
function envelopeAad(kid: string): Buffer {
  return Buffer.from(`njangi/whatsapp-pii/envelope/v2:${kid}`, 'utf8');
}

/**
 * Seals a payload as a v2 envelope under a link's data key, with a fresh
 * IV. The key id travels in the clear; the key itself never leaves Postgres.
 */
export function sealPiiPayload(payload: WhatsAppPiiPayload, key: LinkDataKey): EncryptedEnvelopeV2 {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(AES_ALGO, key.dek, iv, { authTagLength: GCM_TAG_BYTES });
  cipher.setAAD(envelopeAad(key.kid));
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    v: 2,
    kid: key.kid,
    iv: iv.toString('base64'),
    ct: ct.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

/** Opens a v2 envelope with its data key. Throws when it doesn't open. */
export function openPiiPayload(envelope: EncryptedEnvelopeV2, key: LinkDataKey): WhatsAppPiiPayload {
  if (envelope.kid !== key.kid) {
    throw new Error(`PII envelope ${envelope.kid} was offered the data key ${key.kid}.`);
  }
  const plaintext = openWithKey(
    key.dek,
    Buffer.from(envelope.iv, 'base64'),
    Buffer.from(envelope.ct, 'base64'),
    Buffer.from(envelope.tag, 'base64'),
    envelopeAad(envelope.kid),
  );
  if (!plaintext) {
    throw new Error(`PII envelope ${envelope.kid} does not open with its data key (the envelope was altered).`);
  }
  return parsePayload(plaintext);
}

/**
 * The data key a v2 envelope names. Throws PiiKeyErasedError when the key
 * was deleted (the link was erased or unlinked) and PiiKeyReadError when
 * the key store could not answer (see pii-key-errors.ts).
 */
async function linkKeyFor(envelope: EncryptedEnvelopeV2): Promise<LinkDataKey> {
  if (!isKeyId(envelope.kid)) {
    throw new Error('PII envelope v2 carries no valid key id.');
  }
  const key = await loadLinkDataKey(envelope.kid);
  if (!key) throw new PiiKeyErasedError(envelope.kid);
  return key;
}

/**
 * Opens an envelope of either version: v2 with its link's data key, v1 with
 * the master key (decryptPiiPayload).
 */
export async function openPiiEnvelope(envelope: EncryptedEnvelope): Promise<WhatsAppPiiPayload> {
  if (envelope.v === 2) {
    return openPiiPayload(envelope, await linkKeyFor(envelope));
  }
  return decryptPiiPayload(envelope);
}

/** Opens a LEGACY v1 envelope with the master key (or the previous one, during a rotation). */
export function decryptPiiPayload(envelope: EncryptedEnvelope): WhatsAppPiiPayload {
  if (envelope.v === 2) {
    throw new Error('A v2 PII envelope opens with its data key: use openPiiEnvelope.');
  }
  if (envelope.v !== 1) {
    throw new Error(`Unsupported envelope version: ${(envelope as { v: unknown }).v}`);
  }
  const iv = Buffer.from(envelope.iv, 'base64');
  const ct = Buffer.from(envelope.ct, 'base64');
  const tag = Buffer.from(envelope.tag, 'base64');

  // The envelope names no key, so try the current one, then the
  // pre-rotation key when one is configured.
  let plaintext = openWithKey(loadMasterKey(), iv, ct, tag);
  if (!plaintext) {
    const previousKey = loadPreviousMasterKey();
    if (!previousKey) {
      throw new Error(
        'PII envelope does not open with WALRUS_PII_MASTER_KEY (wrong key, or the envelope was altered). ' +
          'If the key was changed, set WALRUS_PII_PREVIOUS_MASTER_KEY to the old key (docs/environment.md).',
      );
    }
    plaintext = openWithKey(previousKey, iv, ct, tag);
    if (!plaintext) {
      throw new Error(
        'PII envelope opens with neither WALRUS_PII_MASTER_KEY nor WALRUS_PII_PREVIOUS_MASTER_KEY ' +
          '(wrong keys, or the envelope was altered).',
      );
    }
  }
  return parsePayload(plaintext);
}

export function generateLinkNonce(): Uint8Array {
  return new Uint8Array(randomBytes(32));
}

/**
 * Computes a HMAC-SHA256 lookup hash for a phone number / group ID. Used
 * server-side to build a Postgres index without storing the raw value.
 * The salt is read from WALRUS_LOOKUP_SALT and never leaves the server.
 */
export async function computeLookupHash(value: string): Promise<string> {
  const salt = process.env.WALRUS_LOOKUP_SALT;
  if (!salt) {
    throw new Error('WALRUS_LOOKUP_SALT is not set; cannot index PII safely.');
  }
  const { createHmac } = await import('crypto');
  return createHmac('sha256', salt).update(value).digest('hex');
}

/**
 * The publisher's PUT /v1/blobs response carries the storage end epoch in
 * one of two shapes (a fresh upload vs. an already-certified blob). The
 * renewal cron needs that end epoch to know when to renew next.
 */
export type WalrusStoreResult = {
  blobId: string;
  /** Storage end epoch, when the publisher reports it; null otherwise. */
  endEpoch: number | null;
};

/**
 * Uploads an encrypted envelope to Walrus and returns the blob ID plus the
 * storage end epoch. The publisher rejects payloads larger than its
 * configured size cap; PII envelopes are tiny so this is a non-issue.
 */
export async function storeEnvelopeInWalrusDetailed(
  envelope: EncryptedEnvelope,
): Promise<WalrusStoreResult> {
  const { publisher } = walrusEndpoints();
  const epochs = Number(process.env.WALRUS_STORAGE_EPOCHS || '5');
  const url = `${publisher}/v1/blobs?epochs=${encodeURIComponent(String(epochs))}`;

  const response = await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(envelope),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '<no body>');
    throw new Error(`Walrus publisher rejected upload (${response.status}): ${body}`);
  }

  const data = (await response.json()) as {
    newlyCreated?: { blobObject?: { blobId?: string; storage?: { endEpoch?: number } } };
    alreadyCertified?: { blobId?: string; endEpoch?: number };
  };

  const blobId =
    data.newlyCreated?.blobObject?.blobId ||
    data.alreadyCertified?.blobId ||
    null;

  if (!blobId) {
    throw new Error(`Walrus publisher returned an unexpected payload: ${JSON.stringify(data)}`);
  }

  const endEpochRaw =
    data.newlyCreated?.blobObject?.storage?.endEpoch ??
    data.alreadyCertified?.endEpoch ??
    null;
  const endEpoch =
    typeof endEpochRaw === 'number' && Number.isFinite(endEpochRaw) ? endEpochRaw : null;

  return { blobId, endEpoch };
}

/**
 * Uploads an encrypted envelope to Walrus and returns the blob ID. Thin
 * wrapper over storeEnvelopeInWalrusDetailed for callers that only need the
 * id (the linking flow). The end epoch is captured separately by callers
 * that track expiry (the renewal cron).
 */
export async function storeEnvelopeInWalrus(envelope: EncryptedEnvelope): Promise<string> {
  return (await storeEnvelopeInWalrusDetailed(envelope)).blobId;
}

/** An error's message, plus its cause's: undici's "fetch failed" keeps the reason there. */
function describeFailure(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as Error & { cause?: unknown }).cause;
  return cause instanceof Error ? `${err.message} (${cause.message})` : err.message;
}

/**
 * Fetches a previously stored envelope from the Walrus aggregator. Every
 * failure throws a WalrusReadError whose `transient` flag says whether a
 * retry may succeed: true for a network error, a 5xx, a 429 or a refusal
 * (401, 403: fixed by fixing WALRUS_AGGREGATOR_URL), false for a 404 or 410
 * (expired blob), any other 4xx, or a body that is not an envelope. See
 * walrus-read-error.ts.
 */
export async function fetchEnvelopeFromWalrus(blobId: string): Promise<EncryptedEnvelope> {
  const { aggregator } = walrusEndpoints();
  const url = `${aggregator}/v1/blobs/${encodeURIComponent(blobId)}`;
  let response: Response;
  try {
    response = await fetch(url);
  } catch (err) {
    throw new WalrusReadError(`Walrus aggregator unreachable: ${describeFailure(err)}`, {
      status: null,
      transient: true,
      cause: err,
    });
  }
  if (!response.ok) {
    const { status } = response;
    const body = await response.text().catch(() => '<no body>');
    // A refusal names the setting to check: it fails every read until fixed.
    const answer = isRefusedWalrusStatus(status)
      ? `${status} (read refused: check WALRUS_AGGREGATOR_URL)`
      : String(status);
    throw new WalrusReadError(`Walrus aggregator returned ${answer}: ${body}`, {
      status,
      transient: isTransientWalrusStatus(status),
    });
  }
  // Read the body before parsing it: a connection that drops mid-body is a
  // network failure, while a body that arrives whole but is not an
  // envelope is a property of the blob.
  let text: string;
  try {
    text = await response.text();
  } catch (err) {
    throw new WalrusReadError(`Walrus aggregator response was cut off: ${describeFailure(err)}`, {
      status: response.status,
      transient: true,
      cause: err,
    });
  }
  let envelope: EncryptedEnvelope | null = null;
  try {
    envelope = JSON.parse(text) as EncryptedEnvelope;
  } catch {
    // Not JSON: reported as malformed below.
  }
  if (typeof envelope?.iv !== 'string' || typeof envelope?.ct !== 'string' || typeof envelope?.tag !== 'string') {
    throw new WalrusReadError('Walrus aggregator returned a malformed envelope.', {
      status: response.status,
      transient: false,
    });
  }
  return envelope;
}

/**
 * High-level helper used by the WhatsApp linking flow (prepare step).
 * Creates the link's data key and stores it BEFORE anything is sealed with
 * it, seals the payload as a v2 envelope, uploads it to Walrus, and returns
 * the on-chain pointer (blob ID + opaque nonce). The key row records the
 * HMAC of the number (erasure deletes by it), the circle and the nonce
 * (unlink deletes by them). A failed upload deletes the key again: there is
 * no blob for it to open.
 */
export async function encryptAndStorePII(
  payload: WhatsAppPiiPayload,
  link: { circleId: string },
): Promise<StoredPiiPointer> {
  const recipient = payload.phone_e164 ?? payload.group_id;
  if (!recipient) {
    throw new Error('A WhatsApp PII payload must carry a phone number or a group id.');
  }
  const linkNonce = generateLinkNonce();
  const key = await createLinkDataKey({
    phoneHmac: await computeLookupHash(normalizePhone(recipient)),
    circleId: link.circleId,
    linkNonceHex: nonceToHex(linkNonce),
  });
  let stored: WalrusStoreResult;
  try {
    stored = await storeEnvelopeInWalrusDetailed(sealPiiPayload(payload, key));
  } catch (err) {
    await deleteLinkDataKey(key.kid).catch((cleanupErr) => {
      // The row then names no stored blob; erasing the number still removes it.
      console.warn('[walrus-pii] Could not delete the data key of a failed upload', {
        kid: key.kid,
        error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
      });
    });
    throw err;
  }
  return { walrusBlobId: stored.blobId, linkNonce, walrusEndEpoch: stored.endEpoch };
}

/**
 * Fetches and decrypts one blob: the WhatsApp phone lookups, the webhook's
 * registry scan, the manage card and renewal all read through here. Throws
 * the WalrusReadError of a failed read (see fetchEnvelopeFromWalrus), and
 * for a v2 envelope PiiKeyErasedError when its link's key was deleted or
 * PiiKeyReadError when the key store could not answer (pii-key-errors.ts),
 * and a plain Error when the envelope does not decrypt. Only a transient
 * WalrusReadError (PiiKeyReadError is one) is worth retrying; an erased key
 * means the blob holds no phone, for good.
 */
export async function fetchAndDecryptPII(blobId: string): Promise<WhatsAppPiiPayload> {
  return openPiiEnvelope(await fetchEnvelopeFromWalrus(blobId));
}

/**
 * Re-stores an existing PII blob: fetch, open, re-seal with a fresh IV, and
 * upload a fresh copy. Returns the new blob id and storage end epoch. Used
 * by /api/cron/walrus-renewal to keep blobs alive past their original
 * storage lease before the on-chain anchors, which never expire, outlive
 * them.
 *
 * A v2 envelope is re-sealed under the SAME data key and key id, so the
 * link's one key row keeps covering every copy, and deleting it still makes
 * all of them unreadable. A deleted key throws PiiKeyErasedError, and the
 * cron renews nothing for that link. A v1 envelope is decrypted (current
 * master key, else WALRUS_PII_PREVIOUS_MASTER_KEY during a rotation) and
 * re-sealed as v1 under the CURRENT master key, as before.
 *
 * Opening the blob first also proves it is still readable and not
 * corrupted before we commit a new lease for it.
 */
export async function restorePiiBlob(blobId: string): Promise<{
  newBlobId: string;
  newEndEpoch: number | null;
}> {
  const envelope = await fetchEnvelopeFromWalrus(blobId);
  let resealed: EncryptedEnvelope;
  if (envelope.v === 2) {
    const key = await linkKeyFor(envelope);
    resealed = sealPiiPayload(openPiiPayload(envelope, key), key);
  } else {
    resealed = encryptPiiPayload(decryptPiiPayload(envelope));
  }
  const { blobId: newBlobId, endEpoch } = await storeEnvelopeInWalrusDetailed(resealed);
  return { newBlobId, newEndEpoch: endEpoch };
}

/**
 * Encodes a Uint8Array nonce to a hex string for storage in Postgres
 * (Move call args use the raw bytes; only off-chain bookkeeping uses hex).
 */
export function nonceToHex(nonce: Uint8Array): string {
  return Buffer.from(nonce).toString('hex');
}

export function hexToNonce(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}
