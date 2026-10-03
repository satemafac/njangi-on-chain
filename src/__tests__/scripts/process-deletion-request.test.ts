/**
 * scripts/process-deletion-request.mjs hashed `--phone` as typed, "+" and
 * all, while the WhatsApp index (src/lib/whatsapp-link-index.ts) hashes the
 * number without its "+". So the documented `--phone +2376…` deleted no
 * whatsapp_phone_index row, and the phone_hmac it recorded on the request
 * excluded nothing from Walrus blob renewal. Both sides now take the form
 * from scripts/lib/whatsapp-phone.ts.
 *
 * The script tests run the real script with `pg` swapped for an in-memory
 * fake (fixtures/fake-pg.mjs, through fixtures/fake-pg-hooks.mjs), and seed
 * the fake index with the hash the real indexWhatsAppLink writes. No
 * database and no real salt; the numbers come from ranges reserved for
 * fiction (Ofcom's +44 7700 900xxx, the NANP's 555-01xx).
 */
import { spawnSync } from 'child_process';
import { createHmac } from 'crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { normalizePhone, phoneForErasure } from '../../../scripts/lib/whatsapp-phone';
import { indexWhatsAppLink, lookupCirclesForPhone } from '@/lib/whatsapp-link-index';

const mockQueries: Array<{ sql: string; params: unknown[] }> = [];
jest.mock('@/lib/pg-pool', () => ({
  isPostgresConfigured: () => true,
  getSharedPgPool: () => ({
    query: async (sql: string, params: unknown[] = []) => {
      mockQueries.push({ sql, params });
      return { rows: [], rowCount: 0 };
    },
  }),
}));

const repoRoot = path.resolve(__dirname, '../../..');
const SCRIPT = path.join(repoRoot, 'scripts/process-deletion-request.mjs');
const HOOKS = pathToFileURL(path.join(__dirname, 'fixtures/fake-pg-hooks.mjs')).href;
const SALT = 'test-lookup-salt';

/** As the link form sends it: react-phone-number-input gives E.164. */
const LINKED = '+447700900123';
/** The same number as Meta's webhook sends it. */
const FROM_META = '447700900123';
const OTHER = '+12025550123';

const hmac = (value: string) => createHmac('sha256', SALT).update(value).digest('hex');

interface RequestRow {
  id: number;
  email: string;
  user_address: string | null;
  status: 'pending' | 'processing' | 'completed' | 'rejected';
  identity_verified: boolean;
  verified_sub: string | null;
  verified_aud: string | null;
  phone_hmac: string | null;
  created_at: string;
}

interface IndexRow {
  phone_hmac: string;
  circle_id: string;
}

interface FakeDb {
  request: RequestRow;
  index: IndexRow[];
  queries?: Array<{ sql: string; params: unknown[] }>;
}

function request(overrides: Partial<RequestRow> = {}): RequestRow {
  return {
    id: 7,
    email: 'requester@example.com',
    user_address: null,
    status: 'pending',
    identity_verified: false,
    verified_sub: null,
    verified_aud: null,
    phone_hmac: null,
    created_at: '2026-10-01T09:00:00.000Z',
    ...overrides,
  };
}

