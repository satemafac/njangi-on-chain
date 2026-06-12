/**
 * Tests for the atomic dedupe claim in sendMemberNotification (June 2026
 * cron-overlap fix). The old flow was check-then-act — SELECT recent
 * success, send, then upsert the audit row — so two overlapping cron runs
 * both passed the check and double-sent before either recorded. The fixed
 * flow CLAIMS the `(kind, target, dedupe_key)` row with a single
 * INSERT … ON CONFLICT DO UPDATE … WHERE before sending; only the claim
 * winner sends.
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
  lookupCirclesForPhone: jest.fn(async () => []),
}));
jest.mock('../../services/whatsapp-registry-service', () => ({
  getActiveWhatsAppRegistries: jest.fn(() => []),
}));
jest.mock('../../services/network-config', () => ({
  getNetworkConfig: jest.fn(() => ({ rpcUrl: 'http://localhost:9000' })),
}));
jest.mock('../../services/sui-rpc-failover', () => ({
  getPooledSuiClient: jest.fn(),
}));

import {
  sendMemberNotification,
  __resetWhatsAppNotifierForTests,
} from '../whatsapp-notifier';
import { getSharedPgPool } from '../pg-pool';

const ORIGINAL_ENV = {
  DATABASE_URL: process.env.DATABASE_URL,
  WHATSAPP_PHONE_NUMBER_ID: process.env.WHATSAPP_PHONE_NUMBER_ID,
  WHATSAPP_ACCESS_TOKEN: process.env.WHATSAPP_ACCESS_TOKEN,
};
const ORIGINAL_FETCH = global.fetch;

function getQueryMock(): jest.Mock {
  return (getSharedPgPool() as unknown as { query: jest.Mock }).query;
}

function isClaimSql(sql: string): boolean {
  // The claim is the only statement that RETURNs from the audit table.
  return sql.includes('INSERT INTO whatsapp_notifications') && sql.includes('RETURNING');
}

function isRecordSql(sql: string): boolean {
  return sql.includes('INSERT INTO whatsapp_notifications') && !sql.includes('RETURNING');
}

let fetchMock: jest.Mock;
let ops: string[];

beforeEach(() => {
  process.env.DATABASE_URL = 'postgres://unit:test@localhost:5432/fake';
  process.env.WHATSAPP_PHONE_NUMBER_ID = 'phone-id';
  process.env.WHATSAPP_ACCESS_TOKEN = 'token';
  __resetWhatsAppNotifierForTests();
  getQueryMock().mockReset();
  ops = [];
  fetchMock = jest.fn(async () => {
    ops.push('send');
    return { ok: true, text: async () => '' };
  });
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterAll(() => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  global.fetch = ORIGINAL_FETCH;
});

const baseInput = {
  memberAddress: '0xRecipient',
  body: 'It is your turn!',
  kind: 'cycle_finalized' as const,
  network: 'testnet' as const,
  dedupeKey: '0xcircle:4',
  phoneOverride: '+237600000000',
};

describe('atomic claim-before-send', () => {
  it('claims the dedupe row BEFORE sending, then finalizes it with the outcome', async () => {
    const queryMock = getQueryMock();
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('CREATE TABLE')) return { rows: [], rowCount: 0 };
      if (isClaimSql(sql)) {
        ops.push('claim');
        return { rows: [{ id: '1' }], rowCount: 1 };
      }
      if (isRecordSql(sql)) {
        ops.push('record');
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL in test: ${sql}`);
    });

    const result = await sendMemberNotification(baseInput);

    expect(result).toEqual({ sent: true, phoneE164: '+237600000000' });
    // The claim must precede the WhatsApp call — inserting the row after
    // the send is exactly the race the audit flagged.
    expect(ops).toEqual(['claim', 'send', 'record']);

    const claimCall = queryMock.mock.calls.find(([sql]) => isClaimSql(sql as string));
    const [claimSql, claimParams] = claimCall as [string, unknown[]];
    // One atomic check-and-set: conditional upsert, no separate SELECT.
    expect(claimSql).toContain('ON CONFLICT (kind, target_address, dedupe_key) DO UPDATE');
    expect(claimSql).toContain('WHERE');
    expect(claimParams).toContain('in_flight');
    // No standalone SELECT-based dedupe probe anywhere in the flow.
    const selectProbe = queryMock.mock.calls.find(([sql]) =>
      (sql as string).trimStart().startsWith('SELECT id FROM whatsapp_notifications'),
    );
    expect(selectProbe).toBeUndefined();

    const recordCall = queryMock.mock.calls.find(([sql]) => isRecordSql(sql as string));
    const [, recordParams] = recordCall as [string, unknown[]];
    expect(recordParams).toEqual([
      'cycle_finalized',
      '0xrecipient',
      '0xcircle:4',
      true,
      null,
    ]);
  });

  it('returns duplicate WITHOUT sending when the claim loses', async () => {
    getQueryMock().mockImplementation(async (sql: string) => {
      if (sql.includes('CREATE TABLE')) return { rows: [], rowCount: 0 };
      if (isClaimSql(sql)) return { rows: [], rowCount: 0 }; // lost the race
      throw new Error(`Unexpected SQL in test: ${sql}`);
    });

    const result = await sendMemberNotification(baseInput);

    expect(result).toEqual({ sent: false, reason: 'duplicate' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('two concurrent sends for the same tuple resolve to exactly one WhatsApp call', async () => {
    // Simulate the DB's row-level serialization: first claim for a tuple
    // wins, every later claim sees the in-flight row and loses.
    const claimed = new Set<string>();
    getQueryMock().mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('CREATE TABLE')) return { rows: [], rowCount: 0 };
      if (isClaimSql(sql)) {
        const tuple = (params as string[]).slice(0, 3).join('|');
        if (claimed.has(tuple)) return { rows: [], rowCount: 0 };
        claimed.add(tuple);
        return { rows: [{ id: '1' }], rowCount: 1 };
      }
      if (isRecordSql(sql)) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected SQL in test: ${sql}`);
    });

    const [a, b] = await Promise.all([
      sendMemberNotification(baseInput),
      sendMemberNotification(baseInput),
    ]);

    const sent = [a, b].filter((r) => r.sent);
    const duplicates = [a, b].filter((r) => r.reason === 'duplicate');
    expect(sent).toHaveLength(1);
    expect(duplicates).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails open when the claim query errors (historic best-effort contract)', async () => {
    getQueryMock().mockImplementation(async (sql: string) => {
      if (sql.includes('CREATE TABLE')) return { rows: [], rowCount: 0 };
      if (isClaimSql(sql)) throw new Error('postgres is down');
      if (isRecordSql(sql)) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected SQL in test: ${sql}`);
    });

    const result = await sendMemberNotification(baseInput);

    expect(result.sent).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('skips the claim entirely in dev without DATABASE_URL', async () => {
    delete process.env.DATABASE_URL;
    __resetWhatsAppNotifierForTests();

    const result = await sendMemberNotification(baseInput);

    expect(result.sent).toBe(true);
    expect(getQueryMock()).not.toHaveBeenCalled();
  });
});
