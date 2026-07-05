#!/usr/bin/env node
// process-deletion-request.mjs — GDPR deletion executor
// (docs/compliance-roadmap-cex-dex-non-kyc.md §A4).
//
// /api/legal/data-deletion-request only RECORDS requests; this script is
// the operator-run step that actually erases. What it deletes:
//   - whatsapp_phone_index rows for the requester's phone (stops the
//     walrus-renewal cron from renewing their encrypted blobs, which then
//     expire on-network; the lookup pointer is gone immediately)
//   - join_requests rows for the wallet address
//   - zklogin_sessions rows for the wallet address
//   - salts + recovery_codes for the OAuth identity (resolved from the
//     address via zklogin_sessions when possible, or passed explicitly)
//     — WARNING: deleting the salt makes the wallet UNRECOVERABLE via
//     social login; the public deletion form warns the requester.
// What it deliberately RETAINS (legal hold, documented in the privacy
// policy): legal_acceptances (append-only), Stripe billing records
// (live in Stripe), walrus_renewal_audit (append-only audit log), and
// anything on-chain (permanent by design).
//
// Usage:
//   node scripts/process-deletion-request.mjs --request-id 7 \
//     [--phone +2376XXXXXXX] [--address 0x...] [--sub ... --aud ...] [--dry-run]
//
// --phone is how WhatsApp rows are found (the form's free-text details
// usually carries it). Requires WALRUS_LOOKUP_SALT (same HMAC as
// src/lib/walrus-pii.ts computeLookupHash). Safe to re-run: every DELETE
// is idempotent and the request row is only marked completed at the end.

import { createHmac } from 'node:crypto';
import { Pool } from 'pg';

function arg(name) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}
const DRY_RUN = process.argv.includes('--dry-run');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('[deletion] DATABASE_URL is required');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('sslmode=require') ? { rejectUnauthorized: false } : undefined,
});

async function run(label, sql, params) {
  if (DRY_RUN) {
    console.log(`[dry-run] ${label}`);
    return { rowCount: 0 };
  }
  const result = await pool.query(sql, params);
  console.log(`[deletion] ${label}: ${result.rowCount ?? 0} row(s)`);
  return result;
}

async function main() {
  const requestId = arg('request-id');
  const email = arg('email');
  if (!requestId && !email) {
    console.error('[deletion] pass --request-id <id> or --email <email>');
    process.exit(1);
  }

  const requestLookup = requestId
    ? await pool.query(`SELECT * FROM deletion_requests WHERE id = $1`, [requestId])
    : await pool.query(
        `SELECT * FROM deletion_requests WHERE email = $1 ORDER BY created_at DESC LIMIT 1`,
        [email],
      );
  const request = requestLookup.rows[0];
  if (!request) {
    console.error('[deletion] no matching deletion_requests row');
    process.exit(1);
  }
  console.log(
    `[deletion] request #${request.id} (${request.email}) status=${request.status} created=${request.created_at?.toISOString?.() ?? request.created_at}`,
  );

  const address = (arg('address') || request.user_address || '').trim().toLowerCase() || null;
  const phone = arg('phone')?.trim() || null;
  let sub = arg('sub') || null;
  let aud = arg('aud') || null;

  // 1. WhatsApp index rows (stops blob renewal; pointer gone immediately).
  let phoneHmac = null;
  if (phone) {
    const salt = process.env.WALRUS_LOOKUP_SALT;
    if (!salt) {
      console.error('[deletion] WALRUS_LOOKUP_SALT required to target WhatsApp rows');
      process.exit(1);
    }
    phoneHmac = createHmac('sha256', salt).update(phone).digest('hex');
    await run(
      'whatsapp_phone_index rows for phone',
      `DELETE FROM whatsapp_phone_index WHERE phone_hmac = $1`,
      [phoneHmac],
    );
    // Recorded on the request row so listActiveLinksForRenewal() can
    // permanently exclude this phone even if something re-indexes it.
    await run(
      'record phone_hmac on request',
      `UPDATE deletion_requests SET phone_hmac = $1, updated_at = NOW() WHERE id = $2`,
      [phoneHmac, request.id],
    );
  } else {
    console.log('[deletion] no --phone given — skipping whatsapp_phone_index (nothing to match on)');
  }

  if (address) {
    // 2. Resolve OAuth identity from live sessions BEFORE deleting them.
    if (!sub || !aud) {
      const identity = await pool.query(
        `SELECT sub, aud FROM zklogin_sessions
          WHERE LOWER(user_address) = $1 AND sub IS NOT NULL AND aud IS NOT NULL
          LIMIT 1`,
        [address],
      );
      if (identity.rows[0]) {
        sub = sub || identity.rows[0].sub;
        aud = aud || identity.rows[0].aud;
        console.log('[deletion] resolved OAuth identity from zklogin_sessions');
      }
    }

    await run(
      'join_requests rows for address',
      `DELETE FROM join_requests WHERE LOWER(user_address) = $1`,
      [address],
    );
    await run(
      'zklogin_sessions rows for address',
      `DELETE FROM zklogin_sessions WHERE LOWER(user_address) = $1`,
      [address],
    );
  } else {
    console.log('[deletion] no wallet address on request/flags — skipping address-keyed tables');
  }

  // 3. Salt + recovery codes (makes the wallet unrecoverable — the public
  //    form warned the requester; this is the cryptographic-erasure step).
  if (sub && aud) {
    await run(
      'recovery_codes for identity',
      `DELETE FROM recovery_codes
        WHERE salt_id IN (SELECT id FROM salts WHERE sub = $1 AND aud = $2)`,
      [sub, aud],
    );
    await run('salts for identity', `DELETE FROM salts WHERE sub = $1 AND aud = $2`, [sub, aud]);
  } else {
    console.log('[deletion] OAuth identity unknown (no live session) — salts untouched; re-run with --sub/--aud if the requester provides them');
  }

  // 4. Close out the request.
  await run(
    'mark request completed',
    `UPDATE deletion_requests SET status = 'completed', updated_at = NOW() WHERE id = $1`,
    [request.id],
  );

  console.log(
    `[deletion] done${DRY_RUN ? ' (dry run — nothing written)' : ''}. Retained by design: legal_acceptances, billing (Stripe-side), walrus_renewal_audit, on-chain data.`,
  );
}

main()
  .catch((err) => {
    console.error('[deletion] fatal', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
