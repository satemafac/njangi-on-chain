/**
 * Member-addressed phone lookup (resolveMemberPhone, exercised through
 * sendMemberNotification). /api/cron/walrus-renewal re-stores each PII blob
 * before its Walrus lease ends and records the new blob id ONLY in the
 * Postgres index; the on-chain anchor keeps the original. The lookup used
 * to decrypt the anchored blob, so once that lease lapsed the "your turn"
 * nudge, the stale-attestation reminders and ramp KYC confirmations sent
 * without a phoneOverride were all recorded as `no_link`. It now takes the
 * circle's current blob from the index and uses the anchored blob only when
 * the index has no row for the circle. A transient Walrus read failure
 * (aggregator unreachable, 5xx, 429) was recorded as `no_link` too; it now
 * throws once no other blob answers, with the claim settled as
 * `lookup_failed: …`, so the cycle-finalized drain halts and the next run
 * sends.
 */

jest.mock('../pg-pool', () => {
  const query = jest.fn();
  return {
    getSharedPgPool: () => ({ query }),
    isPostgresConfigured: () => Boolean(process.env.DATABASE_URL),
  };
});
jest.mock('../walrus-pii', () => ({
  computeLookupHash: jest.fn(),
  fetchAndDecryptPII: jest.fn(),
}));
jest.mock('../whatsapp-link-index', () => ({
  lookupBlobsForCircle: jest.fn(),
  lookupCirclesForPhone: jest.fn(),
}));
jest.mock('../../services/whatsapp-registry-service', () => ({
  getActiveWhatsAppRegistries: () => [{ packageId: '0xwa', registryObjectId: '0xregistry' }],
}));
jest.mock('../../services/network-config', () => ({
  getNetworkConfig: () => ({ rpcUrl: 'http://localhost:9000' }),
}));
jest.mock('../../services/sui-rpc-failover', () => ({
  getPooledSuiClient: jest.fn(),
}));
jest.mock('../../utils/logger', () => ({
  appLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  sendMemberNotification,
  __resetWhatsAppNotifierForTests,
} from '../whatsapp-notifier';
import { drainCycleFinalizedEvents } from '../cycle-finalized-cron';
import { getSharedPgPool } from '../pg-pool';
import { fetchAndDecryptPII } from '../walrus-pii';
import type { WhatsAppPiiPayload } from '../walrus-pii';
import { WalrusReadError } from '../walrus-read-error';
import { lookupBlobsForCircle } from '../whatsapp-link-index';
import { getPooledSuiClient } from '../../services/sui-rpc-failover';
import { appLogger } from '../../utils/logger';

const MEMBER = `0x${'a1'.repeat(32)}`;
const OTHER_MEMBER = `0x${'b2'.repeat(32)}`;
const CIRCLE = `0x${'c3'.repeat(32)}`;
const OTHER_CIRCLE = `0x${'d4'.repeat(32)}`;
const ANCHORED_BLOB = 'anchored-blob-original-lease';
const RENEWED_BLOB = 'renewed-blob-from-renewal-cron';
const PHONE = '+237600000001';

const ORIGINAL_ENV = {
  DATABASE_URL: process.env.DATABASE_URL,
  WHATSAPP_PHONE_NUMBER_ID: process.env.WHATSAPP_PHONE_NUMBER_ID,
  WHATSAPP_ACCESS_TOKEN: process.env.WHATSAPP_ACCESS_TOKEN,
};
const ORIGINAL_FETCH = global.fetch;

const decryptMock = fetchAndDecryptPII as jest.MockedFunction<typeof fetchAndDecryptPII>;
const indexMock = lookupBlobsForCircle as jest.MockedFunction<typeof lookupBlobsForCircle>;
const getObject = jest.fn();
let fetchMock: jest.Mock;

const input = {
  memberAddress: MEMBER,
  body: "It's your turn!",
  kind: 'cycle_finalized' as const,
  network: 'testnet' as const,
  dedupeKey: '0xescrow:4',
};

/** A WhatsAppLink as Sui JSON-RPC renders it (vector<u8> → number[]). */
function onChainLink(opts: {
  circleId: string;
  linkedBy: string;
  blobId: string;
  enabled?: boolean;
}) {
  return {
    type: '0xwa::whatsapp_integration::WhatsAppLink',
    fields: {
      circle_id: opts.circleId,
      link_type: 1,
      walrus_blob_id: Array.from(Buffer.from(opts.blobId, 'utf8')),
      linked_by: opts.linkedBy,
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
    if (!stored) {
      throw new WalrusReadError(`Walrus aggregator returned 404: ${blobId} not found`, {
        status: 404,
        transient: false,
      });
    }
    return stored;
  });
}

/** A read a retry may fix: a 5xx or 429 answer, or no answer (status null). */
function unavailable(status: number | null): WalrusReadError {
  return new WalrusReadError(
    status === null
      ? 'Walrus aggregator unreachable: fetch failed'
      : `Walrus aggregator returned ${status}: try again later`,
    { status, transient: true },
  );
}

/**
 * Turns Postgres on for the dispatcher, backed by a fake that grants every
 * dedupe claim. Returns the audit rows the dispatcher settles, in order.
 */
function fakeAuditLog(): unknown[][] {
  process.env.DATABASE_URL = 'postgres://unit:test@localhost:5432/fake';
  const records: unknown[][] = [];
  const query = (getSharedPgPool() as unknown as { query: jest.Mock }).query;
  query.mockReset();
  query.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (sql.includes('CREATE TABLE')) return { rows: [], rowCount: 0 };
    if (sql.includes('INSERT INTO whatsapp_notifications') && sql.includes('RETURNING')) {
      return { rows: [{ id: '1' }], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO whatsapp_notifications')) {
      records.push(params ?? []);
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected SQL in test: ${sql}`);
  });
  return records;
}

/** E.164 numbers the Graph API was asked to message, in send order. */
function sentTo(): string[] {
  return fetchMock.mock.calls.map(
    ([, init]) => JSON.parse((init as { body: string }).body).to as string,
  );
}

beforeEach(() => {
  delete process.env.DATABASE_URL;
  process.env.WHATSAPP_PHONE_NUMBER_ID = 'phone-id';
  process.env.WHATSAPP_ACCESS_TOKEN = 'token';
  __resetWhatsAppNotifierForTests();
  getObject.mockReset();
  decryptMock.mockReset();
  indexMock.mockReset();
  (getPooledSuiClient as jest.Mock).mockReturnValue({ getObject });
  fetchMock = jest.fn(async () => ({ ok: true, text: async () => '' }));
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterAll(() => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  global.fetch = ORIGINAL_FETCH;
});

describe('member phone lookup after a Walrus renewal', () => {
  it('decrypts the renewed blob from the index, not the expired anchored one', async () => {
    registryHolds(onChainLink({ circleId: CIRCLE, linkedBy: MEMBER, blobId: ANCHORED_BLOB }));
    indexMock.mockResolvedValue([RENEWED_BLOB]);
    walrusStores({ [RENEWED_BLOB]: individual(PHONE) });

    const result = await sendMemberNotification(input);

    expect(result).toEqual({ sent: true, phoneE164: PHONE });
    expect(indexMock).toHaveBeenCalledWith(CIRCLE);
    expect(decryptMock.mock.calls.map(([blobId]) => blobId)).toEqual([RENEWED_BLOB]);
    expect(sentTo()).toEqual([PHONE]);
  });

  it('falls back to the anchored blob when the index has no row for the circle', async () => {
    registryHolds(onChainLink({ circleId: CIRCLE, linkedBy: MEMBER, blobId: ANCHORED_BLOB }));
    indexMock.mockResolvedValue([]);
    walrusStores({ [ANCHORED_BLOB]: individual(PHONE) });

    const result = await sendMemberNotification(input);

    expect(result).toEqual({ sent: true, phoneE164: PHONE });
    // Decoded from the vector<u8> byte array the registry returns.
    expect(decryptMock.mock.calls.map(([blobId]) => blobId)).toEqual([ANCHORED_BLOB]);
    expect(sentTo()).toEqual([PHONE]);
  });

  it('resolves each of the member links through its own circle', async () => {
    // A group link stores a group id, not a phone, so the lookup moves on
    // to the member's next link (group delivery is a separate gap).
    registryHolds(
      onChainLink({ circleId: OTHER_CIRCLE, linkedBy: MEMBER, blobId: 'group-anchor' }),
      onChainLink({ circleId: CIRCLE, linkedBy: MEMBER, blobId: ANCHORED_BLOB }),
    );
    indexMock.mockImplementation(async (circleId: string) =>
      circleId === OTHER_CIRCLE ? ['group-renewed'] : [RENEWED_BLOB],
    );
    walrusStores({
      'group-renewed': {
        schema_version: 1,
        link_type: 'group',
        group_id: '120363000000000000@g.us',
        created_at: '2026-06-01T00:00:00.000Z',
      },
      [RENEWED_BLOB]: individual(PHONE),
    });

    const result = await sendMemberNotification(input);

    expect(result).toEqual({ sent: true, phoneE164: PHONE });
    expect(indexMock.mock.calls.map(([circleId]) => circleId)).toEqual([OTHER_CIRCLE, CIRCLE]);
    expect(sentTo()).toEqual([PHONE]);
  });

  it('skips links made by other members and disabled links without reading the index', async () => {
    registryHolds(
      onChainLink({ circleId: OTHER_CIRCLE, linkedBy: OTHER_MEMBER, blobId: 'not-theirs' }),
      onChainLink({ circleId: CIRCLE, linkedBy: MEMBER, blobId: ANCHORED_BLOB, enabled: false }),
    );

    const result = await sendMemberNotification(input);

    expect(result).toEqual({ sent: false, reason: 'no_link' });
    expect(indexMock).not.toHaveBeenCalled();
    expect(decryptMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('warns and skips an indexed blob that fails to decrypt, without retrying the anchor', async () => {
    registryHolds(onChainLink({ circleId: CIRCLE, linkedBy: MEMBER, blobId: ANCHORED_BLOB }));
    indexMock.mockResolvedValue([RENEWED_BLOB]);
    walrusStores({
      [RENEWED_BLOB]: new Error('Unsupported state or unable to authenticate data'),
      [ANCHORED_BLOB]: individual(PHONE),
    });

    const result = await sendMemberNotification(input);

    expect(result).toEqual({ sent: false, reason: 'no_link' });
    expect(decryptMock.mock.calls.map(([blobId]) => blobId)).toEqual([RENEWED_BLOB]);
    expect(appLogger.warn).toHaveBeenCalledWith(
      '[whatsapp-notifier] failed to decrypt PII envelope',
      expect.objectContaining({ memberAddress: MEMBER }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('throw contract', () => {
  it('propagates a registry read failure so the cron halts without advancing', async () => {
    getObject.mockRejectedValue(new Error('all RPC candidates failed'));

    await expect(sendMemberNotification(input)).rejects.toThrow('all RPC candidates failed');
    expect(indexMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still sends through the anchored blob while the index is unreadable', async () => {
    registryHolds(onChainLink({ circleId: CIRCLE, linkedBy: MEMBER, blobId: ANCHORED_BLOB }));
    indexMock.mockRejectedValue(new Error('Connection terminated unexpectedly'));
    walrusStores({ [ANCHORED_BLOB]: individual(PHONE) });

    const result = await sendMemberNotification(input);

    expect(result).toEqual({ sent: true, phoneE164: PHONE });
    expect(sentTo()).toEqual([PHONE]);
  });

  it('throws instead of recording no_link when the index is unreadable and the anchor expired', async () => {
    const records = fakeAuditLog();
    registryHolds(onChainLink({ circleId: CIRCLE, linkedBy: MEMBER, blobId: ANCHORED_BLOB }));
    indexMock.mockRejectedValue(new Error('Connection terminated unexpectedly'));
    walrusStores({});

    await expect(sendMemberNotification(input)).rejects.toThrow(
      'Connection terminated unexpectedly',
    );
    // The claim is settled as a lookup failure (reclaimable on retry),
    // never as a no_link that would let the cron advance past the event.
    expect(records).toEqual([
      [
        'cycle_finalized',
        MEMBER,
        '0xescrow:4',
        false,
        'lookup_failed: Connection terminated unexpectedly',
      ],
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('Walrus read failures', () => {
  const fetchedBlobs = () => decryptMock.mock.calls.map(([blobId]) => blobId);

  it('records no_link after a warning when every copy of the blob is gone (404)', async () => {
    registryHolds(onChainLink({ circleId: CIRCLE, linkedBy: MEMBER, blobId: ANCHORED_BLOB }));
    indexMock.mockResolvedValue([RENEWED_BLOB]);
    walrusStores({});

    const result = await sendMemberNotification(input);

    expect(result).toEqual({ sent: false, reason: 'no_link' });
    expect(appLogger.warn).toHaveBeenCalledWith(
      '[whatsapp-notifier] failed to decrypt PII envelope',
      expect.objectContaining({ memberAddress: MEMBER, transient: false }),
    );
    // A blob that is gone for good does not send the lookup back to the anchor.
    expect(fetchedBlobs()).toEqual([RENEWED_BLOB]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([503, 429, null])(
    'throws a transient failure (%p) and settles the claim as lookup_failed, not no_link',
    async (status) => {
      const records = fakeAuditLog();
      const outage = unavailable(status);
      registryHolds(onChainLink({ circleId: CIRCLE, linkedBy: MEMBER, blobId: ANCHORED_BLOB }));
      indexMock.mockResolvedValue([RENEWED_BLOB]);
      walrusStores({ [RENEWED_BLOB]: outage });

      await expect(sendMemberNotification(input)).rejects.toBe(outage);
      // The anchored blob was tried before giving up (its lease has lapsed).
      expect(fetchedBlobs()).toEqual([RENEWED_BLOB, ANCHORED_BLOB]);
      expect(records).toEqual([
        ['cycle_finalized', MEMBER, '0xescrow:4', false, `lookup_failed: ${outage.message}`],
      ]);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('sends through the anchored blob while Walrus cannot serve the renewed copy', async () => {
    registryHolds(onChainLink({ circleId: CIRCLE, linkedBy: MEMBER, blobId: ANCHORED_BLOB }));
    indexMock.mockResolvedValue([RENEWED_BLOB]);
    walrusStores({ [RENEWED_BLOB]: unavailable(503), [ANCHORED_BLOB]: individual(PHONE) });

    const result = await sendMemberNotification(input);

    expect(result).toEqual({ sent: true, phoneE164: PHONE });
    expect(sentTo()).toEqual([PHONE]);
  });

  it("sends through the member's other link while one link's blob cannot be read", async () => {
    registryHolds(
      onChainLink({ circleId: OTHER_CIRCLE, linkedBy: MEMBER, blobId: 'other-anchor' }),
      onChainLink({ circleId: CIRCLE, linkedBy: MEMBER, blobId: ANCHORED_BLOB }),
    );
    indexMock.mockImplementation(async (circleId: string) =>
      circleId === OTHER_CIRCLE ? ['other-renewed'] : [RENEWED_BLOB],
    );
    walrusStores({ 'other-renewed': unavailable(503), [RENEWED_BLOB]: individual(PHONE) });

    const result = await sendMemberNotification(input);

    expect(result).toEqual({ sent: true, phoneE164: PHONE });
    expect(sentTo()).toEqual([PHONE]);
  });

  it('reads a blob once when the index still holds the anchored id', async () => {
    // Until its first renewal a link's index row names the anchored blob.
    const outage = unavailable(503);
    registryHolds(onChainLink({ circleId: CIRCLE, linkedBy: MEMBER, blobId: ANCHORED_BLOB }));
    indexMock.mockResolvedValue([ANCHORED_BLOB]);
    walrusStores({ [ANCHORED_BLOB]: outage });

    await expect(sendMemberNotification(input)).rejects.toBe(outage);
    expect(fetchedBlobs()).toEqual([ANCHORED_BLOB]);
  });

  it('throws the first failure, the index read, when the anchored blob cannot be read either', async () => {
    registryHolds(onChainLink({ circleId: CIRCLE, linkedBy: MEMBER, blobId: ANCHORED_BLOB }));
    indexMock.mockRejectedValue(new Error('Connection terminated unexpectedly'));
    walrusStores({ [ANCHORED_BLOB]: unavailable(503) });

    await expect(sendMemberNotification(input)).rejects.toThrow(
      'Connection terminated unexpectedly',
    );
  });
});

describe('the cycle-finalized drain during a Walrus outage', () => {
  // The drain /api/cron/cycle-finalized runs, with a notify step that sends
  // the way the route does: a thrown lookup halts the drain.
  const EVENT = { id: { txDigest: 'tx-pot-full', eventSeq: '0' }, parsedJson: {}, timestampMs: null };

  function drain(persistCursor: jest.Mock) {
    return drainCycleFinalizedEvents(null, {
      queryPage: async () => ({ data: [EVENT], nextCursor: EVENT.id, hasNextPage: false }),
      notify: async () => ((await sendMemberNotification(input)).sent ? 'sent' : 'skipped'),
      persistCursor,
    });
  }

  it('halts without advancing, then sends on the next run once Walrus answers', async () => {
    const records = fakeAuditLog();
    const outage = unavailable(503);
    registryHolds(onChainLink({ circleId: CIRCLE, linkedBy: MEMBER, blobId: ANCHORED_BLOB }));
    indexMock.mockResolvedValue([RENEWED_BLOB]);
    walrusStores({ [RENEWED_BLOB]: outage });
    const persistCursor = jest.fn(async () => undefined);

    const down = await drain(persistCursor);

    expect(down).toMatchObject({ halted: true, processed: 0, sent: 0 });
    expect(persistCursor).not.toHaveBeenCalled();
    expect(records).toEqual([
      ['cycle_finalized', MEMBER, '0xescrow:4', false, `lookup_failed: ${outage.message}`],
    ]);
    expect(fetchMock).not.toHaveBeenCalled();

    walrusStores({ [RENEWED_BLOB]: individual(PHONE) });
    const recovered = await drain(persistCursor);

    expect(recovered).toMatchObject({ halted: false, processed: 1, sent: 1 });
    expect(persistCursor).toHaveBeenCalledWith(EVENT.id);
    expect(sentTo()).toEqual([PHONE]);
  });
});
