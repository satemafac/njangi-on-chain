#!/usr/bin/env node
// smoke-testnet.mjs — Quick post-publish gate. Walks the API surface a
// real pilot would hit and prints PASS/FAIL per step. Designed to run
// against `npm run dev` (default) or any deployment by passing
// `SMOKE_BASE_URL=https://your.app`. Requires `INTERNAL_NOTIFY_SECRET`
// and `NEXT_PUBLIC_<NETWORK>_NJANGI_ATTESTATION_ISSUER` in the env.
//
// Steps:
//   1. GET  /api/whatsapp/admin-link-circle?circleId=<dummy>   → 200 + isLinked:false
//   2. POST /api/compliance/enqueue-issuance                   → 200, returns entry id
//   3. GET  /api/compliance/queue                              → entry id present
//   4. POST /api/compliance/queue { id, action: 'dismissed' }  → 200
//   5. POST /api/whatsapp/notify/your-turn (dummy circle)      → 200, sent:false / no_link
//   6. GET  /api/admin/compliance/stale?circleIds=<dummy>      → 200, stale:[]
//
// Exits non-zero if any step fails. Wraps `fetch` so we get the same
// behaviour on Node ≥18 without depending on undici directly.

import process from 'node:process';

const BASE_URL = process.env.SMOKE_BASE_URL || 'http://localhost:3000';
const NETWORK = (process.env.SMOKE_NETWORK || process.env.NEXT_PUBLIC_SUI_NETWORK || 'testnet').toLowerCase();
const NOTIFY_SECRET = process.env.INTERNAL_NOTIFY_SECRET;
// Compliance/admin endpoints prefer COMPLIANCE_ISSUANCE_SECRET and fall
// back to INTERNAL_NOTIFY_SECRET when unset — mirror the server order.
const COMPLIANCE_SECRET = process.env.COMPLIANCE_ISSUANCE_SECRET || process.env.INTERNAL_NOTIFY_SECRET;
const INTERNAL_SECRET = NOTIFY_SECRET || COMPLIANCE_SECRET;
const ISSUER =
  process.env.NEXT_PUBLIC_NJANGI_ATTESTATION_ISSUER ||
  process.env[`NEXT_PUBLIC_${NETWORK.toUpperCase()}_NJANGI_ATTESTOR_CAP_ID`] ||
  '0x0000000000000000000000000000000000000000000000000000000000000000';
const DUMMY_CIRCLE = process.env.SMOKE_CIRCLE_ID || '0x' + '11'.repeat(32);
const DUMMY_SUBJECT = process.env.SMOKE_SUBJECT_ADDRESS || '0x' + '22'.repeat(32);
const DUMMY_CASE_ID = `smoke:${Date.now()}`;

if (!INTERNAL_SECRET) {
  console.error('[smoke] INTERNAL_NOTIFY_SECRET (or COMPLIANCE_ISSUANCE_SECRET) is required.');
  process.exit(1);
}

let passed = 0;
let failed = 0;

function logResult(label, ok, detail = '') {
  const tag = ok ? '\u001b[32mPASS\u001b[0m' : '\u001b[31mFAIL\u001b[0m';
  const suffix = detail ? ` — ${detail}` : '';
  console.log(`  ${tag}  ${label}${suffix}`);
  if (ok) passed += 1;
  else failed += 1;
}

async function jsonFetch(path, init = {}) {
  const url = `${BASE_URL}${path}`;
  const response = await fetch(url, {
    ...init,
    headers: {
      accept: 'application/json',
      ...(init.headers ?? {}),
    },
  });
  let body;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { url, status: response.status, body };
}

async function step1() {
  const { status, body } = await jsonFetch(
    `/api/whatsapp/admin-link-circle?circleId=${encodeURIComponent(DUMMY_CIRCLE)}&network=${NETWORK}`,
  );
  const ok = status === 200 && body && body.success === true && body.data?.isLinked === false;
  logResult(
    'GET /api/whatsapp/admin-link-circle (isLinked:false)',
    ok,
    `status=${status}`,
  );
}

