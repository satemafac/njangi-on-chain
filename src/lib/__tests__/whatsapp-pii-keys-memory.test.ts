/**
 * src/lib/whatsapp-pii-keys.ts without DATABASE_URL: local development keeps
 * the data keys in memory, as whatsapp-link-index.ts keeps its rows, and
 * production refuses to (a key that lives in one lambda's memory is a link
 * that stops opening everywhere else). The Postgres path is covered by
 * whatsapp-pii-keys.test.ts.
 */

const mockAssertDatabaseUrl = jest.fn();

jest.mock('../pg-pool', () => ({
  isPostgresConfigured: () => false,
  assertDatabaseUrlInProduction: (context: string) => mockAssertDatabaseUrl(context),
  getSharedPgPool: () => {
    throw new Error('no pool without DATABASE_URL');
  },
}));

import { randomBytes } from 'crypto';
import {
  __resetWhatsAppPiiKeysForTests,
  createLinkDataKey,
  deleteLinkDataKey,
  deleteUnlinkedLinkKey,
  hasLiveLinkKeyInMemory,
  loadLinkDataKey,
  markCircleLinkKeysUnlinked,
  sweepUnlinkedLinkKeys,
} from '../whatsapp-pii-keys';
import { PiiKeyReadError } from '../pii-key-errors';

const CIRCLE = `0x${'c1'.repeat(32)}`;
const NONCE = 'aa'.repeat(32);
const savedKey = process.env.WALRUS_PII_MASTER_KEY;

beforeEach(() => {
  __resetWhatsAppPiiKeysForTests();
  mockAssertDatabaseUrl.mockReset();
  process.env.WALRUS_PII_MASTER_KEY = randomBytes(32).toString('hex');
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterAll(() => {
  if (savedKey === undefined) delete process.env.WALRUS_PII_MASTER_KEY;
  else process.env.WALRUS_PII_MASTER_KEY = savedKey;
});

it('keeps keys in memory, with the same unlink and delete behaviour', async () => {
  const created = await createLinkDataKey({ phoneHmac: 'h1', circleId: CIRCLE, linkNonceHex: NONCE });

  await expect(loadLinkDataKey(created.kid)).resolves.toEqual(created);
  expect(hasLiveLinkKeyInMemory('h1', CIRCLE)).toBe(true);
  await expect(markCircleLinkKeysUnlinked(CIRCLE)).resolves.toBe(1);
  expect(hasLiveLinkKeyInMemory('h1', CIRCLE)).toBe(false);
  // Still readable until deleted: the unlink confirmation needs it.
  await expect(loadLinkDataKey(created.kid)).resolves.toEqual(created);
  await expect(deleteUnlinkedLinkKey(CIRCLE, NONCE.toUpperCase())).resolves.toBe(1);
  await expect(loadLinkDataKey(created.kid)).resolves.toBeNull();
  expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Local development only'));
});

it('sweeps marked keys past the grace period and deletes single keys', async () => {
  const swept = await createLinkDataKey({ phoneHmac: 'h1', circleId: CIRCLE, linkNonceHex: NONCE });
  const single = await createLinkDataKey({ phoneHmac: 'h2', circleId: 'other', linkNonceHex: NONCE });
  await markCircleLinkKeysUnlinked(CIRCLE);

  await expect(sweepUnlinkedLinkKeys(48)).resolves.toBe(0);
  await expect(sweepUnlinkedLinkKeys(-1)).resolves.toBe(1);
  await expect(loadLinkDataKey(swept.kid)).resolves.toBeNull();

  await deleteLinkDataKey(single.kid);
  await expect(loadLinkDataKey(single.kid)).resolves.toBeNull();
});

it('refuses to keep keys in memory in production', async () => {
  mockAssertDatabaseUrl.mockImplementation(() => {
    throw new Error('[whatsapp-pii-keys] DATABASE_URL is required in production.');
  });

  await expect(
    createLinkDataKey({ phoneHmac: 'h1', circleId: CIRCLE, linkNonceHex: NONCE }),
  ).rejects.toThrow('DATABASE_URL is required in production');
  // A read in that state is a failure, never an erasure.
  await expect(loadLinkDataKey('ab'.repeat(16))).rejects.toBeInstanceOf(PiiKeyReadError);
  expect(mockAssertDatabaseUrl).toHaveBeenCalledWith('whatsapp-pii-keys');
});
