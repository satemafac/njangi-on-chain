#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const envFileArg = process.argv[2];
const envFilePath = envFileArg
  ? path.resolve(process.cwd(), envFileArg)
  : path.join(repoRoot, '.env.local');

if (!fs.existsSync(envFilePath)) {
  console.error(`[env] File not found: ${envFilePath}`);
  process.exit(1);
}

const parsed = dotenv.parse(fs.readFileSync(envFilePath, 'utf8'));
const currentNetwork = parsed.NEXT_PUBLIC_SUI_NETWORK === 'mainnet' ? 'mainnet' : 'testnet';
const warnings = [];
const errors = [];

function read(key) {
  return parsed[key]?.trim() ?? '';
}

function requireValue(key, value) {
  if (!value) {
    errors.push(`Missing required variable: ${key}`);
  }
}

function canonicalOrLegacy(canonicalKey, canonicalValue, legacyKeys) {
  const legacyEntries = legacyKeys
    .map((key) => ({ key, value: read(key) }))
    .filter((entry) => entry.value !== '');

  if (canonicalValue) {
    for (const legacy of legacyEntries) {
      if (legacy.value !== canonicalValue) {
        errors.push(`Conflicting values for ${canonicalKey} and legacy alias ${legacy.key}`);
      }
    }
    return canonicalValue;
  }

  if (legacyEntries[0]) {
    warnings.push(`${legacyEntries[0].key} is deprecated. Rename it to ${canonicalKey}.`);
    return legacyEntries[0].value;
  }

  return '';
}

const testnetRpcUrl =
  canonicalOrLegacy('NEXT_PUBLIC_TESTNET_RPC_URL', read('NEXT_PUBLIC_TESTNET_RPC_URL'), ['NEXT_PUBLIC_SUI_RPC_URL']) ||
  'https://fullnode.testnet.sui.io:443';
const mainnetRpcUrl =
  canonicalOrLegacy('NEXT_PUBLIC_MAINNET_RPC_URL', read('NEXT_PUBLIC_MAINNET_RPC_URL'), currentNetwork === 'mainnet' ? ['NEXT_PUBLIC_SUI_RPC_URL'] : []) ||
  'https://fullnode.mainnet.sui.io:443';

const currentPackageId =
  currentNetwork === 'mainnet'
    ? canonicalOrLegacy('NEXT_PUBLIC_MAINNET_PACKAGE_ID', read('NEXT_PUBLIC_MAINNET_PACKAGE_ID'), ['NEXT_PUBLIC_PACKAGE_ID'])
    : canonicalOrLegacy('NEXT_PUBLIC_TESTNET_PACKAGE_ID', read('NEXT_PUBLIC_TESTNET_PACKAGE_ID'), ['NEXT_PUBLIC_PACKAGE_ID']);

const currentWhatsAppPackageId =
  currentNetwork === 'mainnet'
    ? canonicalOrLegacy('NEXT_PUBLIC_MAINNET_WHATSAPP_PACKAGE_ID', read('NEXT_PUBLIC_MAINNET_WHATSAPP_PACKAGE_ID'), ['NEXT_PUBLIC_WHATSAPP_PACKAGE_ID'])
    : canonicalOrLegacy('NEXT_PUBLIC_TESTNET_WHATSAPP_PACKAGE_ID', read('NEXT_PUBLIC_TESTNET_WHATSAPP_PACKAGE_ID'), ['NEXT_PUBLIC_WHATSAPP_PACKAGE_ID']);

const currentWhatsAppRegistryId =
  currentNetwork === 'mainnet'
    ? canonicalOrLegacy('NEXT_PUBLIC_MAINNET_WHATSAPP_REGISTRY_ID', read('NEXT_PUBLIC_MAINNET_WHATSAPP_REGISTRY_ID'), [
        'NEXT_PUBLIC_WHATSAPP_REGISTRY_ID',
        'SUI_WHATSAPP_LINKS_REGISTRY_ID',
      ])
    : canonicalOrLegacy('NEXT_PUBLIC_TESTNET_WHATSAPP_REGISTRY_ID', read('NEXT_PUBLIC_TESTNET_WHATSAPP_REGISTRY_ID'), [
        'NEXT_PUBLIC_WHATSAPP_REGISTRY_ID',
        'SUI_WHATSAPP_LINKS_REGISTRY_ID',
      ]);

