// walrus-pii.ts — Encrypt-and-store WhatsApp PII payloads in Sui Walrus.
//
// The Move `whatsapp_integration` module no longer stores phone numbers,
// group IDs, or group names on chain. Instead, the server encrypts the
// payload here, uploads the ciphertext to Walrus, and anchors only the
// returned blob ID + an opaque correlation nonce on chain. Decryption
// happens server-side when the WhatsApp webhook needs to route a message.
//
// Key management: the AES-256-GCM master key is sourced from the
// WALRUS_PII_MASTER_KEY environment variable (32 bytes, hex or base64).
// Rotate it by deploying a new master key + re-encrypting any blobs that
// must remain accessible. Walrus blobs themselves are immutable.

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const AES_ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;
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

export type EncryptedEnvelope = {
  v: 1;
  iv: string; // base64
  ct: string; // base64 ciphertext (without tag)
  tag: string; // base64 GCM auth tag
};

export type StoredPiiPointer = {
  walrusBlobId: string; // returned by Walrus publisher
  linkNonce: Uint8Array; // 32 random bytes anchored on chain
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

  let key: Buffer;
  if (/^[0-9a-fA-F]+$/.test(raw) && raw.length === KEY_BYTES * 2) {
    key = Buffer.from(raw, 'hex');
  } else {
    key = Buffer.from(raw, 'base64');
  }

  if (key.length !== KEY_BYTES) {
    throw new Error(
      `WALRUS_PII_MASTER_KEY must decode to exactly ${KEY_BYTES} bytes (got ${key.length}).`,
    );
  }
  return key;
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

export function encryptPiiPayload(payload: WhatsAppPiiPayload): EncryptedEnvelope {
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

export function decryptPiiPayload(envelope: EncryptedEnvelope): WhatsAppPiiPayload {
  if (envelope.v !== 1) {
    throw new Error(`Unsupported envelope version: ${envelope.v}`);
  }
  const key = loadMasterKey();
  const iv = Buffer.from(envelope.iv, 'base64');
  const ct = Buffer.from(envelope.ct, 'base64');
  const tag = Buffer.from(envelope.tag, 'base64');
  const decipher = createDecipheriv(AES_ALGO, key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  const parsed = JSON.parse(plaintext) as WhatsAppPiiPayload;
  if (parsed.schema_version !== SCHEMA_VERSION) {
    throw new Error(`Unsupported PII schema version: ${parsed.schema_version}`);
  }
  return parsed;
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
 * Uploads an encrypted envelope to Walrus and returns the blob ID. The
 * publisher rejects payloads larger than its configured size cap; PII
 * envelopes are tiny so this is a non-issue in practice.
 */
export async function storeEnvelopeInWalrus(envelope: EncryptedEnvelope): Promise<string> {
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

  const data = (await response.json()) as
    | { newlyCreated?: { blobObject?: { blobId?: string } } }
    | { alreadyCertified?: { blobId?: string } };

  const blobId =
    ('newlyCreated' in data && data.newlyCreated?.blobObject?.blobId) ||
    ('alreadyCertified' in data && data.alreadyCertified?.blobId) ||
    null;

  if (!blobId) {
    throw new Error(`Walrus publisher returned an unexpected payload: ${JSON.stringify(data)}`);
  }
  return blobId;
}

/**
 * Fetches and decrypts a previously stored envelope. Used by the WhatsApp
 * webhook on cache miss to resolve a circle's routing target.
 */
export async function fetchEnvelopeFromWalrus(blobId: string): Promise<EncryptedEnvelope> {
  const { aggregator } = walrusEndpoints();
  const url = `${aggregator}/v1/blobs/${encodeURIComponent(blobId)}`;
  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text().catch(() => '<no body>');
    throw new Error(`Walrus aggregator returned ${response.status}: ${body}`);
  }
  const envelope = (await response.json()) as EncryptedEnvelope;
  if (typeof envelope?.iv !== 'string' || typeof envelope?.ct !== 'string' || typeof envelope?.tag !== 'string') {
    throw new Error('Walrus aggregator returned a malformed envelope.');
  }
  return envelope;
}

/**
 * High-level helper used by the WhatsApp linking flow. Encrypts the
 * payload, uploads it to Walrus, and returns the on-chain pointer
 * (blob ID + opaque nonce).
 */
export async function encryptAndStorePII(
  payload: WhatsAppPiiPayload,
): Promise<StoredPiiPointer> {
  const envelope = encryptPiiPayload(payload);
  const walrusBlobId = await storeEnvelopeInWalrus(envelope);
  return { walrusBlobId, linkNonce: generateLinkNonce() };
}

/**
 * High-level helper used by the WhatsApp webhook lookup path.
 */
export async function fetchAndDecryptPII(blobId: string): Promise<WhatsAppPiiPayload> {
  const envelope = await fetchEnvelopeFromWalrus(blobId);
  return decryptPiiPayload(envelope);
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
