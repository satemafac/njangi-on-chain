/**
 * Per-link data keys for WhatsApp PII envelopes (src/lib/whatsapp-pii-keys.ts,
 * envelope v2 in src/lib/walrus-pii.ts).
 *
 * Every envelope used to be sealed with the one WALRUS_PII_MASTER_KEY, so
 * unlinking or erasing a number only deleted index rows: the blobs (public
 * on Walrus, ids anchored on chain) stayed readable to us, and the phone
 * lookups' fallbacks to the anchored blob kept messaging the number until the
 * blob's lease ran out. Each link now gets its own data key, stored only in
 * Postgres and wrapped under the master key. These tests pin that:
 *
 *   - a new link is sealed as v2 under its own key, stored before the upload;
 *   - deleting the key (erasure, unlink) makes every copy unreadable, and
 *     the readers see "no phone", never a failure;
 *   - a key-table read that fails is a transient failure, never "erased";
 *   - renewal re-seals under the same key; v1 envelopes still open;
 *   - a master-key rotation only re-wraps keys;
 *   - the index takes only links whose key is live.
 *
 * Postgres is an in-memory fake that answers the module's SQL (and the SQL
 * the deletion and re-wrap scripts run), Walrus an in-memory blob store
 * behind a fetch mock. Phone numbers come from Ofcom's range for fiction.
 */

import { createDecipheriv, createHmac, randomBytes } from 'crypto';

interface FakeKeyRow {
  kid: string;
  wrapped_dek: string;
  kek_id: string;
  phone_hmac: string;
  circle_id: string;
  link_nonce: string;
  created_at: Date;
  unlinked_at: Date | null;
}

interface FakeIndexRow {
  id: number;
  phone_hmac: string;
  circle_id: string;
  walrus_blob_id: string;
  walrus_end_epoch: number | null;
}

const mockDb = {
  keys: new Map<string, FakeKeyRow>(),
  index: [] as FakeIndexRow[],
  down: false,
  log: [] as string[],
};

