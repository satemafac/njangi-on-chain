/**
 * Tests for address-drift detection (docs/prd/prd-address-drift-guard.md).
 *
 * The cases that matter most:
 *   - a salt change (same iss/sub/aud, new address) is detected;
 *   - an aud change (same iss/sub, new client id, new address) is ALSO
 *     detected — this is the one a naive (sub, aud) key would miss, and it
 *     is a real documented drift cause, so it is asserted explicitly;
 *   - a different provider is NOT drift (different human-identity key);
 *   - detection failures fail OPEN, never blocking a login.
 */

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
  checkAddressDrift,
  getDriftStatusForIdentity,
  assertNoAddressDrift,
  AddressDriftBlockedError,
  addressDriftErrorBody,
  normalizeAddress,
} from '../zklogin-address-bindings';
import { getSharedPgPool } from '../pg-pool';

const query = (getSharedPgPool() as unknown as { query: jest.Mock }).query;

const ADDR_OLD = '0x' + 'a1'.repeat(32);
const ADDR_NEW = '0x' + 'b2'.repeat(32);

const GOOGLE_ISS = 'https://accounts.google.com';

function bindingRow(address: string, overrides: Record<string, unknown> = {}) {
  return {
    iss: GOOGLE_ISS,
    aud: 'client-id-1',
    provider: 'Google',
    user_address: address.toLowerCase(),
    first_seen_at: new Date('2026-01-01T00:00:00Z'),
    last_seen_at: new Date('2026-01-02T00:00:00Z'),
    login_count: 3,
    ...overrides,
  };
}

/**
 * checkAddressDrift issues: ensureTable, SELECT, INSERT. Queue the SELECT
 * result and let the DDL/INSERT resolve empty.
 */
function mockLookup(rows: Array<ReturnType<typeof bindingRow>>) {
  query.mockReset();
  query.mockImplementation((sql: string) => {
    if (/^\s*SELECT/i.test(sql)) return Promise.resolve({ rows });
    return Promise.resolve({ rows: [] });
  });
}

beforeEach(() => {
  process.env.DATABASE_URL = 'postgres://test';
  query.mockReset();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
});

