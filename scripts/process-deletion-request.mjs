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
//   - legacy salts + recovery_codes rows for the OAuth identity. Nothing
//     has written these since salts moved to Enoki (2025-05-24, 11b5e7b);
//     any rows left over are deleted here. Deleting them does NOT affect
//     wallet access: Enoki supplies the salt at every sign-in.
// What it deliberately RETAINS (legal hold, documented in the privacy
// policy): legal_acceptances (append-only), Stripe billing records
// (live in Stripe), walrus_renewal_audit (append-only audit log), and
// anything on-chain (permanent by design).
//
// IDENTITY SAFETY (why this matters): the deletion endpoint is
// unauthenticated by design, and its `user_address` field is a public
// on-chain value that any visitor can set to a VICTIM's wallet. So this
// script NEVER derives the OAuth identity (sub/aud) from a request's
// address to drive the identity-keyed deletes. The legacy salt/recovery-
// code deletion runs only against a TRUSTED identity:
//   1. the (verified_sub, verified_aud) the endpoint captured from the
//      requester's own zkLogin session at request time (identity_verified),
//      OR
//   2. operator-supplied --sub/--aud together with the explicit
//      --force-unverified-identity flag, which asserts the operator has
//      verified wallet ownership OUT OF BAND (e.g. signed challenge, support
//      ticket). Address-keyed deletes (join_requests, zklogin_sessions) are
//      likewise skipped for unverified requests unless that flag is passed.
// Without either, the legacy salts/recovery_codes delete is refused and
// logged.
//
// Usage:
//   node scripts/process-deletion-request.mjs --request-id 7 \
//     [--phone +2376XXXXXXXX] [--address 0x...] [--sub ... --aud ...] \
//     [--force-unverified-identity] [--dry-run]
//
// --phone is how WhatsApp rows are found (the form's free-text details
// usually carries it). Give it in international form: "+", country code,
// number; spaces, dots and hyphens are fine. Anything else (a national
// number, a "00" prefix, an empty value) is refused before anything is read
// or written. The script hashes the number in the index's own form
// (normalizePhone in scripts/lib/whatsapp-phone.ts, which
// src/lib/whatsapp-link-index.ts uses too) with WALRUS_LOOKUP_SALT, which it
// requires (same HMAC as src/lib/walrus-pii.ts computeLookupHash), and it
// prints how many index rows the number matches, dry run included.
//
// Safe to re-run: every DELETE is idempotent, the request row is only marked
// completed at the end, and a re-run never moves a completed request back to
// processing.
//
// Runs before scripts/lib/whatsapp-phone.ts existed hashed --phone as typed.
// The index never holds the documented form (with its "+") or a spaced one,
// so such runs deleted no whatsapp_phone_index row, and the phone_hmac they
// recorded excludes nothing from blob renewal. Every request that had a
// phone_hmac recorded before the fix is a candidate:
//   SELECT id, status, updated_at FROM deletion_requests
//    WHERE phone_hmac IS NOT NULL ORDER BY id;
// To repair one, re-run it with the same --request-id and --phone. The
// script says when the recorded hash was the "+" form of that number, then
// deletes the rows and replaces the hash.
//
// Needs Node >= 22.18 (it imports scripts/lib/*.ts through Node's type
// stripping); package.json pins 24.x.

import { createHmac } from 'node:crypto';
import { Pool } from 'pg';
import { phoneForErasure } from './lib/whatsapp-phone.ts';

