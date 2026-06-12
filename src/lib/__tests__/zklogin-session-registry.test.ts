/**
 * Tests for the durable zkLogin session registry (Vercel serverless
 * migration, June 2026): in-memory dev fallback, Postgres-backed
 * store/fetch/expire with encryption at rest, and the production
 * fail-fast guard.
 */

import type { ZkLoginSessionRecord } from '../zklogin-session-registry';

// Shared mocked pool: the factory closes over one query fn so every
// getSharedPgPool() call in the module under test hits the same mock.
jest.mock('../pg-pool', () => {
  const query = jest.fn();
  return {
    getSharedPgPool: () => ({ query }),
    isPostgresConfigured: () => Boolean(process.env.DATABASE_URL),
    assertDatabaseUrlInProduction: jest.fn(),
    resolvePgSsl: jest.fn(),
    __resetSharedPgPoolForTests: jest.fn(),
  };
});

import {
  getZkLoginSession,
  setZkLoginSession,
  deleteZkLoginSession,
  hasZkLoginSession,
  countZkLoginSessions,
  deleteZkLoginSessionsForUser,
  getZkLoginSessionAccount,
  getZkLoginSessionStore,
  encryptSessionRecord,
  decryptSessionRecord,
  __resetZkLoginSessionRegistryForTests,
} from '../zklogin-session-registry';
import { getSharedPgPool } from '../pg-pool';

const TEST_KEY_HEX = 'a'.repeat(64); // 32 bytes hex
const USER_ADDR = '0x' + 'a1'.repeat(32);
const OTHER_ADDR = '0x' + 'b2'.repeat(32);

function buildRecord(userAddr: string = USER_ADDR): ZkLoginSessionRecord {
  return {
    provider: 'Google',
    maxEpoch: 100,
    randomness: 'rand',
    ephemeralPrivateKey: 'super-secret-ephemeral-key',
    account: {
      provider: 'Google',
      userAddr,
      zkProofs: {
        proofPoints: { a: ['1'], b: [['2']], c: ['3'] },
        issBase64Details: { value: 'iss', indexMod4: 0 },
        headerBase64: 'header',
      },
      ephemeralPrivateKey: 'super-secret-ephemeral-key',
      userSalt: '42',
      sub: 'sub-123',
      aud: 'aud-456',
      maxEpoch: 100,
    },
  } as ZkLoginSessionRecord;
}

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env.DATABASE_URL = ORIGINAL_ENV.DATABASE_URL;
  process.env.ZKLOGIN_SESSION_ENC_KEY = ORIGINAL_ENV.ZKLOGIN_SESSION_ENC_KEY;
  if (!ORIGINAL_ENV.DATABASE_URL) delete process.env.DATABASE_URL;
  if (!ORIGINAL_ENV.ZKLOGIN_SESSION_ENC_KEY) delete process.env.ZKLOGIN_SESSION_ENC_KEY;
  __resetZkLoginSessionRegistryForTests();
  jest.restoreAllMocks();
});

describe('encryption at rest', () => {
  beforeEach(() => {
    process.env.ZKLOGIN_SESSION_ENC_KEY = TEST_KEY_HEX;
  });

  it('round-trips a session record', () => {
    const record = buildRecord();
    const envelope = encryptSessionRecord(record);
    expect(decryptSessionRecord(envelope)).toEqual(record);
  });

  it('does not leak plaintext key material in the envelope', () => {
    const envelope = encryptSessionRecord(buildRecord());
    const serialized = JSON.stringify(envelope);
    expect(serialized).not.toContain('super-secret-ephemeral-key');
    expect(serialized).not.toContain(USER_ADDR);
  });

  it('throws a clear error when the key is missing', () => {
    delete process.env.ZKLOGIN_SESSION_ENC_KEY;
    expect(() => encryptSessionRecord(buildRecord())).toThrow(/ZKLOGIN_SESSION_ENC_KEY/);
  });

  it('rejects keys that are not 32 bytes', () => {
    process.env.ZKLOGIN_SESSION_ENC_KEY = 'abcd';
    expect(() => encryptSessionRecord(buildRecord())).toThrow(/32 bytes/);
  });
});

describe('in-memory fallback (no DATABASE_URL)', () => {
  beforeEach(() => {
    delete process.env.DATABASE_URL;
    __resetZkLoginSessionRegistryForTests();
  });

  it('stores and fetches a session', async () => {
    await setZkLoginSession('sess-1', buildRecord());
    const fetched = await getZkLoginSession('sess-1');
    expect(fetched?.account?.userAddr).toBe(USER_ADDR);
    expect(await hasZkLoginSession('sess-1')).toBe(true);
    expect(await countZkLoginSessions()).toBe(1);
  });

  it('deletes a session', async () => {
    await setZkLoginSession('sess-1', buildRecord());
    await deleteZkLoginSession('sess-1');
    expect(await getZkLoginSession('sess-1')).toBeNull();
  });

  it('removes other sessions for the same user, keeping the current one', async () => {
    await setZkLoginSession('old-1', buildRecord(USER_ADDR));
    await setZkLoginSession('old-2', buildRecord(USER_ADDR));
    await setZkLoginSession('other-user', buildRecord(OTHER_ADDR));
    await setZkLoginSession('current', buildRecord(USER_ADDR));

    await deleteZkLoginSessionsForUser(USER_ADDR, 'current');

    expect(await getZkLoginSession('old-1')).toBeNull();
    expect(await getZkLoginSession('old-2')).toBeNull();
    expect((await getZkLoginSession('current'))?.account?.userAddr).toBe(USER_ADDR);
    expect((await getZkLoginSession('other-user'))?.account?.userAddr).toBe(OTHER_ADDR);
  });

  it('stays interoperable with the raw Map used by middleware tests', async () => {
    getZkLoginSessionStore().set('seeded', buildRecord());
    const account = await getZkLoginSessionAccount('seeded');
    expect(account?.userAddr).toBe(USER_ADDR);
  });

  it('returns null account for sessions without complete proof points', async () => {
    const record = buildRecord();
    delete record.account;
    await setZkLoginSession('incomplete', record);
    expect(await getZkLoginSessionAccount('incomplete')).toBeNull();
  });
});

