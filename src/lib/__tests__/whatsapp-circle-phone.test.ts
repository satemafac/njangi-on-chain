/**
 * Circle-addressed phone lookup (resolveCirclePhone), the
 * whatsapp-circle-events cron's route to a circle's linked phone.
 * /api/cron/walrus-renewal re-stores each PII blob before its Walrus lease
 * ends and records the new blob id ONLY in the Postgres index; the
 * on-chain anchor keeps the original. The lookup reads the index first and
 * falls back to the anchored blob. When the index read itself failed and
 * the anchor had expired, it returned null, which the cron records as
 * "circle not linked": the cursor advanced and the event's message was
 * lost for good. It now rethrows the index error, so the cron halts and
 * retries.
 */

jest.mock('../walrus-pii', () => ({
  fetchAndDecryptPII: jest.fn(),
}));
jest.mock('../whatsapp-link-index', () => ({
  lookupBlobsForCircle: jest.fn(),
}));
jest.mock('../../services/whatsapp-registry-service', () => ({
  getActiveWhatsAppRegistries: jest.fn(),
}));
jest.mock('../../utils/logger', () => ({
  appLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import type { SuiClient } from '@mysten/sui/client';
import { resolveCirclePhone } from '../whatsapp-bot/circle-phone';
import { fetchAndDecryptPII } from '../walrus-pii';
import type { WhatsAppPiiPayload } from '../walrus-pii';
import { lookupBlobsForCircle } from '../whatsapp-link-index';
import { getActiveWhatsAppRegistries } from '../../services/whatsapp-registry-service';
import { appLogger } from '../../utils/logger';

const CIRCLE = `0x${'c3'.repeat(32)}`;
const OTHER_CIRCLE = `0x${'d4'.repeat(32)}`;
const ADMIN = `0x${'a1'.repeat(32)}`;
const ANCHORED_BLOB = 'anchored-blob-original-lease';
const RENEWED_BLOB = 'renewed-blob-from-renewal-cron';
const PHONE = '+237600000001';
const INDEX_DOWN = new Error('Connection terminated unexpectedly');

const decryptMock = fetchAndDecryptPII as jest.MockedFunction<typeof fetchAndDecryptPII>;
const indexMock = lookupBlobsForCircle as jest.MockedFunction<typeof lookupBlobsForCircle>;
const registriesMock = getActiveWhatsAppRegistries as jest.MockedFunction<
  typeof getActiveWhatsAppRegistries
>;
const getObject = jest.fn();
const client = { getObject } as unknown as SuiClient;

/** A WhatsAppLink as Sui JSON-RPC renders it (vector<u8> → number[]). */
function onChainLink(opts: { circleId: string; blobId: string; enabled?: boolean }) {
  return {
    type: '0xwa::whatsapp_integration::WhatsAppLink',
    fields: {
      circle_id: opts.circleId,
      link_type: 1,
      walrus_blob_id: Array.from(Buffer.from(opts.blobId, 'utf8')),
      linked_by: ADMIN,
      enabled: opts.enabled ?? true,
    },
  };
}

function registryHolds(...links: unknown[]) {
  getObject.mockResolvedValue({
    data: { content: { dataType: 'moveObject', fields: { links } } },
  });
}

function individual(phone: string): WhatsAppPiiPayload {
  return {
    schema_version: 1,
    link_type: 'individual',
    phone_e164: phone,
    created_at: '2026-06-01T00:00:00.000Z',
  };
}

/** Walrus aggregator stand-in: any blob not listed has expired (404). */
function walrusStores(blobs: Record<string, WhatsAppPiiPayload | Error>) {
  decryptMock.mockImplementation(async (blobId: string) => {
    const stored = blobs[blobId];
    if (stored instanceof Error) throw stored;
    if (!stored) throw new Error(`Walrus aggregator returned 404: ${blobId} not found`);
    return stored;
  });
}

/** Blob ids the lookup fetched from Walrus, in order. */
function fetchedBlobs(): string[] {
  return decryptMock.mock.calls.map(([blobId]) => blobId);
}

function resolve(options?: { includeDisabled?: boolean }) {
  return resolveCirclePhone(client, CIRCLE, 'testnet', options);
}

beforeEach(() => {
  getObject.mockReset();
  decryptMock.mockReset();
  indexMock.mockReset();
  registriesMock
    .mockReset()
    .mockReturnValue([{ packageId: '0xwa', registryObjectId: '0xregistry' }]);
});

describe('index first, registry fallback', () => {
  it('decrypts the renewed blob from the index without reading the registry', async () => {
    indexMock.mockResolvedValue([RENEWED_BLOB]);
    walrusStores({ [RENEWED_BLOB]: individual(PHONE) });

    await expect(resolve()).resolves.toBe(PHONE);
    expect(indexMock).toHaveBeenCalledWith(CIRCLE);
    expect(fetchedBlobs()).toEqual([RENEWED_BLOB]);
    expect(getObject).not.toHaveBeenCalled();
  });

  it('falls back to the anchored blob when the index has no row for the circle', async () => {
    indexMock.mockResolvedValue([]);
    registryHolds(onChainLink({ circleId: CIRCLE, blobId: ANCHORED_BLOB }));
    walrusStores({ [ANCHORED_BLOB]: individual(PHONE) });

    await expect(resolve()).resolves.toBe(PHONE);
    expect(getObject).toHaveBeenCalledWith({
      id: '0xregistry',
      options: { showContent: true },
    });
    // Decoded from the vector<u8> byte array the registry returns.
    expect(fetchedBlobs()).toEqual([ANCHORED_BLOB]);
    expect(appLogger.warn).not.toHaveBeenCalled();
  });

  it('returns null when neither the index nor the registry links the circle', async () => {
    indexMock.mockResolvedValue([]);
    registryHolds(onChainLink({ circleId: OTHER_CIRCLE, blobId: 'not-this-circle' }));

    await expect(resolve()).resolves.toBeNull();
    expect(decryptMock).not.toHaveBeenCalled();
  });

  it('warns about an indexed blob that fails to decrypt and moves on to the registry', async () => {
    indexMock.mockResolvedValue([RENEWED_BLOB]);
    registryHolds(onChainLink({ circleId: CIRCLE, blobId: ANCHORED_BLOB }));
    walrusStores({
      [RENEWED_BLOB]: new Error('Unsupported state or unable to authenticate data'),
      [ANCHORED_BLOB]: individual(PHONE),
    });

    await expect(resolve()).resolves.toBe(PHONE);
    expect(fetchedBlobs()).toEqual([RENEWED_BLOB, ANCHORED_BLOB]);
    expect(appLogger.warn).toHaveBeenCalledWith(
      '[circle-phone] failed to decrypt PII envelope',
      expect.objectContaining({ circleId: CIRCLE }),
    );
  });

  it('returns null, not a throw, when the index was read but no blob decrypts', async () => {
    // A decrypt failure is per-blob, not an infra failure: one corrupt
    // envelope must not wedge the stream.
    indexMock.mockResolvedValue([RENEWED_BLOB]);
    registryHolds(onChainLink({ circleId: CIRCLE, blobId: ANCHORED_BLOB }));
    walrusStores({
      [RENEWED_BLOB]: new Error('Unsupported state or unable to authenticate data'),
    });

    await expect(resolve()).resolves.toBeNull();
    expect(fetchedBlobs()).toEqual([RENEWED_BLOB, ANCHORED_BLOB]);
  });

  it('propagates a registry read failure', async () => {
    indexMock.mockResolvedValue([]);
    getObject.mockRejectedValue(new Error('all RPC candidates failed'));

    await expect(resolve()).rejects.toThrow('all RPC candidates failed');
  });
});

describe('index unreadable', () => {
  beforeEach(() => {
    indexMock.mockRejectedValue(INDEX_DOWN);
  });

  it('still resolves through the anchored blob while its lease is alive', async () => {
    registryHolds(onChainLink({ circleId: CIRCLE, blobId: ANCHORED_BLOB }));
    walrusStores({ [ANCHORED_BLOB]: individual(PHONE) });

    await expect(resolve()).resolves.toBe(PHONE);
    expect(appLogger.warn).toHaveBeenCalledWith(
      '[circle-phone] index lookup failed; falling back to registry scan',
      { circleId: CIRCLE, error: 'Connection terminated unexpectedly' },
    );
  });

  it('rethrows the index error instead of returning null once the anchor has expired', async () => {
    registryHolds(onChainLink({ circleId: CIRCLE, blobId: ANCHORED_BLOB }));
    walrusStores({});

    await expect(resolve()).rejects.toBe(INDEX_DOWN);
    // The anchored blob was still tried before giving up.
    expect(fetchedBlobs()).toEqual([ANCHORED_BLOB]);
  });

  it.each([
    [
      'the registry has no link for the circle',
      () => registryHolds(onChainLink({ circleId: OTHER_CIRCLE, blobId: 'not-this-circle' })),
    ],
    [
      'the circle only has a disabled link',
      () =>
        registryHolds(onChainLink({ circleId: CIRCLE, blobId: ANCHORED_BLOB, enabled: false })),
    ],
    ['no registry is configured', () => registriesMock.mockReturnValue([])],
  ])('rethrows rather than report "no link" when %s', async (_case, arrange) => {
    // Without the index there is no telling whether it holds a link the
    // registry scan cannot see, so no answer here is a confident "no".
    arrange();
    walrusStores({ [ANCHORED_BLOB]: individual(PHONE) });

    await expect(resolve()).rejects.toBe(INDEX_DOWN);
  });
});

describe('includeDisabled (unlink confirmations)', () => {
  it('reaches the newest disabled link once the unlink has removed the index rows', async () => {
    indexMock.mockResolvedValue([]);
    registryHolds(
      onChainLink({ circleId: CIRCLE, blobId: 'older-disabled', enabled: false }),
      onChainLink({ circleId: CIRCLE, blobId: ANCHORED_BLOB, enabled: false }),
    );
    walrusStores({
      'older-disabled': individual('+237600000009'),
      [ANCHORED_BLOB]: individual(PHONE),
    });

    await expect(resolve()).resolves.toBeNull();
    await expect(resolve({ includeDisabled: true })).resolves.toBe(PHONE);
    expect(fetchedBlobs()).toEqual([ANCHORED_BLOB]);
  });

  it('still reaches a disabled link with a live blob while the index is unreadable', async () => {
    indexMock.mockRejectedValue(INDEX_DOWN);
    registryHolds(onChainLink({ circleId: CIRCLE, blobId: ANCHORED_BLOB, enabled: false }));
    walrusStores({ [ANCHORED_BLOB]: individual(PHONE) });

    await expect(resolve({ includeDisabled: true })).resolves.toBe(PHONE);
  });

  it('rethrows the index error when the disabled link has expired too', async () => {
    indexMock.mockRejectedValue(INDEX_DOWN);
    registryHolds(onChainLink({ circleId: CIRCLE, blobId: ANCHORED_BLOB, enabled: false }));
    walrusStores({});

    await expect(resolve({ includeDisabled: true })).rejects.toBe(INDEX_DOWN);
    expect(fetchedBlobs()).toEqual([ANCHORED_BLOB]);
  });
});
