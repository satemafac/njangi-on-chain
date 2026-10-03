// Stands in for `pg` when the script tests run scripts/process-deletion-request.mjs
// (src/__tests__/scripts/process-deletion-request.test.ts) or
// scripts/rewrap-whatsapp-pii-keys.mjs (src/__tests__/scripts/rewrap-whatsapp-pii-keys.test.ts),
// so the real script runs end to end without a database. fake-pg-hooks.mjs
// points the script's `import { Pool } from 'pg'` here.
//
// FAKE_PG_STATE names a JSON file holding { request, index, keys? }: one
// deletion_requests row, the whatsapp_phone_index rows as
// [{ phone_hmac, circle_id }], and the whatsapp_pii_keys rows as
// [{ kid, phone_hmac, circle_id, wrapped_dek?, kek_id? }] (leave `keys` out
// for a database that has no key table yet). `failOn`, when set, makes the first query starting with
// that text throw, to test that a transaction leaves nothing behind. The
// fake answers the script's queries from the state, applies its writes
// (BEGIN snapshots the state, ROLLBACK restores it), and when the process
// exits (process.exit included) writes the result back with every query it
// received under `queries`. A query it does not recognise throws, so a
// change to the script's SQL fails the test instead of passing unchecked.
import { readFileSync, writeFileSync } from 'node:fs';

const statePath = process.env.FAKE_PG_STATE;
let state = { ...JSON.parse(readFileSync(statePath, 'utf8')), queries: [] };
process.on('exit', () => writeFileSync(statePath, JSON.stringify(state)));

let snapshot = null;

const sameId = (a, b) => String(a) === String(b);

function answer(sql, params) {
  if (state.failOn && sql.startsWith(state.failOn)) {
    state.failOn = null;
    throw new Error(`fake pg: injected failure on: ${sql}`);
  }
  if (sql === 'BEGIN') {
    snapshot = structuredClone({ request: state.request, index: state.index, keys: state.keys });
    return { rows: [] };
  }
  if (sql === 'COMMIT') {
    snapshot = null;
    return { rows: [] };
  }
  if (sql === 'ROLLBACK') {
    if (snapshot) state = { ...state, ...snapshot };
    snapshot = null;
    return { rows: [] };
  }
  const { request } = state;
  if (sql === 'SELECT * FROM deletion_requests WHERE id = $1') {
    return { rows: sameId(request.id, params[0]) ? [structuredClone(request)] : [] };
  }
  if (sql === 'SELECT * FROM deletion_requests WHERE email = $1 ORDER BY created_at DESC LIMIT 1') {
    return { rows: request.email === params[0] ? [structuredClone(request)] : [] };
  }
  if (sql === 'SELECT COUNT(*)::int AS matches FROM whatsapp_phone_index WHERE phone_hmac = $1') {
    return { rows: [{ matches: state.index.filter((row) => row.phone_hmac === params[0]).length }] };
  }
  if (sql === "SELECT to_regclass('whatsapp_pii_keys') IS NOT NULL AS present") {
    return { rows: [{ present: Array.isArray(state.keys) }] };
  }
  if (sql === 'SELECT COUNT(*)::int AS matches FROM whatsapp_pii_keys WHERE phone_hmac = $1') {
    if (!Array.isArray(state.keys)) throw new Error('fake pg: relation "whatsapp_pii_keys" does not exist');
    return { rows: [{ matches: state.keys.filter((row) => row.phone_hmac === params[0]).length }] };
  }
  if (sql === 'DELETE FROM whatsapp_pii_keys WHERE phone_hmac = $1') {
    if (!Array.isArray(state.keys)) throw new Error('fake pg: relation "whatsapp_pii_keys" does not exist');
    const before = state.keys.length;
    state.keys = state.keys.filter((row) => row.phone_hmac !== params[0]);
    return { rows: [], rowCount: before - state.keys.length };
  }
  // scripts/rewrap-whatsapp-pii-keys.mjs
  if (sql === 'SELECT kid, wrapped_dek, kek_id FROM whatsapp_pii_keys WHERE kek_id <> $1 ORDER BY kid') {
    const rows = state.keys.filter((row) => row.kek_id !== params[0]);
    rows.sort((a, b) => (a.kid < b.kid ? -1 : a.kid > b.kid ? 1 : 0));
    return { rows: rows.map(({ kid, wrapped_dek, kek_id }) => ({ kid, wrapped_dek, kek_id })) };
  }
  if (sql === 'UPDATE whatsapp_pii_keys SET wrapped_dek = $1, kek_id = $2 WHERE kid = $3 AND kek_id = $4') {
    const row = state.keys.find((candidate) => candidate.kid === params[2] && candidate.kek_id === params[3]);
    if (!row) return { rows: [], rowCount: 0 };
    row.wrapped_dek = params[0];
    row.kek_id = params[1];
    return { rows: [], rowCount: 1 };
  }
  if (sql === 'SELECT COUNT(*)::int AS remaining FROM whatsapp_pii_keys WHERE kek_id <> $1') {
    return { rows: [{ remaining: state.keys.filter((row) => row.kek_id !== params[0]).length }] };
  }
  if (sql === 'DELETE FROM whatsapp_phone_index WHERE phone_hmac = $1') {
    const before = state.index.length;
    state.index = state.index.filter((row) => row.phone_hmac !== params[0]);
    return { rows: [], rowCount: before - state.index.length };
  }
  if (sql === 'UPDATE deletion_requests SET phone_hmac = $1, updated_at = NOW() WHERE id = $2') {
    if (!sameId(request.id, params[1])) return { rows: [], rowCount: 0 };
    request.phone_hmac = params[0];
    return { rows: [], rowCount: 1 };
  }
  if (sql === 'UPDATE deletion_requests SET status = $2, updated_at = NOW() WHERE id = $1') {
    if (!sameId(request.id, params[0])) return { rows: [], rowCount: 0 };
    request.status = params[1];
    return { rows: [], rowCount: 1 };
  }
  // Address- and identity-keyed deletes: the fake holds none of those rows.
  if (/^DELETE FROM (join_requests|zklogin_sessions|recovery_codes|salts) /.test(sql)) {
    return { rows: [], rowCount: 0 };
  }
  throw new Error(`fake pg: unexpected query: ${sql}`);
}

async function query(text, params = []) {
  const sql = text.replace(/\s+/g, ' ').trim();
  state.queries.push({ sql, params });
  return answer(sql, params);
}

export class Pool {
  async query(text, params) {
    return query(text, params);
  }

  async connect() {
    return { query, release() {} };
  }

  async end() {}
}