/** Runs the real script against the fake database `seed`; returns its output and the database after. */
function runScript(args: string[], seed: FakeDb) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'deletion-request-'));
  const statePath = path.join(dir, 'db.json');
  try {
    writeFileSync(statePath, JSON.stringify(seed));
    const result = spawnSync(process.execPath, ['--import', HOOKS, SCRIPT, ...args], {
      encoding: 'utf8',
      // Only what the script needs, so a developer's real DATABASE_URL or
      // salt can never reach it.
      env: {
        NODE_ENV: 'test',
        PATH: process.env.PATH,
        DATABASE_URL: 'postgres://fake.invalid/deletion-test',
        WALRUS_LOOKUP_SALT: SALT,
        FAKE_PG_STATE: statePath,
      },
    });
    const db = JSON.parse(readFileSync(statePath, 'utf8')) as Required<FakeDb>;
    return { code: result.status, stdout: result.stdout, stderr: result.stderr, db };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const writes = (db: Required<FakeDb>) => db.queries.filter((q) => /^(DELETE|UPDATE|INSERT)\b/.test(q.sql));

/** The phone_hmac indexWhatsAppLink writes for a number linked through the app. */
async function indexedHash(phoneOrGroup: string): Promise<string> {
  mockQueries.length = 0;
  await indexWhatsAppLink({ phoneOrGroup, circleId: '0xc1', walrusBlobId: 'blob-1', linkType: 1 });
  const insert = mockQueries.find((q) => q.sql.includes('INSERT INTO whatsapp_phone_index'));
  return insert?.params[0] as string;
}

/** The phone_hmac lookupCirclesForPhone queries when the webhook gets a message. */
async function lookedUpHash(phone: string): Promise<string> {
  mockQueries.length = 0;
  await lookupCirclesForPhone(phone);
  const select = mockQueries.find((q) => q.sql.includes('FROM whatsapp_phone_index WHERE phone_hmac'));
  return select?.params[0] as string;
}

const savedSalt = process.env.WALRUS_LOOKUP_SALT;
beforeAll(() => {
  process.env.WALRUS_LOOKUP_SALT = SALT;
});
afterAll(() => {
  if (savedSalt === undefined) delete process.env.WALRUS_LOOKUP_SALT;
  else process.env.WALRUS_LOOKUP_SALT = savedSalt;
});

describe('normalizePhone', () => {
  it('removes surrounding whitespace and one leading "+"', () => {
    expect(normalizePhone(LINKED)).toBe(FROM_META);
    expect(normalizePhone(FROM_META)).toBe(FROM_META);
    expect(normalizePhone(` ${LINKED}\n`)).toBe(FROM_META);
  });

  it('keeps the hash of every input the index can already hold', () => {
    // The order before this change: remove the "+", then trim.
    const original = (value: string) => value.replace(/^\+/, '').trim();
    const inputs = [
      LINKED,
      FROM_META,
      OTHER,
      '+ 447700900123',
      '++447700900123',
      `${LINKED} `,
      '120363043968066561@g.us',
      '123456789-1234567890@g.us',
      '',
    ];
    for (const value of inputs) expect(normalizePhone(value)).toBe(original(value));
  });

  it('also removes a "+" that follows leading whitespace, which the original order kept', () => {
    expect(normalizePhone(' +447700900123')).toBe(FROM_META);
    expect(' +447700900123'.replace(/^\+/, '').trim()).toBe('+447700900123');
  });
});

describe('phoneForErasure', () => {
  it('returns the index form of an international number, separators dropped', () => {
    for (const input of [
      '+447700900123',
      '+44 7700 900123',
      '+44-7700-900-123',
      '+44.7700.900.123',
      '  +44 7700 900123\n',
    ]) {
      expect(phoneForErasure(input)).toBe(normalizePhone(LINKED));
    }
    expect(phoneForErasure('+1 202 555 0123')).toBe('12025550123');
  });

  it('accepts E.164 lengths, 7 to 15 digits', () => {
    expect(phoneForErasure('+1234567')).toBe('1234567');
    expect(phoneForErasure('+123456789012345')).toBe('123456789012345');
  });

  it('refuses what would hash to a form the index never holds', () => {
    for (const input of [
      '', // `--phone ""`, e.g. an unset shell variable
      '447700900123', // no "+": a national number would look the same
      '07700 900123', // national format
      '00447700900123', // "00" international prefix
      '+44 (0)7700 900123', // "(0)" trunk digit
      '+1 (202) 555-0123', // parentheses are refused, not guessed at
      '+0447700900123', // country codes never start with 0
      '+123456', // too short
      '+1234567890123456', // too long
      '+44 7700 900123 ext 5',
      '120363043968066561@g.us', // a group id, not a phone
      '--dry-run', // `--phone` given without a value
    ]) {
      expect(phoneForErasure(input)).toBeNull();
    }
  });
});

describe('the deletion executor and the WhatsApp index hash a number the same way', () => {
  it('matches what the link form writes and what the webhook looks up', async () => {
    const indexed = await indexedHash(LINKED);

    expect(indexed).toBe(hmac(FROM_META));
    expect(await lookedUpHash(FROM_META)).toBe(indexed);
    expect(hmac(phoneForErasure('+44 7700 900123') as string)).toBe(indexed);
    // What the script hashed before the fix, for the documented invocation.
    expect(hmac(LINKED)).not.toBe(indexed);
  });
});

describe('scripts/process-deletion-request.mjs', () => {
  it('erases the index rows of a number given as documented, and records the hash the index uses', async () => {
    const linked = await indexedHash(LINKED);
    const other = await indexedHash(OTHER);

    const { code, stdout, stderr, db } = runScript(['--request-id', '7', '--phone', '+44 7700 900123'], {
      request: request(),
      index: [
        { phone_hmac: linked, circle_id: '0xc1' },
        { phone_hmac: linked, circle_id: '0xc2' },
        { phone_hmac: other, circle_id: '0xc3' },
      ],
    });

    expect(code).toBe(0);
    expect(db.index).toEqual([{ phone_hmac: other, circle_id: '0xc3' }]);
    expect(db.request.phone_hmac).toBe(linked);
    expect(db.request.status).toBe('completed');
    expect(stdout).toContain('whatsapp_phone_index rows matching the phone: 2');
    expect(stdout).toContain('whatsapp_phone_index rows for phone: 2 row(s)');
    expect(stderr).not.toContain('no index row matches');
  });

  it('repairs a completed request whose run before the fix recorded the "+" hash, and keeps it completed', async () => {
    const linked = await indexedHash(LINKED);

    // Completed under --force-unverified-identity: a wallet is referenced
    // but the request is not identity-verified, and the repair re-run passes
    // neither the flag nor --sub/--aud. It must not reopen the request.
    const { code, stdout, stderr, db } = runScript(['--request-id', '7', '--phone', LINKED], {
      request: request({
        status: 'completed',
        user_address: '0x00000000000000000000000000000000000000000000000000000000000000aa',
        phone_hmac: hmac(LINKED),
      }),
      index: [{ phone_hmac: linked, circle_id: '0xc1' }],
    });

    expect(code).toBe(0);
    expect(db.index).toEqual([]);
    expect(db.request.phone_hmac).toBe(linked);
    expect(db.request.status).toBe('completed');
    expect(stderr).toContain('records the hash of this number WITH its "+"');
    expect(stdout).toContain('stays completed');
  });

  it('still leaves an unverified, wallet-referencing request in processing on its first run', async () => {
    const { code, db } = runScript(['--request-id', '7', '--phone', LINKED], {
      request: request({ user_address: '0x00000000000000000000000000000000000000000000000000000000000000aa' }),
      index: [],
    });

    expect(code).toBe(0);
    expect(db.request.status).toBe('processing');
  });

  it.each([
    ['without its "+"', ['--phone', FROM_META]],
    ['in national format', ['--phone', '07700 900123']],
    ['empty', ['--phone', '']],
    ['with no value', ['--phone']],
    ['as --phone=', [`--phone=${LINKED}`]],
  ])('refuses a --phone given %s before reading or writing anything', (_label, phoneArgs) => {
    const seed = { request: request(), index: [{ phone_hmac: hmac(FROM_META), circle_id: '0xc1' }] };

    const { code, stderr, db } = runScript(['--request-id', '7', ...phoneArgs], seed);

    expect(code).toBe(1);
    expect(stderr).toContain('--phone takes an international number');
    expect(db.queries).toEqual([]);
    expect(db.index).toEqual(seed.index);
    expect(db.request).toEqual(seed.request);
  });

  it('counts the matching rows on a dry run and writes nothing', async () => {
    const linked = await indexedHash(LINKED);
    const seed = { request: request(), index: [{ phone_hmac: linked, circle_id: '0xc1' }] };

    const { code, stdout, db } = runScript(['--request-id', '7', '--phone', LINKED, '--dry-run'], seed);

    expect(code).toBe(0);
    expect(stdout).toContain('whatsapp_phone_index rows matching the phone: 1');
    expect(writes(db)).toEqual([]);
    expect(db.index).toEqual(seed.index);
    expect(db.request).toEqual(seed.request);
  });

  it('warns when the number matches no index row', () => {
    const { code, stderr, db } = runScript(['--request-id', '7', '--phone', OTHER], {
      request: request(),
      index: [{ phone_hmac: hmac(FROM_META), circle_id: '0xc1' }],
    });

    expect(code).toBe(0);
    expect(stderr).toContain('no index row matches this number');
    expect(db.index).toHaveLength(1);
  });
});