// Enoki private key: server-only ENOKI_API_KEY_* is canonical; the bundled
// NEXT_PUBLIC_ENOKI_* variants are deprecated (they inline the private key
// into the client bundle + build logs). Resolve each network from the
// server var first, then the deprecated public var.
const testnetEnokiKey = canonicalOrLegacy('ENOKI_API_KEY_TESTNET', read('ENOKI_API_KEY_TESTNET'), [
  'NEXT_PUBLIC_ENOKI_TESTNET',
  'NEXT_PUBLIC_ENOKI',
  'ZKLOGIN_TESTNET_ENOKI_KEY',
]);
const mainnetEnokiKey = canonicalOrLegacy('ENOKI_API_KEY_MAINNET', read('ENOKI_API_KEY_MAINNET'), [
  'NEXT_PUBLIC_ENOKI_MAINNET',
  'NEXT_PUBLIC_ENOKI',
  'ZKLOGIN_MAINNET_ENOKI_KEY',
]);

// SECURITY: an enoki_private_* value in ANY NEXT_PUBLIC_ slot is bundled
// into the browser JS and printed in build logs. Flag it as an error so a
// publish never ships the private key client-side — it must be moved to the
// server-only ENOKI_API_KEY_* var AND rotated (the old value is compromised
// the moment it lands in a client bundle).
for (const key of ['NEXT_PUBLIC_ENOKI_TESTNET', 'NEXT_PUBLIC_ENOKI_MAINNET', 'NEXT_PUBLIC_ENOKI']) {
  if (/^enoki_private_/.test(read(key))) {
    const serverKey = key.includes('MAINNET') ? 'ENOKI_API_KEY_MAINNET' : 'ENOKI_API_KEY_TESTNET';
    errors.push(
      `${key} holds an enoki_private_* key — this is inlined into the client bundle and build logs. ` +
        `Move it to the server-only ${serverKey} and ROTATE the key in the Enoki dashboard (the old one is compromised).`,
    );
  }
}

requireValue('NEXT_PUBLIC_SUI_NETWORK', read('NEXT_PUBLIC_SUI_NETWORK'));
requireValue('NEXT_PUBLIC_BASE_URL', read('NEXT_PUBLIC_BASE_URL'));
requireValue('NEXT_PUBLIC_TESTNET_RPC_URL', testnetRpcUrl);
requireValue('NEXT_PUBLIC_MAINNET_RPC_URL', mainnetRpcUrl);
requireValue('NEXT_PUBLIC_TESTNET_PACKAGE_ID', read('NEXT_PUBLIC_TESTNET_PACKAGE_ID'));
requireValue('NEXT_PUBLIC_MAINNET_PACKAGE_ID', read('NEXT_PUBLIC_MAINNET_PACKAGE_ID'));
requireValue(`current ${currentNetwork} package ID`, currentPackageId);
requireValue(`current ${currentNetwork} WhatsApp package ID`, currentWhatsAppPackageId);
requireValue(`current ${currentNetwork} WhatsApp registry ID`, currentWhatsAppRegistryId);

// Phase 12: post-publish ids written by scripts/bootstrap-package.mjs.
// We only require them on the active network so testnet pilots don't
// have to populate mainnet placeholders before they exist.
const networkUpper = currentNetwork === 'mainnet' ? 'MAINNET' : 'TESTNET';
const attestorCapKey = `NEXT_PUBLIC_${networkUpper}_NJANGI_ATTESTOR_CAP_ID`;
const assetRegistryKey = `NEXT_PUBLIC_${networkUpper}_NJANGI_ASSET_REGISTRY_ID`;
requireValue(attestorCapKey, read(attestorCapKey));
requireValue(assetRegistryKey, read(assetRegistryKey));
// Require the Enoki key only for the ACTIVE network (resolved from the
// server var or, transitionally, the deprecated public var). Testnet pilots
// shouldn't have to populate a mainnet Enoki key before they need it.
requireValue(
  `current ${currentNetwork} Enoki API key (ENOKI_API_KEY_${networkUpper})`,
  currentNetwork === 'mainnet' ? mainnetEnokiKey : testnetEnokiKey,
);