async function step2() {
  const { status, body } = await jsonFetch('/api/compliance/enqueue-issuance', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-auth': COMPLIANCE_SECRET,
    },
    body: JSON.stringify({
      subject: DUMMY_SUBJECT,
      providerCaseId: DUMMY_CASE_ID,
      network: NETWORK,
      policy: {
        name: 'Smoke KYC',
        version: '0.0.0',
        issuer: ISSUER,
        provider: 'internal',
        criteria: 'Smoke test only — do not trust as a real attestation.',
      },
      ttlMs: 60_000,
    }),
  });
  const entryId = body?.entry?.id;
  const ok = status === 200 && typeof entryId === 'string';
  logResult(
    'POST /api/compliance/enqueue-issuance',
    ok,
    `status=${status} id=${entryId ?? 'n/a'}`,
  );
  return entryId ?? null;
}

async function step3(expectedId) {
  if (!expectedId) {
    logResult('GET /api/compliance/queue (entry visible)', false, 'no entry id from step 2');
    return null;
  }
  const { status, body } = await jsonFetch('/api/compliance/queue', {
    headers: { 'x-internal-auth': COMPLIANCE_SECRET },
  });
  const entries = Array.isArray(body?.entries) ? body.entries : [];
  const found = entries.find((entry) => entry?.id === expectedId);
  const ok = status === 200 && Boolean(found);
  logResult(
    'GET /api/compliance/queue',
    ok,
    `status=${status} entries=${entries.length}`,
  );
  return found ? expectedId : null;
}

async function step4(entryId) {
  if (!entryId) {
    logResult('POST /api/compliance/queue (dismiss)', false, 'no entry id to dismiss');
    return;
  }
  const { status, body } = await jsonFetch('/api/compliance/queue', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-auth': COMPLIANCE_SECRET,
    },
    body: JSON.stringify({ id: entryId, action: 'dismissed' }),
  });
  const ok = status === 200 && body?.ok === true;
  logResult('POST /api/compliance/queue dismiss', ok, `status=${status}`);
}

async function step5() {
  const { status, body } = await jsonFetch('/api/whatsapp/notify/your-turn', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-auth': NOTIFY_SECRET,
    },
    body: JSON.stringify({
      circleId: DUMMY_CIRCLE,
      cycleNo: 1,
      amount: '1 SUI',
      recipient: DUMMY_SUBJECT,
      network: NETWORK,
      locale: 'en',
    }),
  });
  // We expect either a graceful "no_link" send-skip or a 200 with success
  // depending on whether the dummy address has a link. Both are valid
  // smoke responses; the failure case is a 4xx/5xx.
  const ok = status === 200 && (body?.sent === false || body?.sent === true);
  logResult(
    'POST /api/whatsapp/notify/your-turn',
    ok,
    `status=${status} sent=${body?.sent} reason=${body?.reason ?? 'n/a'}`,
  );
}

async function step6() {
  const { status, body } = await jsonFetch(
    `/api/admin/compliance/stale?circleIds=${encodeURIComponent(DUMMY_CIRCLE)}&network=${NETWORK}`,
    {
      headers: { 'x-internal-auth': COMPLIANCE_SECRET },
    },
  );
  const ok = status === 200 && Array.isArray(body?.stale);
  logResult(
    'GET /api/admin/compliance/stale',
    ok,
    `status=${status} stale=${Array.isArray(body?.stale) ? body.stale.length : 'n/a'}`,
  );
}

async function main() {
  console.log(`[smoke] base=${BASE_URL} network=${NETWORK} subject=${DUMMY_SUBJECT}`);
  await step1();
  const entryId = await step2();
  const verifiedId = await step3(entryId);
  await step4(verifiedId);
  await step5();
  await step6();
  console.log(`[smoke] ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('[smoke] fatal', err);
  process.exit(1);
});