function arg(name) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}
const DRY_RUN = process.argv.includes('--dry-run');
// Explicit operator acknowledgement that wallet ownership was verified
// out-of-band for a request that was NOT submitted from an authenticated
// session. Required before any destructive delete on such requests.
const FORCE_UNVERIFIED = process.argv.includes('--force-unverified-identity');

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

  // --phone is checked before anything is read or written. A --phone that is
  // present but unusable stops the run: skipping it would leave the number's
  // index rows in place and still complete the request.
  const phoneGiven = process.argv.some((a) => a === '--phone' || a.startsWith('--phone='));
  const phone = phoneGiven ? phoneForErasure(arg('phone') ?? '') : null;
  if (phoneGiven && !phone) {
    console.error(
      '[deletion] --phone takes an international number as the next argument: "+", country code, ' +
        'number, 7 to 15 digits in all (e.g. --phone +2376XXXXXXXX; spaces, dots and hyphens are fine). ' +
        'Nothing was read or written.',
    );
    process.exit(1);
  }
  const salt = process.env.WALRUS_LOOKUP_SALT;
  if (phone && !salt) {
    console.error('[deletion] WALRUS_LOOKUP_SALT required to target WhatsApp rows');
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

  // ---------------------------------------------------------------------
  // Establish the TRUSTED identity for destructive work. This is the whole
  // security boundary of the script: a request's client-supplied address is
  // NEVER promoted to an identity on its own.
  // ---------------------------------------------------------------------
  const identityVerified = request.identity_verified === true;
  const argSub = arg('sub') || null;
  const argAud = arg('aud') || null;

  // sub/aud used for the legacy salt/recovery-code delete.
  let sub = null;
  let aud = null;
  if (identityVerified && request.verified_sub && request.verified_aud) {
    // Bound at request time to the requester's own zkLogin session.
    sub = request.verified_sub;
    aud = request.verified_aud;
    console.log('[deletion] identity: server-verified at request time (identity_verified=true)');
  } else if (FORCE_UNVERIFIED && argSub && argAud) {
    // Operator asserts out-of-band ownership verification.
    sub = argSub;
    aud = argAud;
    console.warn(
      '[deletion] identity: OPERATOR-FORCED via --force-unverified-identity + --sub/--aud. ' +
        'Ensure wallet ownership was verified out-of-band before continuing.',
    );
  } else {
    console.warn(
      '[deletion] identity: NONE trusted. Request was not submitted from an authenticated ' +
        'session and no --force-unverified-identity + --sub/--aud override was given. ' +
        'The legacy salts/recovery_codes delete will be SKIPPED.',
    );
  }

  // Whether address-keyed deletes (join_requests, zklogin_sessions) may run.
  // Allowed when the request is identity-verified, or the operator explicitly
  // forced an out-of-band-verified deletion. Refused for a bare unverified
  // request so a spoofed victim address never drives destructive deletes.
  const destructiveAllowed = identityVerified || FORCE_UNVERIFIED;
  const address = destructiveAllowed
    ? (arg('address') || request.user_address || '').trim().toLowerCase() || null
    : null;
  if (!destructiveAllowed && (arg('address') || request.user_address)) {
    console.warn(
      '[deletion] skipping address-keyed deletes (join_requests/zklogin_sessions): request is ' +
        'not identity-verified. Re-run with --force-unverified-identity after verifying ownership.',
    );
  }

  // 1. WhatsApp index rows (stops blob renewal; pointer gone immediately).
  let phoneHmac = null;
  if (phone) {
    const hmac = (value) => createHmac('sha256', salt).update(value).digest('hex');
    phoneHmac = hmac(phone);
    // A run before the fix recorded the hash of "+2376…" and deleted
    // nothing. Name that case when such a request is re-run to repair it.
    if (request.phone_hmac && request.phone_hmac !== phoneHmac) {
      console.warn(
        request.phone_hmac === hmac(`+${phone}`)
          ? '[deletion] this request records the hash of this number WITH its "+", from a run before ' +
              'the fix, which deleted no index row. Replacing that hash.'
          : '[deletion] this request records the hash of another value: a different number, or this one ' +
              'formatted differently by a run before the fix. Replacing it (the renewal exclusion keeps ' +
              'one number per request).',
      );
    }
    // Read-only, so a dry run shows it too: a deletion that matches nothing
    // looks like success afterwards.
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS matches FROM whatsapp_phone_index WHERE phone_hmac = $1`,
      [phoneHmac],
    );
    const matches = rows[0]?.matches ?? 0;
    console.log(`[deletion] whatsapp_phone_index rows matching the phone: ${matches}`);
    if (matches === 0) {
      console.warn(
        '[deletion] no index row matches this number. Either it never linked a circle, its links are ' +
          'already gone (unlinked, or erased by an earlier run), or --phone is not the number that was linked.',
      );
    }
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

  // 2. Address-keyed deletes. NOTE: we deliberately do NOT resolve the OAuth
  //    identity (sub/aud) from the address here anymore — that path let an
  //    unauthenticated, attacker-supplied address drive the salt erasure. The
  //    trusted (sub, aud) was established above from proven ownership only.
  if (address) {
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
    console.log('[deletion] no address-keyed deletes to run');
  }

  // 3. Legacy salts + recovery_codes rows. Nothing has written them since
  //    salts moved to Enoki (2025-05-24), so this only clears leftovers and
  //    cannot lock anyone out of a wallet their login reaches today. It
  //    still runs only against the trusted identity established above, so
  //    a spoofed request can never delete a stranger's rows.
  if (sub && aud) {
    await run(
      'recovery_codes for identity',
      `DELETE FROM recovery_codes
        WHERE salt_id IN (SELECT id FROM salts WHERE sub = $1 AND aud = $2)`,
      [sub, aud],
    );
    await run('salts for identity', `DELETE FROM salts WHERE sub = $1 AND aud = $2`, [sub, aud]);
  } else {
    console.log(
      '[deletion] legacy salts/recovery_codes UNTOUCHED — no trusted identity. If the requester owns ' +
        'the wallet, verify ownership out-of-band, then re-run with ' +
        '--sub <s> --aud <a> --force-unverified-identity.',
    );
  }

  // 4. Close out the request. If the identity-keyed deletes could not run
  //    but the request points at a wallet, leave it actionable
  //    ('processing') instead of 'completed', so a request whose rows still
  //    exist is never silently closed as "erased". Email-only requests with
  //    no wallet reference have nothing further to erase and are completed.
  //    A request that is already completed stays completed: the run that
  //    completed it erased its identity-keyed rows, and a re-run for the
  //    phone alone must not reopen it. Reopening would also drop its phone
  //    from the renewal exclusion, which only honours completed requests.
  const identityDeletesRan = Boolean(sub && aud);
  const walletReferenced = Boolean(
    request.user_address || request.verified_sub || arg('address') || argSub,
  );
  const finalStatus =
    request.status === 'completed' || identityDeletesRan || !walletReferenced
      ? 'completed'
      : 'processing';
  await run(
    `mark request ${finalStatus}`,
    `UPDATE deletion_requests SET status = $2, updated_at = NOW() WHERE id = $1`,
    [request.id, finalStatus],
  );
  if (finalStatus === 'processing') {
    console.warn(
      '[deletion] request left in status=processing: it references a wallet but ownership was ' +
        'not proven, so rows keyed to its OAuth identity were retained. Complete the verified ' +
        're-run to finish.',
    );
  } else if (!identityDeletesRan && walletReferenced) {
    console.log(
      '[deletion] request was already completed and stays completed: a re-run never reopens it.',
    );
  }

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