const mockPool = {
  query: async (text: string, params: unknown[] = []) => {
    const sql = text.replace(/\s+/g, ' ').trim();
    mockDb.log.push(sql);
    if (mockDb.down) throw new Error('Connection terminated unexpectedly');
    const p = params as string[];
    if (sql.startsWith('CREATE TABLE IF NOT EXISTS')) return { rows: [], rowCount: 0 };
    if (sql.startsWith('INSERT INTO whatsapp_pii_keys')) {
      const [kid, wrapped_dek, kek_id, phone_hmac, circle_id, link_nonce] = p;
      mockDb.keys.set(kid, {
        kid,
        wrapped_dek,
        kek_id,
        phone_hmac,
        circle_id,
        link_nonce,
        created_at: new Date(),
        unlinked_at: null,
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql === 'SELECT kid, wrapped_dek, kek_id FROM whatsapp_pii_keys WHERE kid = $1') {
      const row = mockDb.keys.get(p[0]);
      return { rows: row ? [{ kid: row.kid, wrapped_dek: row.wrapped_dek, kek_id: row.kek_id }] : [] };
    }
    if (sql === 'DELETE FROM whatsapp_pii_keys WHERE kid = $1') {
      return { rows: [], rowCount: mockDb.keys.delete(p[0]) ? 1 : 0 };
    }
    if (sql === 'UPDATE whatsapp_pii_keys SET unlinked_at = NOW() WHERE circle_id = $1 AND unlinked_at IS NULL') {
      let rowCount = 0;
      for (const row of mockDb.keys.values()) {
        if (row.circle_id === p[0] && row.unlinked_at === null) {
          row.unlinked_at = new Date();
          rowCount += 1;
        }
      }
      return { rows: [], rowCount };
    }
    if (sql === 'DELETE FROM whatsapp_pii_keys WHERE circle_id = $1 AND link_nonce = $2') {
      return { rows: [], rowCount: deleteKeys((row) => row.circle_id === p[0] && row.link_nonce === p[1]) };
    }
    if (sql === 'DELETE FROM whatsapp_pii_keys WHERE unlinked_at < NOW() - make_interval(hours => $1)') {
      const cutoff = Date.now() - Number(params[0]) * 60 * 60 * 1000;
      return {
        rows: [],
        rowCount: deleteKeys((row) => row.unlinked_at !== null && row.unlinked_at.getTime() < cutoff),
      };
    }
    // scripts/process-deletion-request.mjs
    if (sql === 'DELETE FROM whatsapp_pii_keys WHERE phone_hmac = $1') {
      return { rows: [], rowCount: deleteKeys((row) => row.phone_hmac === p[0]) };
    }
    // scripts/rewrap-whatsapp-pii-keys.mjs
    if (sql === 'UPDATE whatsapp_pii_keys SET wrapped_dek = $1, kek_id = $2 WHERE kid = $3 AND kek_id = $4') {
      const row = mockDb.keys.get(p[2]);
      if (!row || row.kek_id !== p[3]) return { rows: [], rowCount: 0 };
      row.wrapped_dek = p[0];
      row.kek_id = p[1];
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO whatsapp_phone_index')) {
      const [phone_hmac, circle_id, walrus_blob_id] = p;
      // Applied only when the statement carries the live-key condition, so
      // the test fails if the condition is dropped.
      const guarded = sql.includes(
        'WHERE EXISTS ( SELECT 1 FROM whatsapp_pii_keys k WHERE k.phone_hmac = $1::text ' +
          'AND k.circle_id = $2::text AND k.unlinked_at IS NULL )',
      );
      const live = [...mockDb.keys.values()].some(
        (row) => row.phone_hmac === phone_hmac && row.circle_id === circle_id && row.unlinked_at === null,
      );
      if (guarded && !live) return { rows: [], rowCount: 0 };
      mockDb.index = mockDb.index.filter((row) => !(row.phone_hmac === phone_hmac && row.circle_id === circle_id));
      mockDb.index.push({
        id: mockDb.index.length + 100,
        phone_hmac,
        circle_id,
        walrus_blob_id,
        walrus_end_epoch: (params[4] as number | null) ?? null,
      });
      return { rows: [], rowCount: 1 };
    }
    // scripts/process-deletion-request.mjs
    if (sql === 'DELETE FROM whatsapp_phone_index WHERE phone_hmac = $1') {
      const before = mockDb.index.length;
      mockDb.index = mockDb.index.filter((row) => row.phone_hmac !== p[0]);
      return { rows: [], rowCount: before - mockDb.index.length };
    }
    if (
      sql ===
      'SELECT idx.id, idx.circle_id, idx.walrus_blob_id, idx.walrus_end_epoch FROM whatsapp_phone_index idx ORDER BY idx.id ASC'
    ) {
      return { rows: mockDb.index.map(({ id, circle_id, walrus_blob_id, walrus_end_epoch }) => ({ id, circle_id, walrus_blob_id, walrus_end_epoch })) };
    }
    throw new Error(`fake pg: unexpected SQL: ${sql}`);
  },
};

function deleteKeys(match: (row: FakeKeyRow) => boolean): number {
  let deleted = 0;
  for (const [kid, row] of mockDb.keys) {
    if (match(row)) {
      mockDb.keys.delete(kid);
      deleted += 1;
    }
  }
  return deleted;
}

jest.mock('../pg-pool', () => ({
  isPostgresConfigured: () => true,
  getSharedPgPool: () => mockPool,
  assertDatabaseUrlInProduction: () => undefined,
}));

import {
  decryptPiiPayload,
  encryptAndStorePII,
  encryptPiiPayload,
  fetchAndDecryptPII,
  nonceToHex,
  restorePiiBlob,
  type EncryptedEnvelope,
  type EncryptedEnvelopeV2,
  type WhatsAppPiiPayload,
} from '../walrus-pii';
import {
  UNLINKED_KEY_GRACE_HOURS,
  __resetWhatsAppPiiKeysForTests,
  deleteUnlinkedLinkKey,
  loadLinkDataKey,
  markCircleLinkKeysUnlinked,
  sweepUnlinkedLinkKeys,
} from '../whatsapp-pii-keys';
import { PiiKeyErasedError, PiiKeyReadError, isErasedPiiKeyError } from '../pii-key-errors';
import { isTransientWalrusReadError } from '../walrus-read-error';
import {
  indexWhatsAppLink,
  listActiveLinksForRenewal,
  __resetWhatsAppLinkIndexForTests,
} from '../whatsapp-link-index';
import { decodePiiMasterKey, kekOf, planRewrap } from '../../../scripts/lib/pii-key-wrap';
import { phoneForErasure } from '../../../scripts/lib/whatsapp-phone';

const OLD_KEY = randomBytes(32).toString('hex');
const NEW_KEY = randomBytes(32).toString('hex');
const SALT = 'test-lookup-salt';
const PHONE = '+447700900123';
const OTHER_PHONE = '+447700900456';
const CIRCLE = `0x${'c1'.repeat(32)}`;
const OTHER_CIRCLE = `0x${'c2'.repeat(32)}`;

const payload = (phone = PHONE): WhatsAppPiiPayload => ({
  schema_version: 1,
  link_type: 'individual',
  phone_e164: phone,
  created_at: '2026-10-03T09:00:00.000Z',
});

const ENV_KEYS = [
  'WALRUS_PII_MASTER_KEY',
  'WALRUS_PII_PREVIOUS_MASTER_KEY',
  'WALRUS_LOOKUP_SALT',
  'NEXT_PUBLIC_SUI_NETWORK',
  'WALRUS_PUBLISHER_URL',
  'WALRUS_AGGREGATOR_URL',
];
const savedEnv = new Map<string, string | undefined>();
const ORIGINAL_FETCH = global.fetch;

/** Walrus stand-in: blob id → stored body, uploads in order. */
const walrus = {
  blobs: new Map<string, string>(),
  uploads: [] as EncryptedEnvelope[],
  failUploads: false,
  events: [] as string[],
};

function respond(status: number, body: unknown) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(text),
    text: async () => text,
  };
}

