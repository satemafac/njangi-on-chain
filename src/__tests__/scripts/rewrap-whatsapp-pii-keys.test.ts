/**
 * scripts/rewrap-whatsapp-pii-keys.mjs: the database half of rotating
 * WALRUS_PII_MASTER_KEY. It re-wraps each link's data key under the new
 * master key and leaves the data keys, and so every blob, as they are.
 *
 * Runs the real script with `pg` swapped for the in-memory fake
 * (fixtures/fake-pg.mjs through fixtures/fake-pg-hooks.mjs), as the deletion
 * script's tests do. No database, and throwaway keys.
 */
import { spawnSync } from 'child_process';
import { randomBytes } from 'crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import {
  kekOf,
  newDataKey,
  newKeyId,
  unwrapDataKey,
  wrapDataKey,
  type Kek,
} from '../../../scripts/lib/pii-key-wrap';

const repoRoot = path.resolve(__dirname, '../../..');
const SCRIPT = path.join(repoRoot, 'scripts/rewrap-whatsapp-pii-keys.mjs');
const HOOKS = pathToFileURL(path.join(__dirname, 'fixtures/fake-pg-hooks.mjs')).href;

const OLD_HEX = randomBytes(32).toString('hex');
const NEW_HEX = randomBytes(32).toString('hex');
const OLD = kekOf(Buffer.from(OLD_HEX, 'hex'));
const NEW = kekOf(Buffer.from(NEW_HEX, 'hex'));

interface KeyRow {
  kid: string;
  phone_hmac: string;
  circle_id: string;
  wrapped_dek: string;
  kek_id: string;
}

function keyRow(kek: Kek, dek = newDataKey()): { row: KeyRow; dek: Buffer } {
  const kid = newKeyId();
  return {
    row: { kid, phone_hmac: 'h', circle_id: '0xc1', wrapped_dek: wrapDataKey(dek, kek.key, kid), kek_id: kek.id },
    dek,
  };
}

function runScript(
  args: string[],
  seed: { keys?: KeyRow[] },
  keys: { master?: string; previous?: string } = { master: NEW_HEX, previous: OLD_HEX },
) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rewrap-keys-'));
  const statePath = path.join(dir, 'db.json');
  try {
    writeFileSync(statePath, JSON.stringify({ index: [], ...seed }));
    // Only what the script needs, so a developer's real DATABASE_URL or keys
    // can never reach it.
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      PATH: process.env.PATH,
      DATABASE_URL: 'postgres://fake.invalid/rewrap-test',
      FAKE_PG_STATE: statePath,
    };
    if (keys.master) env.WALRUS_PII_MASTER_KEY = keys.master;
    if (keys.previous) env.WALRUS_PII_PREVIOUS_MASTER_KEY = keys.previous;
    const result = spawnSync(process.execPath, ['--import', HOOKS, SCRIPT, ...args], {
      encoding: 'utf8',
      env,
    });
    const db = JSON.parse(readFileSync(statePath, 'utf8')) as {
      keys?: KeyRow[];
      queries: Array<{ sql: string; params: unknown[] }>;
    };
    return { code: result.status, stdout: result.stdout, stderr: result.stderr, db };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const updates = (db: { queries: Array<{ sql: string }> }) =>
  db.queries.filter((q) => q.sql.startsWith('UPDATE'));

it('re-wraps every key under the new master key, keeping each data key', () => {
  const a = keyRow(OLD);
  const b = keyRow(OLD);
  const current = keyRow(NEW);

  const { code, stdout, stderr, db } = runScript([], { keys: [a.row, b.row, current.row] });

  expect(code).toBe(0);
  expect(stderr).toBe('');
  const rows = new Map((db.keys ?? []).map((row) => [row.kid, row]));
  for (const { row, dek } of [a, b]) {
    const after = rows.get(row.kid) as KeyRow;
    expect(after.kek_id).toBe(NEW.id);
    expect(unwrapDataKey(after.wrapped_dek, NEW.key, row.kid)?.equals(dek)).toBe(true);
    expect(unwrapDataKey(after.wrapped_dek, OLD.key, row.kid)).toBeNull();
  }
  // Already under the new key: untouched.
  expect(rows.get(current.row.kid)).toEqual(current.row);
  expect(stdout).toContain('data keys not under the new master key: 2');
  expect(stdout).toContain('re-wrapped: 2');
  expect(stdout).toContain('data keys still not under the new master key: 0');
  // Neither key, nor a data key, ever reaches the output.
  for (const secret of [OLD_HEX, NEW_HEX, a.dek.toString('hex'), a.dek.toString('base64')]) {
    expect(stdout + stderr).not.toContain(secret);
  }
});

it('is a no-op the second time', () => {
  const a = keyRow(OLD);
  const first = runScript([], { keys: [a.row] });
  const second = runScript([], { keys: first.db.keys });

  expect(second.code).toBe(0);
  expect(updates(second.db)).toEqual([]);
  expect(second.stdout).toContain('re-wrapped: 0');
});

it('reports a key wrapped under neither master key by id, leaves it, and exits 1', () => {
  const stranger = keyRow(kekOf(randomBytes(32)));
  const a = keyRow(OLD);

  const { code, stdout, stderr, db } = runScript([], { keys: [stranger.row, a.row] });

  expect(code).toBe(1);
  expect(stderr).toContain(`${stranger.row.kid}: wrapped under neither key`);
  const rows = new Map((db.keys ?? []).map((row) => [row.kid, row]));
  expect(rows.get(stranger.row.kid)).toEqual(stranger.row);
  expect(rows.get(a.row.kid)?.kek_id).toBe(NEW.id);
  expect(stdout).toContain('data keys still not under the new master key: 1');
});

it('writes nothing on a dry run', () => {
  const a = keyRow(OLD);

  const { code, stdout, db } = runScript(['--dry-run'], { keys: [a.row] });

  expect(code).toBe(0);
  expect(stdout).toContain('would re-wrap: 1');
  expect(updates(db)).toEqual([]);
  expect(db.keys).toEqual([a.row]);
});

it('refuses a previous key equal to the master key before reading anything', () => {
  const { code, stderr, db } = runScript([], { keys: [] }, { master: NEW_HEX, previous: NEW_HEX });

  expect(code).toBe(1);
  expect(stderr).toContain('the previous key is the OLD one');
  expect(db.queries).toEqual([]);
});

it('says so and exits 0 when the database has no key table', () => {
  const { code, stdout } = runScript([], {});

  expect(code).toBe(0);
  expect(stdout).toContain('no whatsapp_pii_keys table');
});
