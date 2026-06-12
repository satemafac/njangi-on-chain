#!/usr/bin/env node
// cycle-finalized-notifier.mjs — Phase 7 indexer that watches the
// `CycleFinalized` event stream for a package and fires off a
// njangi-friendly WhatsApp nudge to the scheduled recipient. Stateless
// cursor in a tiny JSON file so restarts don't double-notify.
//
// Designed to run from a cron worker, a Heroku one-off, or as a
// long-running npm script:
//
//   NETWORK=testnet \
//   PACKAGE_ID=0x… \
//   NOTIFY_ENDPOINT=https://njangionchain.com/api/whatsapp/notify/your-turn \
//   INTERNAL_NOTIFY_SECRET=… \
//   node scripts/cycle-finalized-notifier.mjs
//
// Behavior:
//   - Queries the latest CycleFinalized events (descending, max 50 per poll).
//   - Writes the latest processed cursor to `.cycle-finalized-cursor.json`
//     so restarts resume instead of re-notifying.
//   - For each new event, POSTs the circle id + cycle number + recipient
//     address + human-friendly amount to the notify endpoint.
//   - Polls every POLL_INTERVAL_MS (default 60s). Exits non-zero on fatal
//     RPC errors so an external supervisor can restart.

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import pg from 'pg';

const NETWORK = (process.env.NETWORK ?? 'testnet').toLowerCase();
const PACKAGE_ID = process.env.PACKAGE_ID;
const NOTIFY_ENDPOINT = process.env.NOTIFY_ENDPOINT;
const INTERNAL_NOTIFY_SECRET = process.env.INTERNAL_NOTIFY_SECRET;
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 60000);
const RPC_URL =
  process.env.SUI_RPC_URL ??
  (NETWORK === 'mainnet'
    ? 'https://fullnode.mainnet.sui.io:443'
    : 'https://fullnode.testnet.sui.io:443');
const CURSOR_FILE = path.resolve(process.cwd(), '.cycle-finalized-cursor.json');
const COIN_DECIMALS = Number(process.env.COIN_DECIMALS ?? 9);
const COIN_SYMBOL = process.env.COIN_SYMBOL ?? 'SUI';

function die(message) {
  console.error(`[notifier] ${message}`);
  process.exit(1);
}

if (!PACKAGE_ID) die('PACKAGE_ID is required.');
if (!NOTIFY_ENDPOINT) die('NOTIFY_ENDPOINT is required.');
if (!INTERNAL_NOTIFY_SECRET) die('INTERNAL_NOTIFY_SECRET is required.');

function formatAmount(baseUnits) {
  try {
    const v = BigInt(baseUnits);
    if (v === 0n) return `0 ${COIN_SYMBOL}`;
    const divisor = 10n ** BigInt(COIN_DECIMALS);
    const whole = v / divisor;
    const frac = v % divisor;
    if (frac === 0n) return `${whole.toString()} ${COIN_SYMBOL}`;
    const fracStr = frac.toString().padStart(COIN_DECIMALS, '0').replace(/0+$/, '');
    return `${whole.toString()}.${fracStr} ${COIN_SYMBOL}`;
  } catch {
    return `${String(baseUnits)} ${COIN_SYMBOL}`;
  }
}

const DATABASE_URL = process.env.DATABASE_URL;
const CURSOR_KEY = `${PACKAGE_ID}:${NETWORK}`;
let pgPool = null;
let cursorTableReady = null;

// Phase 10: when DATABASE_URL is set we persist the notifier cursor in
// Postgres so multiple worker instances can run without double-notifying
// (either via Heroku `ps:scale notifier=N` or a separate rescue worker
// during an incident). We fall back to the original JSON file when no
// Postgres connection string is provided so local dev stays simple.

function getPgPool() {
  if (!DATABASE_URL) return null;
  if (!pgPool) {
    pgPool = new pg.Pool({
      connectionString: DATABASE_URL,
      ssl: DATABASE_URL.includes('amazonaws.com')
        ? { rejectUnauthorized: false }
        : undefined,
    });
  }
  return pgPool;
}