for (const key of [
  'WHATSAPP_PHONE_NUMBER_ID',
  'WHATSAPP_ACCESS_TOKEN',
  'WHATSAPP_VERIFY_TOKEN',
  'WHATSAPP_APP_SECRET',
  'WHATSAPP_WEBHOOK_URL',
  'WHATSAPP_BUSINESS_ACCOUNT_ID',
]) {
  requireValue(key, read(key));
}

// Vercel serverless migration (June 2026): per-process state (zkLogin
// sessions, rate limits, webhook dedupe) lives in Postgres. A deployment
// without DATABASE_URL silently degrades to per-instance memory/SQLite,
// which on serverless means random logouts and no dedupe — fail here, and
// fail again at runtime (see src/lib/pg-pool.ts assertDatabaseUrlInProduction).
requireValue('DATABASE_URL', read('DATABASE_URL'));
if (read('DATABASE_URL') && !read('ZKLOGIN_SESSION_ENC_KEY')) {
  errors.push(
    'DATABASE_URL is set but ZKLOGIN_SESSION_ENC_KEY is empty. zkLogin sessions are ' +
      'encrypted at rest before hitting Postgres; run `npm run generate:secrets`.',
  );
}

if (read('NEXT_PUBLIC_FACEBOOK_CLIENT_SECRET')) {
  warnings.push('NEXT_PUBLIC_FACEBOOK_CLIENT_SECRET should not exist. Use a server-only variable if a secret is required.');
}

// Phase 9 compliance-gate invariants: when the UI gate is turned on, the
// issuer pin + HMAC salt must both be configured. Otherwise the gated
// contribute/finalize paths will either reject every caller (missing
// issuer) or fail to hash case ids (missing salt).
const complianceGateEnabled =
  (read('NEXT_PUBLIC_COMPLIANCE_GATE_ENABLED') || 'false').toLowerCase() === 'true';
if (complianceGateEnabled) {
  if (!read('NEXT_PUBLIC_NJANGI_ATTESTATION_ISSUER')) {
    errors.push(
      'NEXT_PUBLIC_COMPLIANCE_GATE_ENABLED is true but NEXT_PUBLIC_NJANGI_ATTESTATION_ISSUER is empty. Gated contribute/collect will reject every caller.',
    );
  }
  if (!read('COMPLIANCE_REF_HMAC_SALT')) {
    errors.push(
      'NEXT_PUBLIC_COMPLIANCE_GATE_ENABLED is true but COMPLIANCE_REF_HMAC_SALT is empty. The attestor console cannot hash case ids safely.',
    );
  }
  if (!read('COMPLIANCE_ISSUANCE_SECRET') && !read('INTERNAL_NOTIFY_SECRET')) {
    errors.push(
      'NEXT_PUBLIC_COMPLIANCE_GATE_ENABLED is true but neither COMPLIANCE_ISSUANCE_SECRET nor INTERNAL_NOTIFY_SECRET is set. Ramp-partner webhooks cannot enqueue attestations.',
    );
  }
}

// If the ramp-attestation queue has a fallback to INTERNAL_NOTIFY_SECRET,
// we should warn the operator when that secret is missing but the gate is
// off, so no surprises when they flip the flag on.
if (!complianceGateEnabled && !read('INTERNAL_NOTIFY_SECRET')) {
  warnings.push(
    'INTERNAL_NOTIFY_SECRET is unset. Required by the WhatsApp "your turn" notifier and the compliance attestor console.',
  );
}

// Stripe subscription billing (June 2026): everything stays free until
// NEXT_PUBLIC_BILLING_ENABLED=true, so the STRIPE_* values are optional by
// default and required only once the kill switch is flipped — checkout,
// the billing portal, and webhook signature verification all need them.
const billingEnabled =
  (read('NEXT_PUBLIC_BILLING_ENABLED') || 'false').toLowerCase() === 'true';