describe('checkAddressDrift', () => {
  it('treats a never-seen identity as first_seen and does not block', async () => {
    mockLookup([]);
    const result = await checkAddressDrift({
      iss: GOOGLE_ISS,
      sub: 'sub-1',
      aud: 'client-id-1',
      provider: 'Google',
      userAddress: ADDR_NEW,
    });
    expect(result.status).toBe('first_seen');
    expect(result.drifted).toBe(false);
    expect(result.previousAddresses).toEqual([]);
  });

  it('treats a returning identity at the same address as known', async () => {
    mockLookup([bindingRow(ADDR_OLD)]);
    const result = await checkAddressDrift({
      iss: GOOGLE_ISS,
      sub: 'sub-1',
      aud: 'client-id-1',
      provider: 'Google',
      userAddress: ADDR_OLD,
    });
    expect(result.status).toBe('known');
    expect(result.drifted).toBe(false);
  });

  it('detects a SALT change: same iss/sub/aud, different address', async () => {
    mockLookup([bindingRow(ADDR_OLD)]);
    const result = await checkAddressDrift({
      iss: GOOGLE_ISS,
      sub: 'sub-1',
      aud: 'client-id-1',
      provider: 'Google',
      userAddress: ADDR_NEW,
    });
    expect(result.status).toBe('drifted');
    expect(result.drifted).toBe(true);
    expect(result.previousAddresses).toEqual([ADDR_OLD.toLowerCase()]);
  });

  it('detects an AUD change — the case a (sub, aud) key would miss', async () => {
    // The stored row is under the OLD client id; the login arrives under a
    // NEW one. Because the lookup keys on (iss, sub), the prior binding is
    // still found and the address change is caught.
    mockLookup([bindingRow(ADDR_OLD, { aud: 'client-id-OLD' })]);

    const result = await checkAddressDrift({
      iss: GOOGLE_ISS,
      sub: 'sub-1',
      aud: 'client-id-NEW',
      provider: 'Google',
      userAddress: ADDR_NEW,
    });

    expect(result.status).toBe('drifted');
    expect(result.previousAddresses).toEqual([ADDR_OLD.toLowerCase()]);

    // Guard the design itself: the lookup must not filter on aud.
    const selectCall = query.mock.calls.find(([sql]) => /^\s*SELECT/i.test(String(sql)));
    expect(selectCall).toBeDefined();
    expect(String(selectCall?.[0])).not.toMatch(/\baud\s*=/);
  });

  it('matches on provider for legacy rows written before iss capture', async () => {
    mockLookup([bindingRow(ADDR_OLD, { iss: null })]);
    const result = await checkAddressDrift({
      iss: GOOGLE_ISS,
      sub: 'sub-1',
      aud: 'client-id-1',
      provider: 'Google',
      userAddress: ADDR_NEW,
    });
    // The SQL's provider branch is what matches here; the row comes back
    // from the mock either way, so assert the parameters carry the fallback.
    const selectCall = query.mock.calls.find(([sql]) => /^\s*SELECT/i.test(String(sql)));
    expect(selectCall?.[1]).toEqual(['sub-1', GOOGLE_ISS, 'Google']);
    expect(result.drifted).toBe(true);
  });

  it('matches BACKFILLED rows, which carry neither iss nor provider', async () => {
    // scripts/migrate-postgres.mjs backfills from legal_acceptances and
    // subscriptions; neither table stores a provider, so those rows have
    // iss = NULL AND provider = NULL. If the lookup required a provider
    // match, every backfilled row would be invisible (NULL = 'Google' is
    // NULL, never true) and the backfill would protect nobody — which is
    // precisely the failure it exists to prevent.
    mockLookup([bindingRow(ADDR_OLD, { iss: null, provider: null })]);

    const result = await checkAddressDrift({
      iss: GOOGLE_ISS,
      sub: 'sub-1',
      aud: 'client-id-1',
      provider: 'Google',
      userAddress: ADDR_NEW,
    });

    expect(result.status).toBe('drifted');
    expect(result.previousAddresses).toEqual([ADDR_OLD.toLowerCase()]);

    // Guard the SQL branch itself, not just the mocked result.
    const selectCall = query.mock.calls.find(([sql]) => /^\s*SELECT/i.test(String(sql)));
    expect(String(selectCall?.[0])).toMatch(/iss IS NULL AND provider IS NULL/);
  });

  it('upgrades a backfilled row with iss/provider on the next login', async () => {
    mockLookup([bindingRow(ADDR_OLD, { iss: null, provider: null })]);
    await checkAddressDrift({
      iss: GOOGLE_ISS,
      sub: 'sub-1',
      aud: 'client-id-1',
      provider: 'Google',
      userAddress: ADDR_OLD,
    });
    const insertCall = query.mock.calls.find(([sql]) => /INSERT INTO/i.test(String(sql)));
    expect(String(insertCall?.[0])).toMatch(/iss\s*=\s*COALESCE/);
    expect(String(insertCall?.[0])).toMatch(/provider\s*=\s*COALESCE/);
  });

  it('records the binding on every login', async () => {
    mockLookup([]);
    await checkAddressDrift({
      iss: GOOGLE_ISS,
      sub: 'sub-1',
      aud: 'client-id-1',
      provider: 'Google',
      userAddress: ADDR_NEW,
    });
    const insertCall = query.mock.calls.find(([sql]) => /INSERT INTO/i.test(String(sql)));
    expect(insertCall).toBeDefined();
    expect(insertCall?.[1]).toContain(ADDR_NEW.toLowerCase());
  });

  it('fails OPEN when the lookup throws — a detection outage must not block login', async () => {
    query.mockReset();
    query.mockRejectedValue(new Error('connection refused'));
    const result = await checkAddressDrift({
      iss: GOOGLE_ISS,
      sub: 'sub-1',
      aud: 'client-id-1',
      provider: 'Google',
      userAddress: ADDR_NEW,
    });
    expect(result.status).toBe('unavailable');
    expect(result.drifted).toBe(false);
  });

  it('reports unavailable (not clean) when Postgres is not configured', async () => {
    delete process.env.DATABASE_URL;
    const result = await checkAddressDrift({
      iss: GOOGLE_ISS,
      sub: 'sub-1',
      aud: 'client-id-1',
      provider: 'Google',
      userAddress: ADDR_NEW,
    });
    expect(result.status).toBe('unavailable');
    expect(result.drifted).toBe(false);
  });
});