function setKeys(master: string, previous?: string): void {
  process.env.WALRUS_PII_MASTER_KEY = master;
  if (previous === undefined) delete process.env.WALRUS_PII_PREVIOUS_MASTER_KEY;
  else process.env.WALRUS_PII_PREVIOUS_MASTER_KEY = previous;
}

/** The phone_hmac the deletion script computes for `--phone <input>`. */
function erasureHash(input: string): string {
  return createHmac('sha256', SALT).update(phoneForErasure(input) as string).digest('hex');
}

/** What scripts/process-deletion-request.mjs runs for a number (in one transaction). */
async function eraseNumber(input: string): Promise<void> {
  await mockPool.query('DELETE FROM whatsapp_pii_keys WHERE phone_hmac = $1', [erasureHash(input)]);
  await mockPool.query('DELETE FROM whatsapp_phone_index WHERE phone_hmac = $1', [erasureHash(input)]);
}

function storedEnvelope(blobId: string): EncryptedEnvelope {
  return JSON.parse(walrus.blobs.get(blobId) as string) as EncryptedEnvelope;
}

/** Stores `envelope` as a blob, as an upload would. */
function putBlob(envelope: EncryptedEnvelope): string {
  const blobId = `blob-${walrus.blobs.size + 1}`;
  walrus.blobs.set(blobId, JSON.stringify(envelope));
  return blobId;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection');
}

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
  setKeys(NEW_KEY);
  process.env.WALRUS_LOOKUP_SALT = SALT;
  process.env.NEXT_PUBLIC_SUI_NETWORK = 'testnet';
  process.env.WALRUS_PUBLISHER_URL = 'https://publisher.test';
  process.env.WALRUS_AGGREGATOR_URL = 'https://aggregator.test';
  mockDb.keys.clear();
  mockDb.index = [];
  mockDb.down = false;
  mockDb.log = [];
  walrus.blobs.clear();
  walrus.uploads = [];
  walrus.failUploads = false;
  walrus.events = [];
  __resetWhatsAppPiiKeysForTests();
  __resetWhatsAppLinkIndexForTests();
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('https://publisher.test/v1/blobs?') && init?.method === 'PUT') {
      walrus.events.push('upload');
      mockDb.log.push('<walrus upload>');
      if (walrus.failUploads) return respond(500, 'publisher down');
      const envelope = JSON.parse(String(init.body)) as EncryptedEnvelope;
      walrus.uploads.push(envelope);
      const blobId = putBlob(envelope);
      return respond(200, { newlyCreated: { blobObject: { blobId, storage: { endEpoch: 120 } } } });
    }
    const prefix = 'https://aggregator.test/v1/blobs/';
    if (url.startsWith(prefix)) {
      const body = walrus.blobs.get(decodeURIComponent(url.slice(prefix.length)));
      return body === undefined ? respond(404, 'not found') : respond(200, body);
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  global.fetch = ORIGINAL_FETCH;
});

