/**
 * Tests for the cycle-finalized run lease (June 2026 cron-overlap fix).
 * Vercel does not prevent concurrent cron executions, so the cursor row
 * doubles as a lease: acquire is a single atomic
 * INSERT … ON CONFLICT DO UPDATE … WHERE (no read-then-write window), and
 * cursor saves are FENCED by the lease token so a zombie run can never
 * regress the cursor a newer run already advanced.
 */

jest.mock('../pg-pool', () => {
  const query = jest.fn();
  return {
    getSharedPgPool: () => ({ query }),
    isPostgresConfigured: () => true,
  };
});

import {
  acquireCycleFinalizedLease,
  releaseCycleFinalizedLease,
  saveCycleFinalizedCursor,
  CycleFinalizedLeaseLostError,
  CYCLE_FINALIZED_LEASE_TTL_MS,
  __resetCycleFinalizedCronForTests,
} from '../cycle-finalized-cron';
import { getSharedPgPool } from '../pg-pool';

function getQueryMock(): jest.Mock {
  return (getSharedPgPool() as unknown as { query: jest.Mock }).query;
}

function isDdl(sql: string): boolean {
  return sql.includes('CREATE TABLE');
}

beforeEach(() => {
  __resetCycleFinalizedCronForTests();
  getQueryMock().mockReset();
});

describe('acquireCycleFinalizedLease', () => {
  it('returns a fencing token when the atomic claim wins', async () => {
    const queryMock = getQueryMock();
    queryMock.mockImplementation(async (sql: string) => {
      if (isDdl(sql)) return { rows: [], rowCount: 0 };
      if (sql.includes('INSERT INTO cycle_finalized_cursor')) {
        return { rows: [{ key: '0xpkg:testnet' }], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL in test: ${sql}`);
    });

    const token = await acquireCycleFinalizedLease('0xpkg:testnet');
    expect(token).toEqual(expect.any(String));

    const claimCall = queryMock.mock.calls.find(([sql]) =>
      (sql as string).includes('INSERT INTO cycle_finalized_cursor'),
    );
    expect(claimCall).toBeDefined();
    const [claimSql, claimParams] = claimCall as [string, unknown[]];
    // The claim must be one atomic check-and-set statement: upsert guarded
    // on lease expiry, returning a row only to the winner.
    expect(claimSql).toContain('ON CONFLICT (key) DO UPDATE');
    expect(claimSql).toContain('locked_until');
    expect(claimSql).toContain('RETURNING');
    expect(claimParams).toEqual([
      '0xpkg:testnet',
      CYCLE_FINALIZED_LEASE_TTL_MS,
      token,
    ]);
  });

  it('returns null when another run holds an unexpired lease', async () => {
    getQueryMock().mockImplementation(async (sql: string) => {
      if (isDdl(sql)) return { rows: [], rowCount: 0 };
      // ON CONFLICT … WHERE filtered the update out: no row returned.
      return { rows: [], rowCount: 0 };
    });

    await expect(acquireCycleFinalizedLease('0xpkg:testnet')).resolves.toBeNull();
  });

  it('keeps the lease TTL above the route maxDuration (60s in vercel.json)', () => {
    expect(CYCLE_FINALIZED_LEASE_TTL_MS).toBeGreaterThan(60_000);
  });
});

describe('releaseCycleFinalizedLease', () => {
  it('only releases when this run still owns the lease (token-guarded)', async () => {
    const queryMock = getQueryMock();
    queryMock.mockImplementation(async (sql: string) => {
      if (isDdl(sql)) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 1 };
    });

    await releaseCycleFinalizedLease('0xpkg:testnet', 'token-abc');

    const releaseCall = queryMock.mock.calls.find(([sql]) =>
      (sql as string).includes('locked_until = NULL'),
    );
    expect(releaseCall).toBeDefined();
    const [releaseSql, releaseParams] = releaseCall as [string, unknown[]];
    expect(releaseSql).toContain('locked_by = $2');
    expect(releaseParams).toEqual(['0xpkg:testnet', 'token-abc']);
  });
});

describe('saveCycleFinalizedCursor (fenced)', () => {
  const cursor = { txDigest: 'digest-9', eventSeq: '0' };

  it('persists via a token-fenced UPDATE — never an unconditional upsert', async () => {
    const queryMock = getQueryMock();
    queryMock.mockImplementation(async (sql: string) => {
      if (isDdl(sql)) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 1 };
    });

    await saveCycleFinalizedCursor('0xpkg:testnet', cursor, 'token-abc');

    const saveCall = queryMock.mock.calls.find(([sql]) =>
      (sql as string).includes('SET cursor ='),
    );
    expect(saveCall).toBeDefined();
    const [saveSql, saveParams] = saveCall as [string, unknown[]];
    // Last-write-wins upserts let a slow overlapping run regress the
    // cursor; the fenced UPDATE only lands while we hold the lease.
    expect(saveSql).not.toContain('ON CONFLICT');
    expect(saveSql).toContain('locked_by = $3');
    expect(saveParams).toEqual([
      '0xpkg:testnet',
      JSON.stringify(cursor),
      'token-abc',
    ]);
  });

  it('throws CycleFinalizedLeaseLostError when the lease was taken over', async () => {
    getQueryMock().mockImplementation(async (sql: string) => {
      if (isDdl(sql)) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 }; // fence rejected the write
    });

    await expect(
      saveCycleFinalizedCursor('0xpkg:testnet', cursor, 'stale-token'),
    ).rejects.toBeInstanceOf(CycleFinalizedLeaseLostError);
  });
});
