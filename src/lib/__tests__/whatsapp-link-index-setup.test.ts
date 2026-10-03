/**
 * whatsapp-link-index creates its table lazily, once per instance. A
 * failed setup query used to stay latched: every later index read in that
 * (reused) instance rejected with the same error without reaching
 * Postgres, so a caller that halts and retries on an index error — the
 * whatsapp-circle-events cron, through resolveCirclePhone — kept halting
 * until the instance was recycled.
 */

jest.mock('../pg-pool', () => {
  const query = jest.fn();
  return {
    getSharedPgPool: () => ({ query }),
    isPostgresConfigured: () => true,
  };
});
jest.mock('../walrus-pii', () => ({
  computeLookupHash: jest.fn(),
}));

import { getSharedPgPool } from '../pg-pool';
import {
  lookupBlobsForCircle,
  __resetWhatsAppLinkIndexForTests,
} from '../whatsapp-link-index';

const CIRCLE = `0x${'c3'.repeat(32)}`;
const query = (getSharedPgPool() as unknown as { query: jest.Mock }).query;

/** Postgres stand-in; `setupFailures` setup queries reject before one lands. */
function postgres(setupFailures: number) {
  const state = { setupAttempts: 0 };
  query.mockImplementation(async (sql: string) => {
    if (sql.includes('CREATE TABLE IF NOT EXISTS whatsapp_phone_index')) {
      state.setupAttempts += 1;
      if (state.setupAttempts <= setupFailures) {
        throw new Error('Connection terminated unexpectedly');
      }
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes('SELECT walrus_blob_id FROM whatsapp_phone_index')) {
      return { rows: [{ walrus_blob_id: 'renewed-blob' }], rowCount: 1 };
    }
    throw new Error(`Unexpected SQL in test: ${sql}`);
  });
  return state;
}

beforeEach(() => {
  __resetWhatsAppLinkIndexForTests();
  query.mockReset();
});

it('retries the table setup on the next read after it fails', async () => {
  const db = postgres(1);

  await expect(lookupBlobsForCircle(CIRCLE)).rejects.toThrow(
    'Connection terminated unexpectedly',
  );
  await expect(lookupBlobsForCircle(CIRCLE)).resolves.toEqual(['renewed-blob']);
  expect(db.setupAttempts).toBe(2);
});

it('runs the setup once per instance after it succeeds', async () => {
  const db = postgres(0);

  await lookupBlobsForCircle(CIRCLE);
  await lookupBlobsForCircle(CIRCLE);
  expect(db.setupAttempts).toBe(1);
});