const stripeKeys = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_PRICE_ID_PREMIUM'];
if (billingEnabled) {
  for (const key of stripeKeys) {
    if (!read(key)) {
      errors.push(
        `NEXT_PUBLIC_BILLING_ENABLED is true but ${key} is empty. Billing endpoints cannot run without it.`,
      );
    }
  }
} else if (stripeKeys.some((key) => read(key)) && !stripeKeys.every((key) => read(key))) {
  warnings.push(
    `Partial Stripe configuration detected (${stripeKeys.filter((key) => read(key)).join(', ')}). ` +
      'Set all of STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_ID_PREMIUM before flipping NEXT_PUBLIC_BILLING_ENABLED.',
  );
}

// OFAC sanctions program (docs/sanctions-program.md): both controls are
// default-ON — disabling one is a deliberate operator act that must be
// visible in CI output, never a silent misconfiguration.
for (const flag of ['SANCTIONS_SCREENING_ENABLED', 'SANCTIONS_GEO_BLOCK_ENABLED']) {
  if ((read(flag) || 'true').toLowerCase() === 'false') {
    warnings.push(
      `${flag} is explicitly "false" — the OFAC ${flag.includes('GEO') ? 'geo-block' : 'address screen'} is OFF. See docs/sanctions-program.md before shipping this to production.`,
    );
  }
}

// June 2026 Vercel migration: the cycle-finalized notifier runs as a Vercel
// cron authenticated by `Authorization: Bearer ${CRON_SECRET}`. Without it,
// /api/cron/cycle-finalized fails closed (500) and no nudges go out.
if (!read('CRON_SECRET')) {
  warnings.push(
    'CRON_SECRET is unset. /api/cron/cycle-finalized, /api/cron/whatsapp-circle-events and /api/cron/walrus-renewal reject every invocation without it; run `npm run generate:secrets` and mirror the value on the Vercel project.',
  );
}

// June 2026 platform hardening: Sentry is OPTIONAL — every Sentry init
// (sentry.client/server/edge.config.ts) no-ops when its DSN is empty. We
// only sanity-check the format when a value is present so a typo'd DSN
// doesn't silently disable error tracking.
for (const key of ['SENTRY_DSN', 'NEXT_PUBLIC_SENTRY_DSN']) {
  const value = read(key);
  if (value && !/^https:\/\/[^@\s]+@[^/\s]+\/\d+$/.test(value)) {
    warnings.push(
      `${key} does not look like a Sentry DSN (expected https://<key>@<host>/<project-id>). Error tracking will silently fail.`,
    );
  }
}
if (read('SENTRY_DSN') && !read('NEXT_PUBLIC_SENTRY_DSN')) {
  warnings.push(
    'SENTRY_DSN is set but NEXT_PUBLIC_SENTRY_DSN is empty — server errors will be tracked, browser errors will not.',
  );
}

// June 2026 fold-in: the standalone whatsapp-bot-backend HTTP service was
// replaced by /api/cron/whatsapp-circle-events (see
// whatsapp-bot-backend/DEPRECATED.md). Its env vars are dead.
for (const key of [
  'BACKEND_AUTH_TOKEN',
  'WHATSAPP_BACKEND_URL',
  'CIRCLE_BACKEND_URL',
  'ANALYTICS_URL',
  'ENABLE_EVENT_LISTENER',
  'ENABLE_MESSAGE_SENDER',
  'ENABLE_ON_CHAIN_LOGGING',
]) {
  if (read(key)) {
    warnings.push(
      `${key} is set but unused — it belonged to the retired whatsapp-bot-backend service. Remove it from .env.local.`,
    );
  }
}

if (fs.existsSync(path.join(repoRoot, 'whatsapp-bot-backend', '.env.local'))) {
  warnings.push('whatsapp-bot-backend/.env.local still exists. The bot backend is deprecated (folded into the app); delete the file.');
}

if (warnings.length > 0) {
  console.warn('[env] Warnings:');
  for (const warning of warnings) {
    console.warn(`  - ${warning}`);
  }
}

if (errors.length > 0) {
  console.error('[env] Validation failed:');
  for (const error of errors) {
    console.error(`  - ${error}`);
  }
  process.exit(1);
}

console.log(`[env] OK (${currentNetwork}) using ${path.relative(repoRoot, envFilePath)}`);
