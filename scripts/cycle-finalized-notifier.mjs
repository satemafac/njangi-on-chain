#!/usr/bin/env node
// cycle-finalized-notifier.mjs — DEPRECATED (June 2026 Vercel migration).
//
// Production now runs this logic as a Vercel cron:
//   src/pages/api/cron/cycle-finalized.ts  (every minute, CRON_SECRET auth)
// with the core drain/cursor logic in src/lib/cycle-finalized-cron.ts and
// the Postgres `cycle_finalized_cursor` table as the only durable cursor
// store. This script is kept ONLY for local development against a dev
// server (`npm run notifier:cycle-finalized`); do not deploy it as a
// worker process. New behavior changes belong in the cron route + lib.
//
// Legacy description: Phase 7 indexer that watches the `CycleFinalized`
// event stream for a package and fires off a njangi-friendly WhatsApp
// nudge to the scheduled recipient.
//
//   NETWORK=testnet \
//   PACKAGE_ID=0x… \
//   NOTIFY_ENDPOINT=http://localhost:3000/api/whatsapp/notify/your-turn \
//   INTERNAL_NOTIFY_SECRET=… \
//   node scripts/cycle-finalized-notifier.mjs
//
// Behavior:
//   - Queries CycleFinalized events ascending (oldest first, max 50 per
//     page) and follows nextCursor until the backlog is drained.
//   - Persists the NEWEST processed cursor (Postgres when DATABASE_URL is
//     set, else `.cycle-finalized-cursor.json`) so restarts resume instead
//     of re-notifying. (June 2026 audit fix: the old code persisted the
//     oldest event of each batch and crawled one event per poll.)
//   - For each new event, POSTs escrow/circle id + cycle number +
//     recipient address + human-friendly amount to the notify endpoint.
//     (June 2026 audit fix: `recipient` was omitted, so every nudge
//     silently no-oped; and the on-chain event has `escrow_id`, not
//     `circle_id`, so every event was dropped as malformed.)
//   - Polls every POLL_INTERVAL_MS (default 60s). Exits non-zero on fatal
//     RPC errors so an external supervisor can restart.
//
// NOTE: PACKAGE_ID must be the package id that DEFINES njangi_cycle_escrow
// (the original publish id from move/Published.toml), not the latest
// upgrade id — Sui event type tags use the defining package id.

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

if (process.env.NODE_ENV === 'production') {
  die(
    'This worker is dev-only since the Vercel migration. Production uses ' +
      'the /api/cron/cycle-finalized route, whose cursor writes are fenced ' +
      'by a run lease this script does not participate in.',
  );
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
// ':dev' suffix keeps this script's cursor row disjoint from the
// production cron's lease-fenced row — a dev run pointed at the shared DB
// must never advance or regress the cron's cursor underneath the fence.
const CURSOR_KEY = `${PACKAGE_ID}:${NETWORK}:dev`;
let pgPool = null;
let cursorTableReady = null;

// Phase 10: when DATABASE_URL is set we persist the notifier cursor in
// Postgres so multiple worker instances can run without double-notifying
// (either via Heroku `ps:scale notifier=N` or a separate rescue worker
// during an incident). We fall back to the original JSON file when no
// Postgres connection string is provided so local dev stays simple.

// SSL: sslmode from the URL (Neon carries sslmode=require) or PGSSLMODE
// wins; production defaults to verified TLS. Mirrors src/lib/pg-pool.ts.
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
  if (connectionString.includes('amazonaws.com')) return { rejectUnauthorized: false };
  return undefined;
}

function getPgPool() {
  if (!DATABASE_URL) return null;
  if (!pgPool) {
    pgPool = new pg.Pool({
      connectionString: DATABASE_URL,
      ssl: resolveSsl(DATABASE_URL),
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
        false, // descending_order=false → ascending (oldest first)
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
  // The on-chain CycleFinalized event carries escrow_id (no circle_id).
  // The cron route resolves the parent circle from the escrow object; this
  // dev script just uses the escrow id for the message/dedupe scope.
  const circleId = payload.circle_id ?? payload.escrow_id;
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
      // June 2026 audit fix: the recipient address was omitted, so the
      // endpoint fell back to looking up a WhatsApp link for the circle
      // id and every nudge silently no-oped.
      recipient,
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

const MAX_PAGES_PER_POLL = 20;

async function pollOnce() {
  let cursor = await loadCursor();

  // Events arrive ascending (oldest first). Drain page by page, persisting
  // the NEWEST processed cursor after each page so a crash resumes instead
  // of re-notifying from the start of the batch.
  for (let page = 0; page < MAX_PAGES_PER_POLL; page += 1) {
    const result = await queryCycleFinalized(cursor);
    const events = Array.isArray(result?.data) ? result.data : [];
    if (events.length === 0) return;

    for (const event of events) {
      try {
        await sendNotification(event);
      } catch (err) {
        console.warn('[notifier] send failed', err);
      }
    }

    const newest = result?.nextCursor ?? events[events.length - 1]?.id ?? null;
    if (newest) {
      await saveCursor(newest);
      cursor = newest;
    }
    if (!result?.hasNextPage) return;
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
