import {
  normalizeScreeningAddress,
  parseDigitalCurrencyAddresses,
  refreshSanctionsList,
  screenAddress,
  sanctionsErrorBody,
} from '@/lib/sanctions';
import { getSharedPgPool, isPostgresConfigured } from '@/lib/pg-pool';

jest.mock('@/lib/pg-pool', () => ({
  getSharedPgPool: jest.fn(),
  isPostgresConfigured: jest.fn(() => true),
}));

const mockedGetPool = getSharedPgPool as jest.MockedFunction<typeof getSharedPgPool>;
const mockedConfigured = isPostgresConfigured as jest.MockedFunction<
  typeof isPostgresConfigured
>;

interface QueryCall {
  sql: string;
  params?: unknown[];
}

function installPool(handler: (sql: string, params?: unknown[]) => { rows: unknown[]; rowCount: number }) {
  const calls: QueryCall[] = [];
  const query = jest.fn(async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params });
    return handler(sql, params);
  });
  const client = { query, release: jest.fn() };
  mockedGetPool.mockReturnValue({
    query,
    connect: jest.fn(async () => client),
  } as unknown as ReturnType<typeof getSharedPgPool>);
  return { calls, query, client };
}

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  jest.clearAllMocks();
});

describe('normalizeScreeningAddress', () => {
  it('lowercases and pads short 0x-hex inputs to the 32-byte form', () => {
    const forms = normalizeScreeningAddress('0xABc123');
    expect(forms).toContain('0xabc123');
    expect(forms).toContain(`0x${'abc123'.padStart(64, '0')}`);
  });

  it('leaves non-hex addresses as a single lowercase candidate', () => {
    expect(normalizeScreeningAddress(' 1AjZPMsnmpdK2Rv9KQNfMurTXinscVro9V ')).toEqual([
      '1ajzpmsnmpdk2rv9kqnfmurtxinscvro9v',
    ]);
  });
});

