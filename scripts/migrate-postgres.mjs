#!/usr/bin/env node
// migrate-postgres.mjs — Idempotent creator for every Postgres table the
// app uses. Each statement is `CREATE TABLE IF NOT EXISTS` (or unique
// `CREATE INDEX IF NOT EXISTS`), so re-runs are safe.
//
// Tables consolidated here:
//   1. salts                          (src/services/postgres-adapter.ts)
//   2. recovery_codes                 (src/services/postgres-adapter.ts)
//   3. join_requests                  (src/services/database-service.ts)
//   4. mainnet_signups                (src/services/mainnet-signup-database.ts)
//   5. whatsapp_phone_index           (src/lib/whatsapp-link-index.ts)
//   6. compliance_attestation_queue   (src/lib/attestation-queue.ts)
//   7. whatsapp_notifications         (src/lib/whatsapp-notifier.ts)
//   8. cycle_finalized_cursor         (src/lib/cycle-finalized-cron.ts)
//   9. zklogin_sessions               (src/lib/zklogin-session-registry.ts)
//  10. rate_limits                    (src/lib/rate-limit.ts)
//  11. webhook_events                 (src/lib/webhook-dedupe.ts)
//
// Phase 12 publish-readiness: replaces the old transactional migration
// that only knew about `join_requests` + `mainnet_signups`. Keeps every
// table in one place so a fresh deploy doesn't depend on each service
// to lazy-init its own schema before the first request races them.
//
// Tables 9-11 were added for the Vercel serverless migration (June 2026):
// per-process state (zkLogin sessions, rate-limit windows, webhook dedupe
// caches) moved into Postgres so any lambda instance sees the same state.
//
// Usage:
//   DATABASE_URL=postgres://... node scripts/migrate-postgres.mjs
//   or: npm run migrate:postgres

import process from 'node:process';
import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('[migrate] DATABASE_URL is not set; aborting.');
  process.exit(1);
}

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

const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: resolveSsl(DATABASE_URL),
});