describe('getDriftStatusForIdentity', () => {
  it('does not write a binding — it is polled on ordinary page loads', async () => {
    mockLookup([bindingRow(ADDR_OLD)]);
    await getDriftStatusForIdentity({
      iss: GOOGLE_ISS,
      sub: 'sub-1',
      provider: 'Google',
      userAddress: ADDR_OLD,
    });
    const insertCall = query.mock.calls.find(([sql]) => /INSERT INTO/i.test(String(sql)));
    expect(insertCall).toBeUndefined();
  });
});

describe('assertNoAddressDrift', () => {
  it('throws for a drifted identity so commitment surfaces can refuse', async () => {
    mockLookup([bindingRow(ADDR_OLD)]);
    await expect(
      assertNoAddressDrift({
        iss: GOOGLE_ISS,
        sub: 'sub-1',
        provider: 'Google',
        userAddress: ADDR_NEW,
      }),
    ).rejects.toBeInstanceOf(AddressDriftBlockedError);
  });

  it('resolves for a known identity', async () => {
    mockLookup([bindingRow(ADDR_OLD)]);
    await expect(
      assertNoAddressDrift({
        iss: GOOGLE_ISS,
        sub: 'sub-1',
        provider: 'Google',
        userAddress: ADDR_OLD,
      }),
    ).resolves.toBeUndefined();
  });

  it('resolves when detection is unavailable — fail open', async () => {
    query.mockReset();
    query.mockRejectedValue(new Error('down'));
    await expect(
      assertNoAddressDrift({
        iss: GOOGLE_ISS,
        sub: 'sub-1',
        provider: 'Google',
        userAddress: ADDR_NEW,
      }),
    ).resolves.toBeUndefined();
  });
});

describe('addressDriftErrorBody', () => {
  it('tells the user that fund access still works', () => {
    const body = addressDriftErrorBody([ADDR_OLD]);
    expect(body.error).toBe('ADDRESS_DRIFT_BLOCKED');
    expect(body.previousAddresses).toEqual([ADDR_OLD]);
    expect(body.message).toMatch(/payout|refund|recovery/i);
  });
});

describe('normalizeAddress', () => {
  it('lowercases and trims so comparisons cannot false-positive on casing', () => {
    expect(normalizeAddress('  0xAbC  ')).toBe('0xabc');
  });
});

describe('getDriftStatusForAddress (ramp/whatsapp surfaces)', () => {
  it('flags an address whose identity holds other addresses', async () => {
    query.mockReset();
    query.mockImplementation((sql: string) => {
      if (/JOIN zklogin_address_bindings b/i.test(String(sql))) {
        return Promise.resolve({ rows: [{ user_address: ADDR_OLD.toLowerCase() }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const { getDriftStatusForAddress } = await import('../zklogin-address-bindings');
    const result = await getDriftStatusForAddress(ADDR_NEW);

    expect(result.drifted).toBe(true);
    expect(result.previousAddresses).toEqual([ADDR_OLD.toLowerCase()]);
  });

  it('reports clean for an address with a single-address identity', async () => {
    query.mockReset();
    query.mockResolvedValue({ rows: [] });

    const { getDriftStatusForAddress } = await import('../zklogin-address-bindings');
    const result = await getDriftStatusForAddress(ADDR_NEW);

    expect(result.drifted).toBe(false);
    expect(result.status).toBe('known');
  });

  it('fails OPEN on lookup errors — a detection outage must not stop a ramp', async () => {
    query.mockReset();
    query.mockRejectedValue(new Error('down'));

    const { getDriftStatusForAddress } = await import('../zklogin-address-bindings');
    const result = await getDriftStatusForAddress(ADDR_NEW);

    expect(result.drifted).toBe(false);
    expect(result.status).toBe('unavailable');
  });
});
