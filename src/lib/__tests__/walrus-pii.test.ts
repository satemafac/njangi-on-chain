// walrus-pii.test.ts — WALRUS_PII_MASTER_KEY rotation. Envelopes carry no
// key id, so before WALRUS_PII_PREVIOUS_MASTER_KEY existed a new master key
// made every stored WhatsApp link undecryptable, and the renewal cron could
// not re-store a blob it could not open. These tests pin the rotation path:
// the previous key opens old envelopes, renewal re-seals them under the
// current key, and an envelope neither key sealed is refused.

import { randomBytes } from 'crypto';
import {
  decryptPiiPayload,
  encryptPiiPayload,
  restorePiiBlob,
  type EncryptedEnvelope,
  type WhatsAppPiiPayload,
} from '../walrus-pii';

const OLD_KEY = randomBytes(32).toString('hex');
const NEW_KEY = randomBytes(32).toString('hex');
const UNRELATED_KEY = randomBytes(32).toString('hex');

const PAYLOAD: WhatsAppPiiPayload = {
  schema_version: 1,
  link_type: 'individual',
  phone_e164: '+237600000000',
  created_at: '2026-10-02T00:00:00.000Z',
};

const ENV_KEYS = [
  'WALRUS_PII_MASTER_KEY',
  'WALRUS_PII_PREVIOUS_MASTER_KEY',
  'NEXT_PUBLIC_SUI_NETWORK',
  'WALRUS_PUBLISHER_URL',
  'WALRUS_AGGREGATOR_URL',
  'WALRUS_STORAGE_EPOCHS',
];
const savedEnv = new Map<string, string | undefined>();
const ORIGINAL_FETCH = global.fetch;

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  global.fetch = ORIGINAL_FETCH;
});

function setKeys(master: string, previous?: string): void {
  process.env.WALRUS_PII_MASTER_KEY = master;
  if (previous === undefined) delete process.env.WALRUS_PII_PREVIOUS_MASTER_KEY;
  else process.env.WALRUS_PII_PREVIOUS_MASTER_KEY = previous;
}

function sealWith(key: string): EncryptedEnvelope {
  setKeys(key);
  return encryptPiiPayload(PAYLOAD);
}

function errorMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error('expected the call to throw');
}

describe('decryptPiiPayload during a key rotation', () => {
  it('opens an envelope sealed with the old key through WALRUS_PII_PREVIOUS_MASTER_KEY', () => {
    const envelope = sealWith(OLD_KEY);
    setKeys(NEW_KEY, OLD_KEY);

    expect(decryptPiiPayload(envelope)).toEqual(PAYLOAD);
  });

  it('still opens envelopes sealed with the current key', () => {
    const envelope = sealWith(NEW_KEY);
    setKeys(NEW_KEY, OLD_KEY);

    expect(decryptPiiPayload(envelope)).toEqual(PAYLOAD);
  });

  it('accepts the previous key in base64 as well as hex, like the master key', () => {
    const envelope = sealWith(OLD_KEY);
    setKeys(NEW_KEY, Buffer.from(OLD_KEY, 'hex').toString('base64'));

    expect(decryptPiiPayload(envelope)).toEqual(PAYLOAD);
  });

  it('cannot open an old envelope after the master key changed without a previous key', () => {
    const envelope = sealWith(OLD_KEY);
    setKeys(NEW_KEY);

    expect(errorMessage(() => decryptPiiPayload(envelope))).toContain(
      'set WALRUS_PII_PREVIOUS_MASTER_KEY to the old key',
    );
  });

  it('refuses an envelope neither key sealed, without echoing keys or the number', () => {
    const envelope = sealWith(UNRELATED_KEY);
    setKeys(NEW_KEY, OLD_KEY);

    const message = errorMessage(() => decryptPiiPayload(envelope));
    expect(message).toContain('opens with neither WALRUS_PII_MASTER_KEY nor WALRUS_PII_PREVIOUS_MASTER_KEY');
    for (const secret of [OLD_KEY, NEW_KEY, UNRELATED_KEY, '237600000000']) {
      expect(message).not.toContain(secret);
    }
  });

  it('refuses an altered envelope under both keys', () => {
    const envelope = sealWith(OLD_KEY);
    const ct = Buffer.from(envelope.ct, 'base64');
    ct[0] ^= 0x01;
    setKeys(NEW_KEY, OLD_KEY);

    expect(() => decryptPiiPayload({ ...envelope, ct: ct.toString('base64') })).toThrow(
      /opens with neither/,
    );
  });

  it('rejects a truncated auth tag instead of trying it against either key', () => {
    const envelope = sealWith(OLD_KEY);
    const tag = Buffer.from(envelope.tag, 'base64').subarray(0, 4);
    setKeys(NEW_KEY, OLD_KEY);

    expect(() => decryptPiiPayload({ ...envelope, tag: tag.toString('base64') })).toThrow(
      /authentication tag length/i,
    );
  });

  it('lets a malformed previous key fail only the envelopes that need it', () => {
    const current = sealWith(NEW_KEY);
    const old = sealWith(OLD_KEY);
    setKeys(NEW_KEY, 'not-a-32-byte-key');

    expect(decryptPiiPayload(current)).toEqual(PAYLOAD);
    expect(() => decryptPiiPayload(old)).toThrow(
      'WALRUS_PII_PREVIOUS_MASTER_KEY must decode to exactly 32 bytes',
    );
  });
});

describe('restorePiiBlob during a key rotation', () => {
  type FakeResponse = { ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> };
  const respond = (status: number, body: unknown): FakeResponse => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });

  /** Serves `stored` as blob `blob-old` and records every upload. */
  function fakeWalrus(stored: EncryptedEnvelope): EncryptedEnvelope[] {
    process.env.NEXT_PUBLIC_SUI_NETWORK = 'testnet';
    process.env.WALRUS_PUBLISHER_URL = 'https://publisher.test';
    process.env.WALRUS_AGGREGATOR_URL = 'https://aggregator.test';
    const uploads: EncryptedEnvelope[] = [];
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://aggregator.test/v1/blobs/blob-old') {
        return respond(200, stored);
      }
      if (url.startsWith('https://publisher.test/v1/blobs?') && init?.method === 'PUT') {
        uploads.push(JSON.parse(String(init.body)) as EncryptedEnvelope);
        return respond(200, {
          newlyCreated: { blobObject: { blobId: 'blob-new', storage: { endEpoch: 120 } } },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;
    return uploads;
  }

  it('re-encrypts an old-key blob under the current key', async () => {
    const uploads = fakeWalrus(sealWith(OLD_KEY));
    setKeys(NEW_KEY, OLD_KEY);

    await expect(restorePiiBlob('blob-old')).resolves.toEqual({
      newBlobId: 'blob-new',
      newEndEpoch: 120,
    });
    expect(uploads).toHaveLength(1);

    // The renewed copy opens with the new key alone, and not with the old one.
    setKeys(NEW_KEY);
    expect(decryptPiiPayload(uploads[0])).toEqual(PAYLOAD);
    setKeys(OLD_KEY);
    expect(() => decryptPiiPayload(uploads[0])).toThrow(/does not open with WALRUS_PII_MASTER_KEY/);
  });

  it('uploads nothing when neither key opens the blob', async () => {
    const uploads = fakeWalrus(sealWith(UNRELATED_KEY));
    setKeys(NEW_KEY, OLD_KEY);

    await expect(restorePiiBlob('blob-old')).rejects.toThrow(/opens with neither/);
    expect(uploads).toHaveLength(0);
  });
});
