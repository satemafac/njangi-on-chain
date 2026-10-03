/**
 * How a failed Walrus read is reported (fetchEnvelopeFromWalrus, and
 * fetchAndDecryptPII on top of it). The WhatsApp phone lookups used to
 * catch every failure alike and read the blob as "no phone", so an
 * aggregator outage made a linked circle look unlinked: the crons advanced
 * past events whose messages were then lost. Every read failure now throws
 * a WalrusReadError whose `transient` flag tells the lookups which ones to
 * rethrow (network error, 5xx, 429, and a 401/403 refusal from a
 * misconfigured aggregator) and which to keep as per-blob warnings (404,
 * 410 and other 4xx, a body that is not an envelope).
 */

import { randomBytes } from 'crypto';
import {
  encryptPiiPayload,
  fetchAndDecryptPII,
  fetchEnvelopeFromWalrus,
  type EncryptedEnvelope,
  type WhatsAppPiiPayload,
} from '../walrus-pii';
import {
  WalrusReadError,
  isRefusedWalrusReadError,
  isTransientWalrusReadError,
} from '../walrus-read-error';

const BLOB = 'blob/with+chars';
const BLOB_URL = `https://aggregator.test/v1/blobs/${encodeURIComponent(BLOB)}`;
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
  'WALRUS_AGGREGATOR_URL',
];
const savedEnv = new Map<string, string | undefined>();
const ORIGINAL_FETCH = global.fetch;

type FakeResponse = { ok: boolean; status: number; text(): Promise<string> };

let fetchMock: jest.Mock;

/** The aggregator's answer to every read: a response, or a fetch rejection. */
function aggregatorAnswers(answer: () => Promise<FakeResponse>): void {
  fetchMock = jest.fn(async () => answer());
  global.fetch = fetchMock as unknown as typeof fetch;
}

function respond(status: number, body: string): () => Promise<FakeResponse> {
  return async () => ({ ok: status >= 200 && status < 300, status, text: async () => body });
}

/** The WalrusReadError a read of BLOB fails with. */
async function readFailure(): Promise<WalrusReadError> {
  try {
    await fetchEnvelopeFromWalrus(BLOB);
  } catch (err) {
    if (err instanceof WalrusReadError) return err;
    throw new Error(`expected a WalrusReadError, got: ${String(err)}`);
  }
  throw new Error('expected the read to fail');
}

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
  process.env.WALRUS_PII_MASTER_KEY = randomBytes(32).toString('hex');
  delete process.env.WALRUS_PII_PREVIOUS_MASTER_KEY;
  process.env.NEXT_PUBLIC_SUI_NETWORK = 'testnet';
  process.env.WALRUS_AGGREGATOR_URL = 'https://aggregator.test';
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  global.fetch = ORIGINAL_FETCH;
});

describe('transient read failures: a retry may succeed', () => {
  it.each([500, 502, 503, 504, 429])('an aggregator answer of %i', async (status) => {
    aggregatorAnswers(respond(status, 'try again later'));

    const err = await readFailure();

    expect(err).toMatchObject({ name: 'WalrusReadError', status, transient: true });
    expect(err.message).toBe(`Walrus aggregator returned ${status}: try again later`);
    expect(isTransientWalrusReadError(err)).toBe(true);
    expect(isRefusedWalrusReadError(err)).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith(BLOB_URL);
  });

  it('a network error, keeping the reason undici hides in the cause', async () => {
    const cause = new Error('connect ECONNREFUSED 203.0.113.7:443');
    const networkError = new TypeError('fetch failed', { cause });
    aggregatorAnswers(async () => {
      throw networkError;
    });

    const err = await readFailure();

    expect(err).toMatchObject({ status: null, transient: true });
    expect(err.message).toBe(
      'Walrus aggregator unreachable: fetch failed (connect ECONNREFUSED 203.0.113.7:443)',
    );
    expect(err.cause).toBe(networkError);
    expect(isTransientWalrusReadError(err)).toBe(true);
  });

  it('a connection that drops while the body is still arriving', async () => {
    aggregatorAnswers(async () => ({
      ok: true,
      status: 200,
      text: async () => {
        throw new TypeError('terminated');
      },
    }));

    const err = await readFailure();

    expect(err).toMatchObject({ status: 200, transient: true });
    expect(err.message).toBe('Walrus aggregator response was cut off: terminated');
  });
});

