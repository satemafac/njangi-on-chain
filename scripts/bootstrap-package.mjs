#!/usr/bin/env node
// bootstrap-package.mjs — Post-publish bootstrap for a fresh Move
// package on Sui testnet/mainnet. Closes the gap where build_and_test.sh
// captures the package id but leaves three other object ids dangling for
// the operator to discover manually.
//
// What it does (safe to re-run):
//   1. Reads the package's type origin table for the full type of each
//      object below (see "Package lineage").
//   2. Finds the `AttestorCap` that `njangi_compliance::init` minted to the
//      deployer. Writes `NEXT_PUBLIC_<NETWORK>_NJANGI_ATTESTOR_CAP_ID` and the
//      public `NEXT_PUBLIC_NJANGI_ATTESTATION_ISSUER` (the cap-holder address).
//   3. Keeps `NEXT_PUBLIC_<NETWORK>_WHATSAPP_REGISTRY_ID` only if it points at
//      a live shared `WhatsAppLinksRegistry` of this package's lineage on this
//      network. Otherwise it calls `whatsapp_integration::init_registry` and
//      overwrites the variable: an empty value, an .env.example placeholder
//      (`0xyour_…`), an id that does not exist on this network and a previous
//      lineage's registry are all replaced.
//   4. Same rule for `NEXT_PUBLIC_<NETWORK>_NJANGI_ASSET_REGISTRY_ID` and
//      `njangi_price_validator::init_registry`.
//   5. Patches `.env.local` with those ids without touching anything else.
//
// Every read happens before the first signed call. If one cannot be
// answered (RPC error, rate limit), the script stops without signing or
// writing anything: a registry created on a guess would point the app at an
// empty registry and strand the live one's links.
//
// Package lineage: Sui names each type after the package version that first
// declared it. After `sui client upgrade`, calls go to the newest id while
// the registries keep the declaring version's id (on testnet, the original
// 0x89cddf4d… for all three types here). The expected types therefore come
// from the package object's typeOriginTable, never from `${packageId}::…`
// (definingType in scripts/lib/registry-bootstrap.ts). Passing the latest
// upgraded id keeps the live registries; a fresh publish starts a new
// lineage, and its id replaces the old lineage's registries.
//
// Usage:
//   NJANGI_BOOTSTRAP_NETWORK=testnet \
//   NJANGI_BOOTSTRAP_GAS_BUDGET=200000000 \
//   node scripts/bootstrap-package.mjs <packageId>
//
//   or via npm: npm run bootstrap:package -- <packageId>
//
// Needs Node >= 22.18 (it imports scripts/lib/*.ts through Node's type
// stripping); package.json pins 24.x.
//
// Env knobs:
//   NJANGI_BOOTSTRAP_NETWORK  testnet | mainnet (default: testnet)
//   NJANGI_BOOTSTRAP_GAS_BUDGET  default 200000000
//   NJANGI_BOOTSTRAP_ENV_FILE  override .env.local path
//   NJANGI_BOOTSTRAP_RPC_URL  JSON-RPC endpoint for the reads (default: the
//     env file's NEXT_PUBLIC_<NETWORK>_RPC_URL, else publicnode)

