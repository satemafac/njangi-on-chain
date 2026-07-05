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
//   5b. walrus_renewal_audit          (src/lib/whatsapp-link-index.ts)
//   6. compliance_attestation_queue   (src/lib/attestation-queue.ts)
//   7. whatsapp_notifications         (src/lib/whatsapp-notifier.ts)
//   8. cycle_finalized_cursor         (src/lib/cycle-finalized-cron.ts)
//   9. zklogin_sessions               (src/lib/zklogin-session-registry.ts)
//  10. rate_limits                    (src/lib/rate-limit.ts)
//  11. webhook_events                 (src/lib/webhook-dedupe.ts)
//  12. subscriptions                  (src/services/stripe-service.ts)
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
    // walrus_end_epoch: storage lease end epoch so /api/cron/walrus-renewal
    // knows when to re-store a PII blob before it expires (the on-chain
    // anchor referencing it never expires). The ALTER backfills tables
    // created before the column existed; NULL means "expiry unknown" and the
    // renewal cron renews once to learn the real value from the re-store.
    name: 'whatsapp_phone_index',
    sql: `CREATE TABLE IF NOT EXISTS whatsapp_phone_index (
            id SERIAL PRIMARY KEY,
            phone_hmac TEXT NOT NULL,
            circle_id TEXT NOT NULL,
            walrus_blob_id TEXT NOT NULL,
            link_type SMALLINT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            walrus_end_epoch BIGINT,
            UNIQUE (phone_hmac, circle_id)
          );
          ALTER TABLE whatsapp_phone_index
            ADD COLUMN IF NOT EXISTS walrus_end_epoch BIGINT;
          CREATE INDEX IF NOT EXISTS whatsapp_phone_index_hmac_idx
            ON whatsapp_phone_index (phone_hmac);`,
  },
  {
    // Append-only audit trail for the Walrus PII blob renewal cron
    // (src/lib/whatsapp-link-index.ts applyWalrusRenewal). One row per
    // blob actually re-stored: old/new blob id + old/new storage end epoch.
    // The row is written in the same transaction as the index UPDATE, so
    // the log never claims a renewal that did not land.
    name: 'walrus_renewal_audit',
    sql: `CREATE TABLE IF NOT EXISTS walrus_renewal_audit (
            id BIGSERIAL PRIMARY KEY,
            index_row_id INTEGER NOT NULL,
            circle_id TEXT NOT NULL,
            old_blob_id TEXT NOT NULL,
            new_blob_id TEXT NOT NULL,
            old_end_epoch BIGINT,
            new_end_epoch BIGINT,
            renewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
          CREATE INDEX IF NOT EXISTS walrus_renewal_audit_circle_idx
            ON walrus_renewal_audit (circle_id, renewed_at DESC);`,
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
  {
    // Stripe subscription billing (June 2026). One row per zkLogin identity
    // (sub, aud) — the same root key as the `salts` table — with the derived
    // Sui address alongside for feature gates that key off addresses.
    // Stripe webhook idempotency reuses the shared `webhook_events` table
    // above (provider = 'stripe' via src/lib/webhook-dedupe.ts); no separate
    // stripe_webhook_events table.
    name: 'subscriptions',
    sql: `CREATE TABLE IF NOT EXISTS subscriptions (
            id SERIAL PRIMARY KEY,
            sub TEXT NOT NULL,
            aud TEXT NOT NULL,
            user_address TEXT NOT NULL,
            stripe_customer_id TEXT NOT NULL UNIQUE,
            stripe_subscription_id TEXT UNIQUE,
            price_id TEXT,
            plan TEXT NOT NULL DEFAULT 'free',
            status TEXT NOT NULL,
            current_period_end TIMESTAMPTZ,
            cancel_at_period_end BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (sub, aud)
          );
          CREATE INDEX IF NOT EXISTS subscriptions_user_address_idx
            ON subscriptions (user_address);
          CREATE INDEX IF NOT EXISTS subscriptions_status_idx
            ON subscriptions (status);`,
  },
  {
    // Data-deletion requests (June 2026 legal surface). Written by
    // src/pages/api/legal/data-deletion-request.ts; processed manually by
    // ops per the Privacy Policy Section 9. ip_hash is HMAC-SHA256 of the
    // client IP keyed with LEGAL_ACCEPT_IP_SALT — never the raw IP. The
    // partial unique index keeps duplicate POSTs to one pending row per
    // email while preserving history of completed/rejected requests.
    name: 'deletion_requests',
    sql: `CREATE TABLE IF NOT EXISTS deletion_requests (
            id BIGSERIAL PRIMARY KEY,
            email TEXT NOT NULL,
            user_address TEXT,
            details TEXT,
            locale TEXT NOT NULL DEFAULT 'en' CHECK (locale IN ('en','fr')),
            status TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending','processing','completed','rejected')),
            ip_hash TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
          CREATE UNIQUE INDEX IF NOT EXISTS deletion_requests_pending_email_idx
            ON deletion_requests (email) WHERE status = 'pending';
          CREATE INDEX IF NOT EXISTS deletion_requests_status_idx
            ON deletion_requests (status, created_at);`,
  },
  {
    // Legal acceptance gate (June 2026 legal surface; spec:
    // docs/legal-drafts/ACCEPTANCE-GATE-SPEC.md "Storage"). Append-only
    // consent records written by src/pages/api/legal/accept.ts via
    // src/lib/legal-acceptance-server.ts. Keyed on (sub, aud) — the same
    // durable identity as the `salts` table; user_address is audit-only.
    // Versions are server-resolved from CURRENT_LEGAL_VERSIONS; a version
    // bump inserts a new row (never UPDATE/DELETE — rows are retained as
    // consent/defense-of-claims records even on PII-deletion requests).
    // ip_hash is HMAC-SHA256(ip, LEGAL_ACCEPT_IP_SALT), never the raw IP.
    name: 'legal_acceptances',
    sql: `CREATE TABLE IF NOT EXISTS legal_acceptances (
            id            BIGSERIAL PRIMARY KEY,
            sub           TEXT NOT NULL,
            aud           TEXT NOT NULL,
            user_address  TEXT NOT NULL,
            doc           TEXT NOT NULL CHECK (doc IN ('terms','privacy','risk')),
            version       TEXT NOT NULL,
            locale        TEXT NOT NULL DEFAULT 'en' CHECK (locale IN ('en','fr')),
            accepted_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            ip_hash       TEXT
          );
          CREATE UNIQUE INDEX IF NOT EXISTS legal_acceptances_unique
            ON legal_acceptances (sub, aud, doc, version);
          CREATE INDEX IF NOT EXISTS legal_acceptances_address_idx
            ON legal_acceptances (user_address);`,
  },
  {
    // Enoki gas-sponsorship metering (src/lib/gas-sponsorship.ts). One row per
    // successfully sponsored transaction, used to enforce the per-user daily
    // and global monthly fair-use caps that bound sponsored gas spend. Keyed on
    // tx_digest so a retried record insert is idempotent. Sponsorship is a
    // Premium-admin benefit; free-tier circles self-pay gas and never appear
    // here. Purely a cost guard — the Enoki portal budget is the hard backstop.
    name: 'gas_sponsorship_usage',
    sql: `CREATE TABLE IF NOT EXISTS gas_sponsorship_usage (
            id            BIGSERIAL PRIMARY KEY,
            zklogin_sub   TEXT NOT NULL,
            user_address  TEXT NOT NULL,
            circle_id     TEXT,
            action        TEXT NOT NULL,
            tx_digest     TEXT NOT NULL UNIQUE,
            sponsored_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
          CREATE INDEX IF NOT EXISTS gas_sponsorship_usage_user_recent_idx
            ON gas_sponsorship_usage (zklogin_sub, sponsored_at DESC);
          CREATE INDEX IF NOT EXISTS gas_sponsorship_usage_month_idx
            ON gas_sponsorship_usage (sponsored_at);`,
  },
  {
    // GDPR deletion pipeline: the executor (scripts/
    // process-deletion-request.mjs) records the HMAC of the requester's
    // WhatsApp number on the request row, which (a) documents what was
    // erased and (b) lets the walrus-renewal query exclude any index row
    // matching a completed deletion — so a stale re-index can never
    // resurrect a deleted user's blob renewals.
    name: 'deletion_requests_phone_hmac',
    sql: `ALTER TABLE deletion_requests
            ADD COLUMN IF NOT EXISTS phone_hmac TEXT;
          CREATE INDEX IF NOT EXISTS deletion_requests_phone_hmac_idx
            ON deletion_requests (phone_hmac)
            WHERE phone_hmac IS NOT NULL;`,
  },
  {
    // OFAC sanctions program (docs/sanctions-program.md): cached SDN
    // digital-currency address set, refreshed weekly by
    // /api/cron/sanctions-refresh. address is normalized lowercase;
    // address_original keeps OFAC's verbatim casing for evidence fidelity.
    name: 'sanctioned_addresses',
    sql: `CREATE TABLE IF NOT EXISTS sanctioned_addresses (
            address          TEXT PRIMARY KEY,
            address_original TEXT NOT NULL,
            ticker           TEXT NOT NULL,
            list_version     TEXT NOT NULL,
            first_seen       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            last_seen        TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
          CREATE INDEX IF NOT EXISTS sanctioned_addresses_version_idx
            ON sanctioned_addresses (list_version);`,
  },
  {
    name: 'sanctions_list_meta',
    sql: `CREATE TABLE IF NOT EXISTS sanctions_list_meta (
            id            INTEGER PRIMARY KEY CHECK (id = 1),
            list_version  TEXT NOT NULL,
            source_url    TEXT NOT NULL,
            address_count INTEGER NOT NULL,
            refreshed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );`,
  },
  {
    // Screening audit trail — the evidence the program runs. Contexts:
    // circle_create / circle_join / whatsapp_link / client_preflight /
    // retro_sweep; results: pass / blocked / error_fail_open.
    name: 'sanctions_screen_log',
    sql: `CREATE TABLE IF NOT EXISTS sanctions_screen_log (
            id           BIGSERIAL PRIMARY KEY,
            address      TEXT NOT NULL,
            context      TEXT NOT NULL,
            result       TEXT NOT NULL,
            list_version TEXT,
            created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
          CREATE INDEX IF NOT EXISTS sanctions_screen_log_created_idx
            ON sanctions_screen_log (created_at);
          CREATE INDEX IF NOT EXISTS sanctions_screen_log_address_idx
            ON sanctions_screen_log (address);`,
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