describe('Postgres-backed store', () => {
  // Minimal fake of the zklogin_sessions table honoring expires_at.
  interface FakeRow {
    ciphertext: string;
    userAddress: string | null;
    expiresAtMs: number;
  }
  const table = new Map<string, FakeRow>();
  let queryMock: jest.Mock;

  beforeEach(() => {
    process.env.DATABASE_URL = 'postgres://unit:test@localhost:5432/fake';
    process.env.ZKLOGIN_SESSION_ENC_KEY = TEST_KEY_HEX;
    table.clear();
    __resetZkLoginSessionRegistryForTests();

    queryMock = (getSharedPgPool() as unknown as { query: jest.Mock }).query;
    queryMock.mockReset();
    queryMock.mockImplementation(async (sql: string, params?: unknown[]) => {
      const gc = () => {
        for (const [id, row] of table.entries()) {
          if (row.expiresAtMs <= Date.now()) table.delete(id);
        }
      };
      if (sql.includes('CREATE TABLE')) {
        return { rows: [] };
      }
      if (sql.includes('SELECT session_ciphertext')) {
        gc();
        const row = table.get(params?.[0] as string);
        return {
          rows:
            row && row.expiresAtMs > Date.now()
              ? [{ session_ciphertext: row.ciphertext }]
              : [],
        };
      }
      if (sql.includes('INSERT INTO zklogin_sessions')) {
        const [id, ciphertext, , , userAddress, , expiresAt] = params as [
          string, string, unknown, unknown, string | null, unknown, string,
        ];
        table.set(id, { ciphertext, userAddress, expiresAtMs: Date.parse(expiresAt) });
        return { rows: [] };
      }
      if (sql.includes('DELETE FROM zklogin_sessions WHERE id')) {
        table.delete(params?.[0] as string);
        return { rows: [] };
      }
      if (sql.includes('DELETE FROM zklogin_sessions WHERE user_address')) {
        const [userAddr, except] = params as [string, string];
        for (const [id, row] of table.entries()) {
          if (row.userAddress === userAddr && id !== except) table.delete(id);
        }
        return { rows: [] };
      }
      if (sql.includes('SELECT 1 FROM zklogin_sessions')) {
        const row = table.get(params?.[0] as string);
        return { rows: row && row.expiresAtMs > Date.now() ? [{ '?column?': 1 }] : [] };
      }
      if (sql.includes('COUNT(*)')) {
        gc();
        return { rows: [{ count: String(table.size) }] };
      }
      throw new Error(`Unexpected SQL in test: ${sql}`);
    });
  });

  it('stores encrypted sessions and fetches them back', async () => {
    await setZkLoginSession('sess-pg', buildRecord());

    // The persisted ciphertext must not contain plaintext secrets.
    const stored = table.get('sess-pg');
    expect(stored).toBeDefined();
    expect(stored!.ciphertext).not.toContain('super-secret-ephemeral-key');
    expect(stored!.userAddress).toBe(USER_ADDR);

    const fetched = await getZkLoginSession('sess-pg');
    expect(fetched?.ephemeralPrivateKey).toBe('super-secret-ephemeral-key');
    expect(fetched?.account?.userAddr).toBe(USER_ADDR);
    expect(await hasZkLoginSession('sess-pg')).toBe(true);
    expect(await countZkLoginSessions()).toBe(1);
  });

  it('expires sessions past their TTL (cleanup on read)', async () => {
    const t0 = Date.now();
    await setZkLoginSession('sess-ttl', buildRecord());
    expect(await getZkLoginSession('sess-ttl')).not.toBeNull();

    // Jump past the 24h cookie-aligned TTL.
    jest.spyOn(Date, 'now').mockReturnValue(t0 + 25 * 60 * 60 * 1000);

    expect(await getZkLoginSession('sess-ttl')).toBeNull();
    // The expired row was garbage-collected by the read.
    expect(table.has('sess-ttl')).toBe(false);
  });

  it('deletes other sessions for a user via SQL, not a Map scan', async () => {
    await setZkLoginSession('a', buildRecord(USER_ADDR));
    await setZkLoginSession('b', buildRecord(USER_ADDR));
    await setZkLoginSession('keep', buildRecord(USER_ADDR));

    await deleteZkLoginSessionsForUser(USER_ADDR, 'keep');

    expect(await getZkLoginSession('a')).toBeNull();
    expect(await getZkLoginSession('b')).toBeNull();
    expect(await getZkLoginSession('keep')).not.toBeNull();
  });

  it('resolves the authenticated account through the durable store', async () => {
    await setZkLoginSession('sess-acct', buildRecord());
    const account = await getZkLoginSessionAccount('sess-acct');
    expect(account?.userAddr).toBe(USER_ADDR);
    expect(await getZkLoginSessionAccount('missing')).toBeNull();
  });
});

describe('production fail-fast', () => {
  it('refuses in-memory sessions when NODE_ENV=production without DATABASE_URL', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    delete process.env.DATABASE_URL;
    (process.env as Record<string, string>).NODE_ENV = 'production';
    try {
      await expect(getZkLoginSession('any')).rejects.toThrow(/DATABASE_URL is required/);
    } finally {
      (process.env as Record<string, string>).NODE_ENV = originalNodeEnv ?? 'test';
    }
  });
});
