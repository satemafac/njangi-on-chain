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

canonicalOrLegacy('NEXT_PUBLIC_ENOKI_TESTNET', read('NEXT_PUBLIC_ENOKI_TESTNET'), ['NEXT_PUBLIC_ENOKI', 'ZKLOGIN_TESTNET_ENOKI_KEY']);
canonicalOrLegacy('NEXT_PUBLIC_ENOKI_MAINNET', read('NEXT_PUBLIC_ENOKI_MAINNET'), ['NEXT_PUBLIC_ENOKI', 'ZKLOGIN_MAINNET_ENOKI_KEY']);

requireValue('NEXT_PUBLIC_SUI_NETWORK', read('NEXT_PUBLIC_SUI_NETWORK'));
requireValue('NEXT_PUBLIC_BASE_URL', read('NEXT_PUBLIC_BASE_URL'));
requireValue('NEXT_PUBLIC_TESTNET_RPC_URL', testnetRpcUrl);
requireValue('NEXT_PUBLIC_MAINNET_RPC_URL', mainnetRpcUrl);
requireValue('NEXT_PUBLIC_TESTNET_PACKAGE_ID', read('NEXT_PUBLIC_TESTNET_PACKAGE_ID'));
requireValue('NEXT_PUBLIC_MAINNET_PACKAGE_ID', read('NEXT_PUBLIC_MAINNET_PACKAGE_ID'));
requireValue(`current ${currentNetwork} package ID`, currentPackageId);
requireValue(`current ${currentNetwork} WhatsApp package ID`, currentWhatsAppPackageId);
requireValue(`current ${currentNetwork} WhatsApp registry ID`, currentWhatsAppRegistryId);
requireValue('NEXT_PUBLIC_ENOKI_TESTNET', read('NEXT_PUBLIC_ENOKI_TESTNET'));
requireValue('NEXT_PUBLIC_ENOKI_MAINNET', read('NEXT_PUBLIC_ENOKI_MAINNET'));

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

if (read('NEXT_PUBLIC_FACEBOOK_CLIENT_SECRET')) {
  warnings.push('NEXT_PUBLIC_FACEBOOK_CLIENT_SECRET should not exist. Use a server-only variable if a secret is required.');
}

if (fs.existsSync(path.join(repoRoot, 'whatsapp-bot-backend', '.env.local'))) {
  warnings.push('whatsapp-bot-backend/.env.local still exists. The backend now auto-loads the repo root .env.local.');
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