// Each entry runs as its own statement so a single failure (e.g. a
// table that already exists with different columns) doesn't block the
// rest. Names are used for the per-table log line.
const STATEMENTS = [
  {
    name: 'salts',
    sql: `CREATE TABLE IF NOT EXISTS salts (
            id SERIAL PRIMARY KEY,
            sub TEXT NOT NULL,
            aud TEXT NOT NULL,
            salt_encrypted BYTEA NOT NULL,
            iv BYTEA NOT NULL,
            tag BYTEA NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (sub, aud)
          );`,
  },
  {
    name: 'recovery_codes',
    sql: `CREATE TABLE IF NOT EXISTS recovery_codes (
            id SERIAL PRIMARY KEY,
            salt_id INTEGER NOT NULL,
            code_hash TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            used_at TIMESTAMP,
            CONSTRAINT fk_salt
              FOREIGN KEY (salt_id) REFERENCES salts(id)
          );`,
  },
  {
    name: 'join_requests',
    sql: `CREATE TABLE IF NOT EXISTS join_requests (
            id SERIAL PRIMARY KEY,
            circle_id TEXT NOT NULL,
            circle_name TEXT NOT NULL,
            user_address TEXT NOT NULL,
            user_name TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'rejected')) DEFAULT 'pending',
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (circle_id, user_address)
          );
          CREATE INDEX IF NOT EXISTS idx_join_requests_circle_id ON join_requests(circle_id);
          CREATE INDEX IF NOT EXISTS idx_join_requests_user_address ON join_requests(user_address);
          CREATE INDEX IF NOT EXISTS idx_join_requests_status ON join_requests(status);`,
  },
  {
    name: 'mainnet_signups',
    sql: `CREATE TABLE IF NOT EXISTS mainnet_signups (
            id SERIAL PRIMARY KEY,
            email TEXT NOT NULL UNIQUE,
            name TEXT,
            user_address TEXT,
            notification_preferences JSONB DEFAULT '{"email": true, "sms": false}',
            signup_source TEXT DEFAULT 'homepage',
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
          );
          CREATE INDEX IF NOT EXISTS idx_mainnet_signups_email ON mainnet_signups(email);
          CREATE INDEX IF NOT EXISTS idx_mainnet_signups_created_at ON mainnet_signups(created_at);
          CREATE INDEX IF NOT EXISTS idx_mainnet_signups_user_address ON mainnet_signups(user_address);`,
  },
  {
    name: 'whatsapp_phone_index',
    sql: `CREATE TABLE IF NOT EXISTS whatsapp_phone_index (
            id SERIAL PRIMARY KEY,
            phone_hmac TEXT NOT NULL,
            circle_id TEXT NOT NULL,
            walrus_blob_id TEXT NOT NULL,
            link_type SMALLINT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (phone_hmac, circle_id)
          );
          CREATE INDEX IF NOT EXISTS whatsapp_phone_index_hmac_idx
            ON whatsapp_phone_index (phone_hmac);`,
  },
  {
    name: 'compliance_attestation_queue',
    sql: `CREATE TABLE IF NOT EXISTS compliance_attestation_queue (
            id TEXT PRIMARY KEY,
            network TEXT NOT NULL,
            subject TEXT NOT NULL,
            provider_case_id TEXT NOT NULL,
            provider_case_preview TEXT NOT NULL,
            provider_case_hmac TEXT NOT NULL,
            policy JSONB NOT NULL,
            ttl_ms BIGINT NOT NULL,
            queued_at BIGINT NOT NULL,
            status TEXT NOT NULL,
            issued_tx_digest TEXT
          );
          CREATE INDEX IF NOT EXISTS compliance_attestation_queue_status_idx
            ON compliance_attestation_queue (status, queued_at);
          CREATE UNIQUE INDEX IF NOT EXISTS compliance_attestation_queue_dedupe_idx
            ON compliance_attestation_queue (network, subject, provider_case_hmac)
            WHERE status = 'pending';`,
  },
  {
    name: 'whatsapp_notifications',
    sql: `CREATE TABLE IF NOT EXISTS whatsapp_notifications (
            id BIGSERIAL PRIMARY KEY,
            kind TEXT NOT NULL,
            target_address TEXT NOT NULL,
            dedupe_key TEXT NOT NULL,
            sent_at TIMESTAMPTZ DEFAULT NOW(),
            success BOOLEAN NOT NULL,
            error TEXT,
            UNIQUE (kind, target_address, dedupe_key)
          );
          CREATE INDEX IF NOT EXISTS whatsapp_notifications_recent_idx
            ON whatsapp_notifications (target_address, sent_at DESC);`,
  },
  {
    // locked_until/locked_by: per-(package, network) run lease + fencing
    // token for the Vercel cron (src/lib/cycle-finalized-cron.ts) so
    // overlapping invocations skip instead of double-sending. The ALTERs
    // upgrade tables created before the lease columns existed.
    name: 'cycle_finalized_cursor',
    sql: `CREATE TABLE IF NOT EXISTS cycle_finalized_cursor (
            key TEXT PRIMARY KEY,
            cursor JSONB,
            updated_at TIMESTAMPTZ DEFAULT NOW(),
            locked_until TIMESTAMPTZ,
            locked_by TEXT
          );
          ALTER TABLE cycle_finalized_cursor
            ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;
          ALTER TABLE cycle_finalized_cursor
            ADD COLUMN IF NOT EXISTS locked_by TEXT;`,
  },
  {
    name: 'zklogin_sessions',
    sql: `CREATE TABLE IF NOT EXISTS zklogin_sessions (
            id TEXT PRIMARY KEY,
            session_ciphertext TEXT NOT NULL,
            sub TEXT,
            aud TEXT,
            user_address TEXT,
            max_epoch BIGINT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            expires_at TIMESTAMPTZ NOT NULL
          );
          CREATE INDEX IF NOT EXISTS zklogin_sessions_user_idx
            ON zklogin_sessions (user_address);
          CREATE INDEX IF NOT EXISTS zklogin_sessions_expires_idx
            ON zklogin_sessions (expires_at);`,
  },
  {
    name: 'rate_limits',
    sql: `CREATE TABLE IF NOT EXISTS rate_limits (
            bucket TEXT NOT NULL,
            window_start TIMESTAMPTZ NOT NULL,
            count INTEGER NOT NULL,
            PRIMARY KEY (bucket, window_start)
          );`,
  },
  {
    name: 'webhook_events',
    sql: `CREATE TABLE IF NOT EXISTS webhook_events (
            id BIGSERIAL PRIMARY KEY,
            provider TEXT NOT NULL,
            event_id TEXT NOT NULL,
            received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (provider, event_id)
          );
          CREATE INDEX IF NOT EXISTS webhook_events_received_idx
            ON webhook_events (received_at);`,
  },
];

async function main() {
  const masked = DATABASE_URL.replace(/:[^@/]+@/, ':***@');
  console.log(`[migrate] target: ${masked}`);
  let failed = 0;
  for (const stmt of STATEMENTS) {
    try {
      await pool.query(stmt.sql);
      console.log(`[migrate] ✓ ${stmt.name}`);
    } catch (err) {
      failed += 1;
      console.error(
        `[migrate] ✗ ${stmt.name}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
  await pool.end();
  if (failed > 0) {
    console.error(`[migrate] failed: ${failed}/${STATEMENTS.length}`);
    process.exit(1);
  }
  console.log(`[migrate] all ${STATEMENTS.length} migrations applied`);
}

main().catch((err) => {
  console.error('[migrate] fatal', err);
  process.exit(1);
});