async function link(phone = PHONE, circleId = CIRCLE) {
  const pointer = await encryptAndStorePII(payload(phone), { circleId });
  const envelope = storedEnvelope(pointer.walrusBlobId) as EncryptedEnvelopeV2;
  return { pointer, envelope, blobId: pointer.walrusBlobId };
}

describe('a new link', () => {
  it('is sealed as a v2 envelope under its own data key, stored before the upload', async () => {
    mockDb.log = [];
    const { pointer, envelope } = await link();

    expect(envelope.v).toBe(2);
    expect(envelope.kid).toMatch(/^[0-9a-f]{32}$/);
    const row = mockDb.keys.get(envelope.kid) as FakeKeyRow;
    expect(row).toBeDefined();
    expect(row.circle_id).toBe(CIRCLE);
    expect(row.link_nonce).toBe(nonceToHex(pointer.linkNonce));
    // The same HMAC as the index row and as the deletion script's --phone.
    expect(row.phone_hmac).toBe(erasureHash('+44 7700 900123'));
    expect(row.kek_id).toBe(kekOf(decodePiiMasterKey('k', NEW_KEY)).id);
    // Key first, upload second.
    const insertAt = mockDb.log.findIndex((sql) => sql.startsWith('INSERT INTO whatsapp_pii_keys'));
    expect(insertAt).toBeGreaterThanOrEqual(0);
    expect(insertAt).toBeLessThan(mockDb.log.indexOf('<walrus upload>'));
    expect(walrus.events).toEqual(['upload']);
    // Nothing secret leaves in the clear: the envelope has no key material.
    expect(Object.keys(envelope).sort()).toEqual(['ct', 'iv', 'kid', 'tag', 'v']);
    expect(JSON.stringify(envelope)).not.toContain('447700900123');
  });

  it('opens again through fetchAndDecryptPII', async () => {
    const { blobId } = await link();
    await expect(fetchAndDecryptPII(blobId)).resolves.toEqual(payload());
  });

  it('does not open with the master key alone', async () => {
    const { envelope } = await link();

    expect(() => decryptPiiPayload(envelope)).toThrow(/opens with its data key/);
    const decipher = createDecipheriv(
      'aes-256-gcm',
      Buffer.from(NEW_KEY, 'hex'),
      Buffer.from(envelope.iv, 'base64'),
      { authTagLength: 16 },
    );
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    decipher.update(Buffer.from(envelope.ct, 'base64'));
    expect(() => decipher.final()).toThrow();
  });

  it('gets a key of its own: an envelope relabelled with another link\'s key id does not open', async () => {
    const first = await link();
    const second = await link(OTHER_PHONE, OTHER_CIRCLE);
    expect(first.envelope.kid).not.toBe(second.envelope.kid);

    const relabelled = putBlob({ ...first.envelope, kid: second.envelope.kid });
    const err = await rejection(fetchAndDecryptPII(relabelled));
    expect(err).toBeInstanceOf(Error);
    expect(isErasedPiiKeyError(err)).toBe(false);
    expect(isTransientWalrusReadError(err)).toBe(false);
  });

  it('keeps no key when the upload fails', async () => {
    walrus.failUploads = true;
    await expect(encryptAndStorePII(payload(), { circleId: CIRCLE })).rejects.toThrow(
      /Walrus publisher rejected upload \(500\)/,
    );
    expect(mockDb.keys.size).toBe(0);
  });

  it('uploads nothing when its key cannot be stored', async () => {
    mockDb.down = true;
    await expect(encryptAndStorePII(payload(), { circleId: CIRCLE })).rejects.toThrow(
      'Connection terminated unexpectedly',
    );
    expect(walrus.events).toEqual([]);
  });
});