describe('refused reads: transient too, until the configuration is fixed', () => {
  // A 401 or 403 comes from a misconfigured WALRUS_AGGREGATOR_URL (or an
  // aggregator that will not serve this server), never from the blob: it is
  // no answer about the blob, so it must not read as "no phone".
  it.each([
    [401, 'unauthorized'],
    [403, 'forbidden'],
  ])('an aggregator answer of %i', async (status, body) => {
    aggregatorAnswers(respond(status, body));

    const err = await readFailure();

    expect(err).toMatchObject({ name: 'WalrusReadError', status, transient: true });
    expect(err.message).toBe(
      `Walrus aggregator returned ${status} (read refused: check WALRUS_AGGREGATOR_URL): ${body}`,
    );
    expect(isTransientWalrusReadError(err)).toBe(true);
    expect(isRefusedWalrusReadError(err)).toBe(true);
  });
});

describe('permanent read failures: the blob itself cannot answer', () => {
  it.each([
    [404, 'the requested blob ID does not exist on Walrus'],
    [410, 'gone'],
    [400, 'invalid blob ID'],
  ])('an aggregator answer of %i', async (status, body) => {
    aggregatorAnswers(respond(status, body));

    const err = await readFailure();

    expect(err).toMatchObject({ name: 'WalrusReadError', status, transient: false });
    expect(err.message).toBe(`Walrus aggregator returned ${status}: ${body}`);
    expect(isTransientWalrusReadError(err)).toBe(false);
    expect(isRefusedWalrusReadError(err)).toBe(false);
  });

  it.each([
    ['a body that is not JSON', '<html>not an envelope</html>'],
    ['JSON without the envelope fields', JSON.stringify({ v: 1, iv: 'aXY=' })],
    ['JSON null', 'null'],
  ])('%s', async (_case, body) => {
    aggregatorAnswers(respond(200, body));

    const err = await readFailure();

    expect(err).toMatchObject({ status: 200, transient: false });
    expect(err.message).toBe('Walrus aggregator returned a malformed envelope.');
  });
});

describe('fetchAndDecryptPII', () => {
  it('decrypts the envelope the aggregator serves', async () => {
    const envelope: EncryptedEnvelope = encryptPiiPayload(PAYLOAD);
    aggregatorAnswers(respond(200, JSON.stringify(envelope)));

    await expect(fetchAndDecryptPII(BLOB)).resolves.toEqual(PAYLOAD);
  });

  it('passes a transient read failure through unwrapped', async () => {
    aggregatorAnswers(respond(503, 'unavailable'));

    const failure = fetchAndDecryptPII(BLOB);

    await expect(failure).rejects.toBeInstanceOf(WalrusReadError);
    await expect(failure).rejects.toMatchObject({ status: 503, transient: true });
  });

  it('reports an envelope sealed with another key as a permanent failure', async () => {
    const envelope = encryptPiiPayload(PAYLOAD);
    process.env.WALRUS_PII_MASTER_KEY = randomBytes(32).toString('hex');
    aggregatorAnswers(respond(200, JSON.stringify(envelope)));

    const failure = fetchAndDecryptPII(BLOB).catch((err: unknown) => err);

    await expect(failure).resolves.toBeInstanceOf(Error);
    expect(isTransientWalrusReadError(await failure)).toBe(false);
  });
});

describe('isRefusedWalrusReadError', () => {
  it('is true only for a WalrusReadError with a 401 or 403 status', () => {
    expect(
      isRefusedWalrusReadError(new WalrusReadError('refused', { status: 403, transient: true })),
    ).toBe(true);
    expect(
      isRefusedWalrusReadError(new WalrusReadError('busy', { status: 503, transient: true })),
    ).toBe(false);
    expect(
      isRefusedWalrusReadError(new WalrusReadError('down', { status: null, transient: true })),
    ).toBe(false);
    expect(isRefusedWalrusReadError(new Error('Walrus aggregator returned 403: forbidden'))).toBe(
      false,
    );
    expect(isRefusedWalrusReadError({ status: 403 })).toBe(false);
  });
});

describe('isTransientWalrusReadError', () => {
  it('is false for anything but a transient WalrusReadError', () => {
    expect(
      isTransientWalrusReadError(new WalrusReadError('gone', { status: 404, transient: false })),
    ).toBe(false);
    expect(isTransientWalrusReadError(new Error('Walrus aggregator returned 503: busy'))).toBe(
      false,
    );
    expect(isTransientWalrusReadError({ transient: true })).toBe(false);
    expect(isTransientWalrusReadError(undefined)).toBe(false);
  });
});
