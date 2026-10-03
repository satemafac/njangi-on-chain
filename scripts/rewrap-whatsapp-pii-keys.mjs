#!/usr/bin/env node
// rewrap-whatsapp-pii-keys.mjs — The database half of rotating
// WALRUS_PII_MASTER_KEY (docs/environment.md, "Rotating the WhatsApp PII
// keys").
//
// Each WhatsApp link made since per-link keys has its own data key in
// `whatsapp_pii_keys`, wrapped under the master key (src/lib/whatsapp-pii-keys.ts).
// A rotation changes no blob: this script re-wraps every data key under the
// new master key. The data keys themselves stay the same, so every
// envelope keeps opening.
//
// Run it only once the deployment holding BOTH keys is live
// (WALRUS_PII_MASTER_KEY = new, WALRUS_PII_PREVIOUS_MASTER_KEY = old). That
// deployment unwraps a re-wrapped key with the new key and any other with
// the old one, so links keep working throughout. While a deployment holding
// only the old key is still serving, a re-wrapped key would not open there.
//
// Usage:
//   DATABASE_URL=… WALRUS_PII_MASTER_KEY=<new> WALRUS_PII_PREVIOUS_MASTER_KEY=<old> \
//     node scripts/rewrap-whatsapp-pii-keys.mjs [--dry-run]
//   or: npm run rewrap:pii-keys -- [--dry-run]
//
// Safe to re-run: a key already under the new master key is left alone, and
// each update lands only while the row is still wrapped the way it was read.
// Exits 1 when a row could not be re-wrapped (wrapped under neither key, or
// altered), naming it by key id. It never prints a key or a number. Its last
// line counts the rows not yet under the new master key: the old key can go
// only once that is 0 (see the docs for the other condition).
//
// Needs Node >= 22.18 (it imports scripts/lib/*.ts through Node's type
// stripping); package.json pins 24.x.

import process from 'node:process';
import { Pool } from 'pg';
import { decodePiiMasterKey, kekOf, planRewrap } from './lib/pii-key-wrap.ts';

const DRY_RUN = process.argv.includes('--dry-run');

function fail(message) {
  console.error(`[rewrap] ${message}`);
  process.exit(1);
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) fail('DATABASE_URL is required.');
const masterRaw = process.env.WALRUS_PII_MASTER_KEY;
if (!masterRaw) fail('WALRUS_PII_MASTER_KEY (the NEW key) is required.');
const previousRaw = process.env.WALRUS_PII_PREVIOUS_MASTER_KEY;

let ring;
try {
  ring = {
    current: kekOf(decodePiiMasterKey('WALRUS_PII_MASTER_KEY', masterRaw)),
    previous: previousRaw
      ? kekOf(decodePiiMasterKey('WALRUS_PII_PREVIOUS_MASTER_KEY', previousRaw))
      : null,
  };
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
if (ring.previous && ring.previous.id === ring.current.id) {
  fail('WALRUS_PII_PREVIOUS_MASTER_KEY is the same key as WALRUS_PII_MASTER_KEY: the previous key is the OLD one.');
}

// SSL as scripts/migrate-postgres.mjs resolves it: sslmode from the URL or
// PGSSLMODE wins, and production defaults to verified TLS.
function resolveSsl(connectionString) {
  let sslmode = null;
  try {
    sslmode = new URL(connectionString).searchParams.get('sslmode');
  } catch {
    // Not URL-parseable; fall through to env/heuristics.
  }
  sslmode = sslmode ?? process.env.PGSSLMODE ?? null;
  if (sslmode) {
    if (sslmode === 'disable') return undefined;
    if (sslmode === 'no-verify') return { rejectUnauthorized: false };
    return { rejectUnauthorized: true };
  }
  if (process.env.NODE_ENV === 'production') return { rejectUnauthorized: true };
  return undefined;
}

const pool = new Pool({ connectionString: DATABASE_URL, ssl: resolveSsl(DATABASE_URL) });

async function main() {
  console.log(
    `[rewrap] new master key ${ring.current.id}; previous ${ring.previous ? ring.previous.id : 'not set'}` +
      `${DRY_RUN ? ' (dry run: nothing is written)' : ''}`,
  );

  const table = await pool.query(`SELECT to_regclass('whatsapp_pii_keys') IS NOT NULL AS present`);
  if (table.rows[0]?.present !== true) {
    console.log('[rewrap] no whatsapp_pii_keys table: no data key to re-wrap.');
    return;
  }

  const { rows } = await pool.query(
    'SELECT kid, wrapped_dek, kek_id FROM whatsapp_pii_keys WHERE kek_id <> $1 ORDER BY kid',
    [ring.current.id],
  );
  console.log(`[rewrap] data keys not under the new master key: ${rows.length}`);

  let rewrapped = 0;
  let changed = 0;
  const unreadable = [];
  for (const row of rows) {
    const plan = planRewrap(row, ring);
    if (plan.action === 'keep') continue;
    if (plan.action !== 'rewrap') {
      unreadable.push({ kid: row.kid, reason: plan.action, kekId: row.kek_id });
      continue;
    }
    if (DRY_RUN) {
      rewrapped += 1;
      continue;
    }
    const result = await pool.query(
      'UPDATE whatsapp_pii_keys SET wrapped_dek = $1, kek_id = $2 WHERE kid = $3 AND kek_id = $4',
      [plan.wrappedDek, plan.kekId, row.kid, row.kek_id],
    );
    if ((result.rowCount ?? 0) > 0) rewrapped += 1;
    else changed += 1; // deleted (unlinked, erased) or re-wrapped by another run meanwhile
  }

  console.log(`[rewrap] ${DRY_RUN ? 'would re-wrap' : 're-wrapped'}: ${rewrapped}`);
  if (changed > 0) {
    console.log(`[rewrap] changed by something else while this ran (deleted or already re-wrapped): ${changed}`);
  }
  for (const { kid, reason, kekId } of unreadable) {
    console.error(
      reason === 'unknown_kek'
        ? `[rewrap] ${kid}: wrapped under neither key (kek ${kekId}). Set WALRUS_PII_PREVIOUS_MASTER_KEY to the key that wrapped it.`
        : `[rewrap] ${kid}: does not open under its master key; the row was altered.`,
    );
  }

  const remaining = await pool.query(
    'SELECT COUNT(*)::int AS remaining FROM whatsapp_pii_keys WHERE kek_id <> $1',
    [ring.current.id],
  );
  console.log(`[rewrap] data keys still not under the new master key: ${remaining.rows[0]?.remaining ?? 0}`);
  if (unreadable.length > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error('[rewrap] fatal', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