describe('erasure', () => {
  it('deletes the key, after which no copy of the envelope opens, renewed ones included', async () => {
    const { blobId } = await link();
    const other = await link(OTHER_PHONE, OTHER_CIRCLE);
    const { newBlobId: renewedId } = await restorePiiBlob(blobId);
    await expect(fetchAndDecryptPII(renewedId)).resolves.toEqual(payload());

    await eraseNumber('+44 7700 900123');

    for (const copy of [blobId, renewedId]) {
      const err = await rejection(fetchAndDecryptPII(copy));
      expect(err).toBeInstanceOf(PiiKeyErasedError);
      // Erased is a fact, not a failure: the lookups skip it, nothing retries.
      expect(isTransientWalrusReadError(err)).toBe(false);
    }
    // Other numbers are untouched.
    await expect(fetchAndDecryptPII(other.blobId)).resolves.toEqual(payload(OTHER_PHONE));
  });

  it('leaves the renewal nothing to renew: no upload for an erased link', async () => {
    const { blobId } = await link();
    await eraseNumber(PHONE);
    walrus.uploads = [];

    await expect(restorePiiBlob(blobId)).rejects.toBeInstanceOf(PiiKeyErasedError);
    expect(walrus.uploads).toEqual([]);
  });

  it('reads a key id that has no row as erased (absent), not as a failure', async () => {
    const { envelope } = await link();
    const orphan = putBlob({ ...envelope, kid: 'ab'.repeat(16) });

    const err = await rejection(fetchAndDecryptPII(orphan));
    expect(err).toBeInstanceOf(PiiKeyErasedError);
    await expect(loadLinkDataKey('ab'.repeat(16))).resolves.toBeNull();
  });
});

describe('a failed key read', () => {
  it('is unknown, never erased: a transient failure the lookups halt and retry on', async () => {
    const { blobId } = await link();
    mockDb.down = true;

    const err = await rejection(fetchAndDecryptPII(blobId));
    expect(err).toBeInstanceOf(PiiKeyReadError);
    expect(isErasedPiiKeyError(err)).toBe(false);
    expect(isTransientWalrusReadError(err)).toBe(true);

    mockDb.down = false;
    await expect(fetchAndDecryptPII(blobId)).resolves.toEqual(payload());
  });

  it('fails the renewal of that blob without uploading', async () => {
    const { blobId } = await link();
    mockDb.down = true;
    walrus.uploads = [];

    await expect(restorePiiBlob(blobId)).rejects.toBeInstanceOf(PiiKeyReadError);
    expect(walrus.uploads).toEqual([]);
  });

  it('includes a key wrapped under a master key this deployment does not hold', async () => {
    setKeys(OLD_KEY);
    const { blobId } = await link();
    setKeys(NEW_KEY); // rotated without WALRUS_PII_PREVIOUS_MASTER_KEY

    const err = await rejection(fetchAndDecryptPII(blobId));
    expect(err).toBeInstanceOf(PiiKeyReadError);
    expect(isTransientWalrusReadError(err)).toBe(true);
    expect((err as Error).message).toContain('WALRUS_PII_PREVIOUS_MASTER_KEY');
    for (const secret of [OLD_KEY, NEW_KEY, '447700900123']) {
      expect((err as Error).message).not.toContain(secret);
    }
  });
});