async function ensureCursorTable() {
  const pool = getPgPool();
  if (!pool) return;
  if (!cursorTableReady) {
    cursorTableReady = pool.query(
      `CREATE TABLE IF NOT EXISTS cycle_finalized_cursor (
         key TEXT PRIMARY KEY,
         cursor JSONB,
         updated_at TIMESTAMPTZ DEFAULT NOW()
       )`,
    );
  }
  await cursorTableReady;
}

async function loadCursor() {
  const pool = getPgPool();
  if (pool) {
    try {
      await ensureCursorTable();
      const { rows } = await pool.query(
        'SELECT cursor FROM cycle_finalized_cursor WHERE key = $1',
        [CURSOR_KEY],
      );
      return rows[0]?.cursor ?? null;
    } catch (err) {
      console.warn('[notifier] Postgres cursor load failed; falling back to file.', err);
    }
  }
  if (!existsSync(CURSOR_FILE)) return null;
  try {
    const raw = await readFile(CURSOR_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.warn('[notifier] Failed to read cursor file; starting fresh.', err);
    return null;
  }
}

async function saveCursor(cursor) {
  if (!cursor) return;
  const pool = getPgPool();
  if (pool) {
    try {
      await ensureCursorTable();
      await pool.query(
        `INSERT INTO cycle_finalized_cursor (key, cursor, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE
           SET cursor = EXCLUDED.cursor, updated_at = NOW()`,
        [CURSOR_KEY, cursor],
      );
      return;
    } catch (err) {
      console.warn('[notifier] Postgres cursor save failed; falling back to file.', err);
    }
  }
  try {
    await writeFile(CURSOR_FILE, JSON.stringify(cursor, null, 2), 'utf8');
  } catch (err) {
    console.warn('[notifier] Failed to persist cursor.', err);
  }
}

async function queryCycleFinalized(cursor) {
  const response = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'suix_queryEvents',
      params: [
        {
          MoveEventType: `${PACKAGE_ID}::njangi_cycle_escrow::CycleFinalized`,
        },
        cursor ?? null,
        50,
        false,
      ],
    }),
  });
  if (!response.ok) {
    throw new Error(`Sui RPC failed: ${response.status}`);
  }
  const json = await response.json();
  if (json.error) {
    throw new Error(`Sui RPC error: ${json.error.message ?? JSON.stringify(json.error)}`);
  }
  return json.result;
}

async function sendNotification(event) {
  const payload = event.parsedJson ?? {};
  const circleId = payload.circle_id;
  const cycleNo = Number(payload.cycle_no ?? 0);
  const recipient = payload.recipient;
  const amount = formatAmount(payload.amount ?? '0');

  if (!circleId || !recipient) {
    console.warn('[notifier] Skipping malformed event', payload);
    return;
  }

  const response = await fetch(NOTIFY_ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-auth': INTERNAL_NOTIFY_SECRET,
    },
    body: JSON.stringify({
      circleId,
      cycleNo,
      amount,
      network: NETWORK,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '<no body>');
    console.warn(`[notifier] notify endpoint returned ${response.status}: ${body}`);
    return;
  }
  console.log(`[notifier] nudged recipient for circle ${circleId} cycle ${cycleNo}`);
}

async function pollOnce() {
  const cursor = await loadCursor();
  const result = await queryCycleFinalized(cursor);
  const events = Array.isArray(result?.data) ? result.data : [];
  if (events.length === 0) return;

  // Events arrive descending (newest first). Process oldest-first so the
  // cursor we persist is the newest.
  const ordered = [...events].reverse();
  for (const event of ordered) {
    try {
      await sendNotification(event);
    } catch (err) {
      console.warn('[notifier] send failed', err);
    }
  }

  const newest = events[0];
  if (newest?.id) {
    await saveCursor(newest.id);
  }
}

async function main() {
  console.log(
    `[notifier] watching ${PACKAGE_ID}::njangi_cycle_escrow::CycleFinalized on ${NETWORK} (${RPC_URL})`,
  );
  while (true) {
    try {
      await pollOnce();
    } catch (err) {
      console.error('[notifier] poll failed', err);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

main().catch((err) => {
  console.error('[notifier] fatal', err);
  process.exit(1);
});