import { execFile, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import process from 'node:process';
import dotenv from 'dotenv';
import {
  definingType,
  isSuiObjectId,
  normalizeStructType,
  planRegistry,
} from './lib/registry-bootstrap.ts';

const exec = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

const PACKAGE_ID = process.argv[2];
if (!PACKAGE_ID || !isSuiObjectId(PACKAGE_ID)) {
  console.error('[bootstrap] usage: node scripts/bootstrap-package.mjs <packageId>');
  process.exit(1);
}

const NETWORK = (process.env.NJANGI_BOOTSTRAP_NETWORK || 'testnet').toLowerCase();
if (NETWORK !== 'testnet' && NETWORK !== 'mainnet') {
  console.error(`[bootstrap] unsupported network: ${NETWORK}`);
  process.exit(1);
}

const GAS_BUDGET = process.env.NJANGI_BOOTSTRAP_GAS_BUDGET || '200000000';
const ENV_FILE =
  process.env.NJANGI_BOOTSTRAP_ENV_FILE
    ? resolve(process.cwd(), process.env.NJANGI_BOOTSTRAP_ENV_FILE)
    : resolve(repoRoot, '.env.local');

const NETWORK_UPPER = NETWORK.toUpperCase();
const ENV_KEYS = {
  attestorCap: `NEXT_PUBLIC_${NETWORK_UPPER}_NJANGI_ATTESTOR_CAP_ID`,
  attestorIssuer: 'NEXT_PUBLIC_NJANGI_ATTESTATION_ISSUER',
  whatsappRegistry: `NEXT_PUBLIC_${NETWORK_UPPER}_WHATSAPP_REGISTRY_ID`,
  assetRegistry: `NEXT_PUBLIC_${NETWORK_UPPER}_NJANGI_ASSET_REGISTRY_ID`,
};

// [module, struct] of every object the bootstrap looks for. The full types
// come from the package's type origin table (resolveStructTypes).
const STRUCTS = {
  attestorCap: ['njangi_compliance', 'AttestorCap'],
  whatsappRegistry: ['whatsapp_integration', 'WhatsAppLinksRegistry'],
  assetRegistry: ['njangi_price_validator', 'AssetRegistry'],
};

const REGISTRIES = [
  {
    key: 'whatsappRegistry',
    module: 'whatsapp_integration',
    fn: 'init_registry',
    envKey: ENV_KEYS.whatsappRegistry,
  },
  {
    // Oracle config.
    key: 'assetRegistry',
    module: 'njangi_price_validator',
    fn: 'init_registry',
    envKey: ENV_KEYS.assetRegistry,
  },
];

function log(message) {
  console.log(`[bootstrap] ${message}`);
}

function ensureEnvFile() {
  if (existsSync(ENV_FILE)) return;
  console.error(`[bootstrap] env file missing: ${ENV_FILE}`);
  console.error('[bootstrap] cp .env.example .env.local first.');
  process.exit(1);
}

function readEnv() {
  const content = readFileSync(ENV_FILE, 'utf8');
  // Values as Next.js and validate-env.mjs read them (dotenv): quotes,
  // `export` prefixes and trailing comments are not part of the value.
  return { content, map: new Map(Object.entries(dotenv.parse(content))) };
}

function patchEnv(updates) {
  if (updates.size === 0) return;
  let { content } = readEnv();
  const additions = [];
  for (const [key, value] of updates) {
    // Every line that defines the key: dotenv keeps the last one, so
    // replacing only the first would leave a duplicate's old value in force.
    const definition = `^[ \\t]*(?:export[ \\t]+)?${key}[ \\t]*=.*$`;
    if (new RegExp(definition, 'm').test(content)) {
      content = content.replace(new RegExp(definition, 'gm'), `${key}=${value}`);
    } else {
      additions.push(`${key}=${value}`);
    }
  }
  if (additions.length > 0) {
    if (!content.endsWith('\n')) content += '\n';
    content +=
      '\n# Generated by scripts/bootstrap-package.mjs ' +
      new Date().toISOString() +
      '\n' +
      additions.join('\n') +
      '\n';
  }
  writeFileSync(ENV_FILE, content, 'utf8');
}

async function suiCallJson(args) {
  // Wraps `sui client` with `--json` so we always get structured output.
  const cmd = ['client', ...args, '--json'];
  try {
    const { stdout } = await exec('sui', cmd, { cwd: repoRoot, maxBuffer: 32 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch (err) {
    const stderr = err && typeof err === 'object' && 'stderr' in err ? err.stderr : err;
    throw new Error(`sui ${cmd.join(' ')} failed: ${stderr}`);
  }
}

async function activeAddress() {
  try {
    const out = execFileSync('sui', ['client', 'active-address'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    return out.trim();
  } catch (err) {
    throw new Error(`sui client active-address failed: ${err}`);
  }
}

// fullnode.{testnet,mainnet}.sui.io answer every JSON-RPC method with
// -32601, so use what the app uses: the env file's RPC URL, else the
// publicnode defaults from src/config/public-env.ts.
const DEFAULT_RPC_URLS = {
  testnet: 'https://sui-testnet-rpc.publicnode.com',
  mainnet: 'https://sui-rpc.publicnode.com',
};
const RPC_URL =
  process.env.NJANGI_BOOTSTRAP_RPC_URL ||
  (existsSync(ENV_FILE) && readEnv().map.get(`NEXT_PUBLIC_${NETWORK_UPPER}_RPC_URL`)) ||
  DEFAULT_RPC_URLS[NETWORK];

async function rpcCall(method, params) {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`rpc ${method} http ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`rpc ${method} error: ${JSON.stringify(json.error)}`);
  return json.result;
}

async function getOwnedObject(owner, structType) {
  // Sui CLI 1.69 dropped `--filter`, so query the fullnode RPC directly.
  const result = await rpcCall('suix_getOwnedObjects', [
    owner,
    { filter: { StructType: structType }, options: { showType: true } },
    null,
    50,
  ]);
  const data = result?.data ?? [];
  for (const item of data) {
    const objectId = item?.data?.objectId;
    if (objectId) return objectId;
  }
  return null;
}

async function readPackage() {
  // build_and_test.sh publishes through the CLI's own endpoint, so a package
  // published seconds ago may not have reached this RPC node yet.
  for (let attempt = 1; ; attempt += 1) {
    const response = await rpcCall('sui_getObject', [PACKAGE_ID, { showBcs: true }]);
    if (response?.error?.code !== 'notExists' || attempt === 5) return response;
    log(`package not visible on ${RPC_URL} yet; retrying in 3s`);
    await new Promise((done) => setTimeout(done, 3000));
  }
}

async function resolveStructTypes() {
  const pkg = await readPackage();
  try {
    return Object.fromEntries(
      Object.entries(STRUCTS).map(([key, [moduleName, name]]) => [key, definingType(pkg, moduleName, name)]),
    );
  } catch (err) {
    throw new Error(`package ${PACKAGE_ID} on ${RPC_URL}: ${err.message}`);
  }
}

async function callMoveAndCaptureSharedObject(target, structType) {
  log(`calling ${target.module}::${target.fn}`);
  const result = await suiCallJson([
    'call',
    '--package',
    PACKAGE_ID,
    '--module',
    target.module,
    '--function',
    target.fn,
    '--gas-budget',
    GAS_BUDGET,
  ]);
  const changes = result?.objectChanges ?? [];
  for (const change of changes) {
    if (change?.type === 'created' && normalizeStructType(change?.objectType ?? '') === structType) {
      return change.objectId;
    }
  }
  // Some CLI versions nest the changes under effects.
  const effects = result?.effects?.created ?? [];
  for (const change of effects) {
    if (change?.reference?.objectId && change?.owner?.Shared) {
      return change.reference.objectId;
    }
  }
  return null;
}

async function captureAttestorCap(deployer, structType) {
  // The compliance module's `init` transferred the cap to the deployer.
  // We try the owner's object set first; if the operator already moved
  // the cap to a multisig, env can be patched manually after the fact.
  log(`looking up AttestorCap owned by ${deployer}`);
  const objectId = await getOwnedObject(deployer, structType);
  if (!objectId) {
    log('AttestorCap not found in deployer wallet — set the env var manually if it was already transferred.');
    return null;
  }
  log(`AttestorCap = ${objectId}`);
  return objectId;
}

async function main() {
  ensureEnvFile();
  const envLabel = ENV_FILE.replace(repoRoot + '/', '');

  log(`network=${NETWORK}  package=${PACKAGE_ID}  env=${envLabel}  rpc=${RPC_URL}`);

  const deployer = await activeAddress();
  log(`deployer=${deployer}`);

  // Reads only until every registry has a plan.
  const types = await resolveStructTypes();

  // 1. AttestorCap (auto-minted by njangi_compliance::init at publish)
  const updates = new Map();
  const capId = await captureAttestorCap(deployer, types.attestorCap);
  if (capId) {
    updates.set(ENV_KEYS.attestorCap, capId);
    updates.set(ENV_KEYS.attestorIssuer, deployer);
  }

  // 2. WhatsAppLinksRegistry, 3. AssetRegistry
  const { map } = readEnv();
  const plans = [];
  for (const registry of REGISTRIES) {
    const configured = map.get(registry.envKey);
    const plan = await planRegistry(configured, types[registry.key], (id) =>
      rpcCall('sui_getObject', [id, { showType: true, showOwner: true }]),
    );
    plans.push({ registry, configured, plan });
  }

  const stopped = plans.filter(({ plan }) => plan.action === 'stop');
  if (stopped.length > 0) {
    for (const { registry, plan } of stopped) log(`${registry.envKey}: ${plan.reason}`);
    throw new Error(
      `could not check every registry, so nothing was signed and ${envLabel} is unchanged. ` +
        'Re-run when the RPC answers, or point NJANGI_BOOTSTRAP_RPC_URL at another JSON-RPC endpoint.',
    );
  }

  patchEnv(updates);
  let written = updates.size;

  for (const { registry, configured, plan } of plans) {
    if (plan.action === 'keep') {
      log(`${registry.envKey}=${configured} is a live ${types[registry.key]}; keeping it`);
      continue;
    }
    log(`${registry.envKey}: ${plan.reason}; replacing it`);
    const created = await callMoveAndCaptureSharedObject(registry, types[registry.key]);
    if (!created) {
      throw new Error(
        `no ${types[registry.key]} in the ${registry.module}::${registry.fn} output. ` +
          `If that transaction succeeded, set ${registry.envKey} to the shared object it created.`,
      );
    }
    // Written before the next call, so a later failure cannot lose this id.
    patchEnv(new Map([[registry.envKey, created]]));
    written += 1;
    log(`${registry.envKey}=${created}`);
  }

  log(`patched ${written} env entries in ${envLabel}`);
  log('next: run npm run validate:env then npm run smoke:testnet');
}

main().catch((err) => {
  console.error('[bootstrap] fatal', err);
  process.exit(1);
});