describe('a master-key rotation', () => {
  it('opens old keys through WALRUS_PII_PREVIOUS_MASTER_KEY, and only re-wraps keys', async () => {
    setKeys(OLD_KEY);
    const a = await link();
    const b = await link(OTHER_PHONE, OTHER_CIRCLE);
    setKeys(NEW_KEY, OLD_KEY);
    await expect(fetchAndDecryptPII(a.blobId)).resolves.toEqual(payload());
    const blobsBefore = walrus.blobs.size;

    // What scripts/rewrap-whatsapp-pii-keys.mjs does for each row.
    const ring = {
      current: kekOf(decodePiiMasterKey('WALRUS_PII_MASTER_KEY', NEW_KEY)),
      previous: kekOf(decodePiiMasterKey('WALRUS_PII_PREVIOUS_MASTER_KEY', OLD_KEY)),
    };
    for (const row of [...mockDb.keys.values()]) {
      const plan = planRewrap(row, ring);
      expect(plan.action).toBe('rewrap');
      if (plan.action !== 'rewrap') continue;
      const result = await mockPool.query(
        'UPDATE whatsapp_pii_keys SET wrapped_dek = $1, kek_id = $2 WHERE kid = $3 AND kek_id = $4',
        [plan.wrappedDek, plan.kekId, row.kid, row.kek_id],
      );
      expect(result.rowCount).toBe(1);
    }

    // The old key can go: every envelope opens under the new key alone,
    // and not one blob was rewritten.
    setKeys(NEW_KEY);
    await expect(fetchAndDecryptPII(a.blobId)).resolves.toEqual(payload());
    await expect(fetchAndDecryptPII(b.blobId)).resolves.toEqual(payload(OTHER_PHONE));
    expect(walrus.blobs.size).toBe(blobsBefore);
  });
});

describe('renewal', () => {
  it('re-seals a v2 envelope under the same key id with a fresh IV', async () => {
    const { blobId, envelope } = await link();
    walrus.uploads = [];

    const { newBlobId } = await restorePiiBlob(blobId);

    const renewed = walrus.uploads[0] as EncryptedEnvelopeV2;
    expect(renewed.v).toBe(2);
    expect(renewed.kid).toBe(envelope.kid);
    expect(renewed.iv).not.toBe(envelope.iv);
    expect(mockDb.keys.size).toBe(1);
    await expect(fetchAndDecryptPII(newBlobId)).resolves.toEqual(payload());
  });

  it('still opens and re-seals a v1 envelope with the master key, as before', async () => {
    const v1 = putBlob(encryptPiiPayload(payload()));
    await expect(fetchAndDecryptPII(v1)).resolves.toEqual(payload());

    const { newBlobId } = await restorePiiBlob(v1);
    expect(storedEnvelope(newBlobId).v).toBe(1);
    await expect(fetchAndDecryptPII(newBlobId)).resolves.toEqual(payload());
    expect(mockDb.keys.size).toBe(0);
  });
});

