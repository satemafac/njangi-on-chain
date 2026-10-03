// Stands in for `pg` when src/__tests__/scripts/process-deletion-request.test.ts
// runs scripts/process-deletion-request.mjs, so the real script runs end to
// end without a database. fake-pg-hooks.mjs points the script's
// `import { Pool } from 'pg'` here.
//
// FAKE_PG_STATE names a JSON file holding { request, index }: one
// deletion_requests row and the whatsapp_phone_index rows as
// [{ phone_hmac, circle_id }]. The fake answers the script's queries from
// it, applies its writes, and when the process exits (process.exit included)
// writes the result back with every query it received under `queries`. A
// query it does not recognise throws, so a change to the script's SQL fails
// the test instead of passing unchecked.
import { readFileSync, writeFileSync } from 'node:fs';

const statePath = process.env.FAKE_PG_STATE;
const state = { ...JSON.parse(readFileSync(statePath, 'utf8')), queries: [] };
process.on('exit', () => writeFileSync(statePath, JSON.stringify(state)));

const sameId = (a, b) => String(a) === String(b);

function answer(sql, params) {
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

export class Pool {
  async query(text, params = []) {
    const sql = text.replace(/\s+/g, ' ').trim();
    state.queries.push({ sql, params });
    return answer(sql, params);
  }

  async end() {}
}
