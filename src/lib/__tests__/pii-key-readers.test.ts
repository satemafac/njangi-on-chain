/**
 * What the WhatsApp phone lookups make of a v2 envelope whose data key is
 * gone or unreadable (src/lib/pii-key-errors.ts).
 *
 *   - Key deleted (the link was erased or unlinked): the blob holds no phone.
 *     The circle lookup returns null, so the cron skips the event and nothing
 *     is sent; the anchored blob opens no better, since every copy shares the
 *     key.
 *   - Key store unreadable: unknown, never "no link". The lookup rethrows so
 *     the cron halts and retries, the way it does for an unreachable Walrus
 *     aggregator.
 *
 * walrus-pii is mocked (fetchAndDecryptPII throws the real error classes);
 * the lookup logic is real.
 */

jest.mock('../walrus-pii', () => ({
  fetchAndDecryptPII: jest.fn(),
}));
jest.mock('../whatsapp-link-index', () => ({
  lookupBlobsForCircle: jest.fn(),
}));
jest.mock('../../services/whatsapp-registry-service', () => ({
  getActiveWhatsAppRegistries: jest.fn(() => [{ registryObjectId: '0xregistry' }]),
}));
jest.mock('../../utils/logger', () => ({
  appLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import type { SuiClient } from '@mysten/sui/client';
import { resolveCirclePhone } from '../whatsapp-bot/circle-phone';
import { fetchAndDecryptPII } from '../walrus-pii';
import { lookupBlobsForCircle } from '../whatsapp-link-index';
import { PiiKeyErasedError, PiiKeyReadError } from '../pii-key-errors';

const CIRCLE = `0x${'c3'.repeat(32)}`;
const KID = 'ab'.repeat(16);
const decryptMock = fetchAndDecryptPII as jest.Mock;
const indexMock = lookupBlobsForCircle as jest.Mock;
const getObject = jest.fn();
const client = { getObject } as unknown as SuiClient;

function registryHolds(enabled: boolean) {
  getObject.mockResolvedValue({
    data: {
      content: {
        dataType: 'moveObject',
        fields: {
          links: [
            {
              fields: {
                circle_id: CIRCLE,
                walrus_blob_id: Array.from(Buffer.from('anchored-blob', 'utf8')),
                enabled,
              },
            },
          ],
        },
      },
    },
  });
}

beforeEach(() => {
  decryptMock.mockReset();
  indexMock.mockReset().mockResolvedValue(['renewed-blob']);
  getObject.mockReset();
});

describe('resolveCirclePhone', () => {
  it('reads an erased link as no phone, through the index and the anchor alike', async () => {
    registryHolds(true);
    decryptMock.mockRejectedValue(new PiiKeyErasedError(KID));

    await expect(resolveCirclePhone(client, CIRCLE, 'testnet')).resolves.toBeNull();
    expect(decryptMock.mock.calls.map(([blob]) => blob)).toEqual(['renewed-blob', 'anchored-blob']);
  });

  it('gives the unlink confirmation nothing once the unlinked link\'s key is deleted', async () => {
    indexMock.mockResolvedValue([]);
    registryHolds(false);
    decryptMock.mockRejectedValue(new PiiKeyErasedError(KID));

    await expect(
      resolveCirclePhone(client, CIRCLE, 'testnet', { includeDisabled: true }),
    ).resolves.toBeNull();
  });

  it('halts on an unreadable key store instead of reading the circle as unlinked', async () => {
    registryHolds(true);
    const outage = new PiiKeyReadError('Could not read the data key: Connection terminated unexpectedly');
    decryptMock.mockRejectedValue(outage);

    await expect(resolveCirclePhone(client, CIRCLE, 'testnet')).rejects.toBe(outage);
  });

  it('keeps trying the next copy after a transient key read failure', async () => {
    registryHolds(true);
    decryptMock.mockImplementation(async (blobId: string) => {
      if (blobId === 'renewed-blob') throw new PiiKeyReadError('Could not read the data key: timeout');
      return {
        schema_version: 1,
        link_type: 'individual',
        phone_e164: '+447700900123',
        created_at: '2026-10-03T09:00:00.000Z',
      };
    });

    await expect(resolveCirclePhone(client, CIRCLE, 'testnet')).resolves.toBe('+447700900123');
  });
});