describe('unlink', () => {
  it('keeps the key readable until the unlinked link\'s key is deleted by its nonce', async () => {
    const unlinked = await link();
    await markCircleLinkKeysUnlinked(CIRCLE);
    // The "Circle disconnected" message still needs the number.
    await expect(fetchAndDecryptPII(unlinked.blobId)).resolves.toEqual(payload());

    // The admin linked the circle again, and another circle is linked too.
    const relinked = await link(PHONE, CIRCLE);
    const other = await link(OTHER_PHONE, OTHER_CIRCLE);

    await expect(deleteUnlinkedLinkKey(CIRCLE, nonceToHex(unlinked.pointer.linkNonce))).resolves.toBe(1);

    await expect(fetchAndDecryptPII(unlinked.blobId)).rejects.toBeInstanceOf(PiiKeyErasedError);
    await expect(fetchAndDecryptPII(relinked.blobId)).resolves.toEqual(payload());
    await expect(fetchAndDecryptPII(other.blobId)).resolves.toEqual(payload(OTHER_PHONE));
  });

  it('matches the nonce whatever its case', async () => {
    const { pointer } = await link();
    await expect(deleteUnlinkedLinkKey(CIRCLE, nonceToHex(pointer.linkNonce).toUpperCase())).resolves.toBe(1);
  });

  it('sweeps only keys unlinked longer ago than the grace period', async () => {
    const old = await link();
    const recent = await link(OTHER_PHONE, OTHER_CIRCLE);
    const live = await link(PHONE, `0x${'c3'.repeat(32)}`);
    await markCircleLinkKeysUnlinked(CIRCLE);
    await markCircleLinkKeysUnlinked(OTHER_CIRCLE);
    (mockDb.keys.get(old.envelope.kid) as FakeKeyRow).unlinked_at = new Date(
      Date.now() - (UNLINKED_KEY_GRACE_HOURS + 1) * 60 * 60 * 1000,
    );

    await expect(sweepUnlinkedLinkKeys()).resolves.toBe(1);

    expect(mockDb.keys.has(old.envelope.kid)).toBe(false);
    expect(mockDb.keys.has(recent.envelope.kid)).toBe(true);
    expect(mockDb.keys.has(live.envelope.kid)).toBe(true);
  });
});

describe('the link index', () => {
  const confirm = (phone = PHONE, circleId = CIRCLE) =>
    indexWhatsAppLink({ phoneOrGroup: phone, circleId, walrusBlobId: 'blob-x', linkType: 1 });

  it('indexes a confirmed link whose key is live', async () => {
    await link();
    await expect(confirm()).resolves.toBe(true);
    expect(mockDb.index).toHaveLength(1);
  });

  it('refuses a number the prepare call never sealed for that circle', async () => {
    await link();
    await expect(confirm(OTHER_PHONE)).resolves.toBe(false);
    await expect(confirm(PHONE, OTHER_CIRCLE)).resolves.toBe(false);
    expect(mockDb.index).toEqual([]);
  });

  it('renews a number linked again after its erasure (new consent), and only the new link', async () => {
    const first = await link();
    await confirm();
    await eraseNumber(PHONE);
    expect(mockDb.index).toEqual([]);

    const second = await link();
    await indexWhatsAppLink({
      phoneOrGroup: PHONE,
      circleId: CIRCLE,
      walrusBlobId: second.blobId,
      linkType: 1,
    });

    // No erasure filter keeps the new link out of renewal any more.
    const due = await listActiveLinksForRenewal();
    expect(due.map((row) => row.walrusBlobId)).toEqual([second.blobId]);
    await expect(restorePiiBlob(second.blobId)).resolves.toEqual(
      expect.objectContaining({ newEndEpoch: 120 }),
    );
    // The erased link stays dark.
    await expect(fetchAndDecryptPII(first.blobId)).rejects.toBeInstanceOf(PiiKeyErasedError);
  });

  it('refuses a late or replayed confirmation after an erasure or an unlink', async () => {
    await link();
    await eraseNumber(PHONE);
    await expect(confirm()).resolves.toBe(false);

    await link(OTHER_PHONE, OTHER_CIRCLE);
    await markCircleLinkKeysUnlinked(OTHER_CIRCLE);
    await expect(confirm(OTHER_PHONE, OTHER_CIRCLE)).resolves.toBe(false);
    expect(mockDb.index).toEqual([]);
  });
});