describe('screenAddress', () => {
  it('blocks a listed address and records the audit row', async () => {
    const { calls } = installPool((sql) => {
      if (sql.includes('FROM sanctioned_addresses')) {
        return { rows: [{ list_version: '2026-07-05:abc' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });

    const result = await screenAddress('0xBAD', 'circle_join');

    // `reason: 'hit'` distinguishes a real match from a fail-closed outage,
    // so callers can say "refused" vs "try again shortly".
    expect(result).toEqual({
      blocked: true,
      listVersion: '2026-07-05:abc',
      reason: 'hit',
    });
    const logCall = calls.find((c) => c.sql.includes('INSERT INTO sanctions_screen_log'));
    expect(logCall?.params).toEqual([
      '0xbad',
      'circle_join',
      'blocked',
      '2026-07-05:abc',
    ]);
  });

  it('passes an unlisted address and records a pass row', async () => {
    const { calls } = installPool((sql) => {
      if (sql.includes('FROM sanctioned_addresses')) return { rows: [], rowCount: 0 };
      if (sql.includes('FROM sanctions_list_meta')) {
        return { rows: [{ list_version: '2026-07-05:abc' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });

    const result = await screenAddress('0xGOOD', 'circle_create');
    // The pass log row is fire-and-forget; flush microtasks before asserting.
    await new Promise((resolve) => setImmediate(resolve));

    expect(result).toEqual({ blocked: false, listVersion: '2026-07-05:abc' });
    const logCall = calls.find((c) => c.sql.includes('INSERT INTO sanctions_screen_log'));
    expect(logCall?.params?.[2]).toBe('pass');
  });

  it('matches via the padded candidate form (mixed case + unpadded input)', async () => {
    let lookupParams: unknown[] | undefined;
    installPool((sql, params) => {
      if (sql.includes('FROM sanctioned_addresses')) {
        lookupParams = params;
        return { rows: [{ list_version: 'v' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });

    const result = await screenAddress('0xAbC1', 'whatsapp_link');

    expect(result.blocked).toBe(true);
    expect(lookupParams?.[0]).toEqual(
      expect.arrayContaining(['0xabc1', `0x${'abc1'.padStart(64, '0')}`]),
    );
  });

  it('fails OPEN with a loud log when the query errors', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const query = jest.fn(async (sql: string) => {
      if (sql.includes('FROM sanctioned_addresses')) throw new Error('pg down');
      return { rows: [], rowCount: 1 };
    });
    mockedGetPool.mockReturnValue({ query, connect: jest.fn() } as unknown as ReturnType<
      typeof getSharedPgPool
    >);

    const result = await screenAddress('0xANY', 'circle_join');

    expect(result).toEqual({ blocked: false, listVersion: null });
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('FAIL-OPEN'),
      expect.anything(),
    );
    errorSpy.mockRestore();
  });

  it('skips entirely when the flag is explicitly false', async () => {
    process.env.SANCTIONS_SCREENING_ENABLED = 'false';
    const { query } = installPool(() => ({ rows: [], rowCount: 0 }));

    const result = await screenAddress('0xANY', 'circle_create');

    expect(result).toEqual({ blocked: false, listVersion: null });
    expect(query).not.toHaveBeenCalled();
  });

  it('skips with a warning when Postgres is not configured', async () => {
    mockedConfigured.mockReturnValueOnce(false);
    const { query } = installPool(() => ({ rows: [], rowCount: 0 }));

    const result = await screenAddress('0xANY', 'circle_create');

    expect(result).toEqual({ blocked: false, listVersion: null });
    expect(query).not.toHaveBeenCalled();
  });
});

describe('parseDigitalCurrencyAddresses', () => {
  it('extracts ticker/address pairs and dedupes', () => {
    const sample = [
      'SOME,ROW,"a; Digital Currency Address - XBT 1AjZPMsnmpdK2Rv9KQNfMurTXinscVro9V; more"',
      'OTHER,ROW,"Digital Currency Address - ETH 0x7f367cc41522ce07553e823bf3be79a889debe1b;"',
      'DUP,ROW,"Digital Currency Address - ETH 0x7F367cc41522cE07553e823bf3be79A889DEbe1B;"',
      'JUNK,ROW,"Digital Currency Address - X 1;"',
    ].join('\n');

    const entries = parseDigitalCurrencyAddresses(sample);

    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      ticker: 'XBT',
      address: '1AjZPMsnmpdK2Rv9KQNfMurTXinscVro9V',
    });
    expect(entries[1].ticker).toBe('ETH');
  });
});

describe('refreshSanctionsList', () => {
  function mockFetch(body: string) {
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => body,
    })) as unknown as typeof fetch;
  }

  const CSV = 'x,"Digital Currency Address - ETH 0x7f367cc41522ce07553e823bf3be79a889debe1b;"';

  it('short-circuits when the content hash matches the current list', async () => {
    mockFetch(CSV);
    process.env.SANCTIONS_MIN_ADDRESS_FLOOR = '1';
    const { createHash } = jest.requireActual('crypto') as typeof import('crypto');
    const hash = createHash('sha256').update(CSV).digest('hex').slice(0, 12);
    const { calls } = installPool((sql) => {
      if (sql.includes('FROM sanctions_list_meta')) {
        return {
          rows: [{ list_version: `2026-01-01:${hash}`, address_count: 1 }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    });

    const result = await refreshSanctionsList();

    expect(result.skipped).toBe(true);
    expect(calls.some((c) => c.sql.includes('INSERT INTO sanctioned_addresses'))).toBe(false);
  });

  it('upserts, prunes delistings, and updates the meta row on new content', async () => {
    mockFetch(CSV);
    process.env.SANCTIONS_MIN_ADDRESS_FLOOR = '1';
    const { calls } = installPool((sql) => {
      if (sql.includes('FROM sanctions_list_meta')) {
        return { rows: [{ list_version: '2026-01-01:old', address_count: 1 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });

    const result = await refreshSanctionsList();

    expect(result.skipped).toBe(false);
    expect(result.count).toBe(1);
    const sqls = calls.map((c) => c.sql);
    expect(sqls.some((s) => s.includes('INSERT INTO sanctioned_addresses'))).toBe(true);
    expect(sqls.some((s) => s.includes('DELETE FROM sanctioned_addresses'))).toBe(true);
    expect(sqls.some((s) => s.includes('INSERT INTO sanctions_list_meta'))).toBe(true);
    expect(sqls).toContain('COMMIT');
  });

  it('aborts without touching the table when the parse is under the floor', async () => {
    mockFetch('no digital currency rows here');
    const { calls } = installPool((sql) => {
      if (sql.includes('FROM sanctions_list_meta')) {
        return { rows: [{ list_version: '2026-01-01:old', address_count: 900 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(refreshSanctionsList()).rejects.toThrow('ABORTED');
    expect(calls.some((c) => c.sql.includes('INSERT INTO sanctioned_addresses'))).toBe(false);
  });
});

describe('sanctionsErrorBody', () => {
  it('returns the stable neutral 403 contract', () => {
    expect(sanctionsErrorBody()).toEqual({
      success: false,
      error: 'SANCTIONS_BLOCKED',
      code: 'SANCTIONS_BLOCKED',
      message: "This wallet can't use Njangi On-Chain.",
    });
  });
});

describe('screenAddress fail mode', () => {
  // The asymmetry this suite defends: a new commitment must never proceed
  // unscreened, but an outage must never block a member from reaching funds
  // they have already committed. Getting this backwards is how a compliance
  // control becomes a fund freeze — the 2026-07-21 Neon outage would have
  // locked every user out for twelve days had login failed closed.

  it('fails OPEN on infrastructure errors by default (login, claim, refund)', async () => {
    installPool(() => {
      throw new Error('connection terminated');
    });

    const result = await screenAddress('0xANY', 'proof_issuance');
    expect(result.blocked).toBe(false);
  });

  it('fails CLOSED on the same error when the caller opts in', async () => {
    installPool(() => {
      throw new Error('connection terminated');
    });

    const result = await screenAddress('0xANY', 'circle_join', { failClosed: true });
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('unavailable');
  });

  it('fails CLOSED when the list has never been loaded', async () => {
    // An empty list matches nothing, so a "pass" here means "not screened".
    installPool((sql) => {
      if (sql.includes('sanctioned_addresses')) return { rows: [], rowCount: 0 };
      if (sql.includes('sanctions_list_meta')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    });

    const strict = await screenAddress('0xANY', 'circle_join', { failClosed: true });
    expect(strict).toMatchObject({ blocked: true, reason: 'unavailable' });

    const lenient = await screenAddress('0xANY', 'proof_issuance');
    expect(lenient.blocked).toBe(false);
  });

  it('fails CLOSED when Postgres is not configured', async () => {
    mockedConfigured.mockReturnValueOnce(false);
    const strict = await screenAddress('0xANY', 'ramp_session', { failClosed: true });
    expect(strict).toMatchObject({ blocked: true, reason: 'unavailable' });
  });

  it('fails CLOSED when screening is disabled by flag', async () => {
    // A disabled flag is not a pass. If an operator turns screening off,
    // new commitments stop rather than flowing through unchecked.
    process.env.SANCTIONS_SCREENING_ENABLED = 'false';
    const strict = await screenAddress('0xANY', 'circle_join', { failClosed: true });
    expect(strict.blocked).toBe(true);

    const lenient = await screenAddress('0xANY', 'proof_issuance');
    expect(lenient.blocked).toBe(false);
  });

  it('blocks a positive hit in BOTH modes, and marks it a hit not an outage', async () => {
    installPool((sql) => {
      if (sql.includes('sanctioned_addresses')) {
        return { rows: [{ list_version: '2026-08-01' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    for (const opts of [{}, { failClosed: true }]) {
      const result = await screenAddress('0xBAD', 'circle_join', opts);
      expect(result.blocked).toBe(true);
      // Callers distinguish these: a hit is final, an outage says "retry".
      expect(result.reason).toBe('hit');
    }
  });
});
