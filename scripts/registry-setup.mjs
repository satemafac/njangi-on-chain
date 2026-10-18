#!/usr/bin/env node
// registry-setup.mjs — the post-publish AssetRegistry steps of docs/mainnet-publish-scope.md
// step 8, as separate, idempotent, dry-run-first commands. The owner signs; this script holds no key.
//
//   node scripts/registry-setup.mjs status                [--network testnet|mainnet]
//   node scripts/registry-setup.mjs bless                 [--yes]
//   node scripts/registry-setup.mjs register-usdc         [--coin <type>] [--yes]
//   node scripts/registry-setup.mjs transfer-admin        --to <multisig> [--yes]
//   node scripts/registry-setup.mjs transfer-upgrade-cap  --to <multisig> [--yes]
//
// Reads come from graphql.<network>.sui.io (object contents, dynamic fields, coin metadata): every
// public JSON-RPC endpoint for testnet is retired. Writes go through `sui client ptb`: the dry run
// always runs first and prints the Move calls and object ids; the same PTB is signed by the CLI's
// keystore only with --yes. On mainnet the network must be spelled out (--network mainnet) and the
// script prints a final warning before signing. Every mutation re-reads the chain afterwards and
// says whether the intended state is there.
//
// Options: --env-file (default .env.local; also NJANGI_ENV_FILE), --network, --registry, --package, --cap (default: move/Published.toml's upgrade-capability
// for the network), --coin (default: the network's USDC from src/config/coin-types.ts; on mainnet any
// other coin is refused), --source-network (where register-usdc copies oracle id, max age and flags
// from; default testnet), --to, --gas-budget, --graphql, --yes, --json.
//
// Mainnet order (see MAINNET_ORDER): status → bless → register-usdc → transfer-admin → transfer-upgrade-cap → status.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  DEFAULT_GAS_BUDGET, DEFAULT_USDC_COIN_TYPES, GRAPHQL_URLS, MAINNET_ORDER, canonicalCoinType, coinMetadataQuery, envGuard, flagNames, mainnetGuard, objectOwnerQuery,
  parseCliOutcome, parseCoinMetadata, parseRegistry, parseUpgradeCap, planBless, planRegisterUsdc, planTransferAdmin, planTransferCap, prefixedCoinType, registryQuery,
  sameAddress, tableEntriesQuery, usdcEntryOf,
} from './lib/registry-setup.ts';
import { publishedValue } from './lib/registry-bootstrap.ts';

const exec = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---- arguments and env --------------------------------------------------------------------------
const argv = process.argv.slice(2);
const command = argv[0] && !argv[0].startsWith('--') ? argv[0] : null;
const has = (flag) => argv.includes(flag);
const opt = (flag) => { const i = argv.indexOf(flag); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined; };

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}
loadDotEnv(opt('--env-file') || process.env.NJANGI_ENV_FILE || path.join(ROOT, '.env.local'));

const networkFromArgs = opt('--network') !== undefined;
const network = (opt('--network') || process.env.NEXT_PUBLIC_SUI_NETWORK || 'testnet').toLowerCase();
if (network !== 'testnet' && network !== 'mainnet') fail(`unknown network ${network}`);
const NET = network.toUpperCase();
const env = (key) => (process.env[`NEXT_PUBLIC_${NET}_${key}`] || '').trim();
const published = (key) => { try { return publishedValue(fs.readFileSync(path.join(ROOT, 'move', 'Published.toml'), 'utf8'), network, key); } catch { return undefined; } };

const packageId = opt('--package') || env('PACKAGE_ID') || published('published-at');
const registryId = opt('--registry') || env('NJANGI_ASSET_REGISTRY_ID');
const capId = opt('--cap') || published('upgrade-capability');
const coinType = opt('--coin') || env('USDC') || DEFAULT_USDC_COIN_TYPES[network];
const sourceNetwork = (opt('--source-network') || 'testnet').toLowerCase();
const graphqlUrl = opt('--graphql') || env('GRAPHQL_URL') || GRAPHQL_URLS[network];
const gasBudget = Number(opt('--gas-budget') || DEFAULT_GAS_BUDGET);
const yes = has('--yes');
const asJson = has('--json');
const isId = (s) => typeof s === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(s);

function fail(msg, code = 1) { console.error(`error: ${msg}`); process.exit(code); }
const say = (msg) => { if (!asJson) console.log(msg); };

// ---- reads (GraphQL) ----------------------------------------------------------------------------
async function gql(url, query) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }) });
  if (!res.ok) throw new Error(`graphql ${url} http ${res.status}`);
  const body = await res.json();
  if (body.errors && !body.data) throw new Error(`graphql error: ${JSON.stringify(body.errors).slice(0, 300)}`);
  return body;
}
async function readRegistry(url, id) {
  const reg = await gql(url, registryQuery(id));
  const tableId = reg.data?.object?.asMoveObject?.contents?.json?.assets?.id;
  if (!tableId) throw new Error(`registry ${id} was not found on ${url}`);
  return parseRegistry(reg, await gql(url, tableEntriesQuery(tableId)));
}
const readCap = async (url, id) => parseUpgradeCap(await gql(url, objectOwnerQuery(id)));
const readMetadata = async (url, type) => parseCoinMetadata(await gql(url, coinMetadataQuery(type)));

// ---- the CLI ------------------------------------------------------------------------------------
async function sui(args, { json = true, raw = false } = {}) {
  const full = json || raw ? [...args, '--json'] : args;
  try {
    const { stdout } = await exec('sui', full, { cwd: ROOT, maxBuffer: 32 * 1024 * 1024 });
    return json ? JSON.parse(stdout) : stdout.trim();
  } catch (e) {
    const stderr = e && typeof e === 'object' && 'stderr' in e ? String(e.stderr).slice(0, 600) : String(e);
    throw new Error(`sui ${args.join(' ')} failed: ${stderr}`);
  }
}
const activeEnv = async () => sui(['client', 'active-env'], { json: false });
const activeAddress = async () => sui(['client', 'active-address'], { json: false });

// A dry run is prose even with --json; an execution is JSON with --json, text without. One parser for both.
async function ptbRun(ptb, { dryRun }) {
  if (dryRun) return parseCliOutcome(await sui(['client', 'ptb', ...ptb, '--dry-run'], { json: false }));
  const raw = await sui(['client', 'ptb', ...ptb], { json: false, raw: true });
  try { return parseCliOutcome(JSON.parse(raw)); } catch { return parseCliOutcome(raw); }
}

// ---- output -------------------------------------------------------------------------------------
function printStatus(status, cap) {
  say(`network ${network} · registry ${status.registryId} (${status.type.split('::')[0]}…)`);
  say(`admin     ${status.admin}`);
  say(`canonical ${status.canonical ? 'yes' : 'NO'}`);
  say(`assets    ${status.assetCount}`);
  for (const a of status.assets) say(`  - ${a.coinType}\n      decimals ${a.decimals} · max age ${a.maxAgeSecs}s · ${a.enabled ? 'enabled' : 'DISABLED'} · flags ${a.flags} (${flagNames(a.flags).join(', ') || 'none'}) · oracle ${a.oracleIdHex}`);
  if (cap) say(`upgrade cap ${cap.id}: owner ${cap.owner ?? cap.ownerKind} · package ${cap.package} v${cap.version} · policy ${cap.policy}`);
}

async function runPlan(name, plan, confirm) {
  if (plan.action === 'skip') { say(`${name}: nothing to do, ${plan.reason}`); return { command: name, action: 'skip', reason: plan.reason }; }
  if (plan.action === 'stop') { console.error(`${name}: stopped, ${plan.reason}`); process.exitCode = 2; return { command: name, action: 'stop', reason: plan.reason }; }
  const guard = mainnetGuard({ network, networkFromArgs, yes, signing: true });
  const ptb = [...plan.ptb, '--gas-budget', String(gasBudget)];
  say(`${name}: ${plan.summary}`);
  say(`  signer ${plan.signer}`);
  say(`  sui client ptb ${ptb.map((a) => (/[\s<>\[\]]/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
  const dry = await ptbRun(ptb, { dryRun: true });
  say(`  dry run: ${dry.status}${dry.error ? ` (${dry.error})` : ''}${dry.gasUsed ? ` · gas ${JSON.stringify(dry.gasUsed)}` : ''}`);
  if (dry.status !== 'success') { console.error(`${name}: the dry run did not succeed; nothing was signed`); process.exitCode = 2; return { command: name, action: 'dry-run-failed', dry }; }
  if (!yes) { say(`${name}: dry run only. Re-run with --yes to sign this exact transaction.`); return { command: name, action: 'dry-run', dry }; }
  if (guard) { console.error(`${name}: ${guard}`); process.exitCode = 2; return { command: name, action: 'stop', reason: guard }; }
  if (network === 'mainnet') say(`  MAINNET: signing with ${plan.signer} in 5 seconds (Ctrl-C to abort)...`);
  if (network === 'mainnet') await new Promise((r) => setTimeout(r, 5000));
  const done = await ptbRun(ptb, { dryRun: false });
  say(`  executed: ${done.status} · digest ${done.digest}`);
  if (done.status !== 'success') { console.error(`${name}: execution status ${done.status} ${done.error ?? ''}`); process.exitCode = 2; return { command: name, action: 'executed', result: done }; }
  // GraphQL indexes a few seconds behind; confirm the intended state before claiming success.
  let confirmed = false; let last = null;
  for (let i = 0; i < 12 && !confirmed; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    try { last = await confirm(); confirmed = last.ok; } catch (e) { last = { ok: false, note: String(e.message).slice(0, 200) }; }
  }
  if (!confirmed) { console.error(`${name}: executed (digest ${done.digest}) but the chain read did not confirm it within 30 s: ${last?.note ?? ''}. Re-run status.`); process.exitCode = 2; }
  else say(`  confirmed on chain: ${last.note}`);
  return { command: name, action: 'executed', result: done, confirmed, note: last?.note ?? null };
}

// ---- commands -----------------------------------------------------------------------------------
async function main() {
  if (!command) fail('usage: registry-setup.mjs <status|bless|register-usdc|transfer-admin|transfer-upgrade-cap> [options]', 2);
  if (!isId(registryId)) fail(`set NEXT_PUBLIC_${NET}_NJANGI_ASSET_REGISTRY_ID or pass --registry`, 2);
  if (!isId(packageId)) fail(`set NEXT_PUBLIC_${NET}_PACKAGE_ID or pass --package`, 2);
  const earlyGuard = mainnetGuard({ network, networkFromArgs, yes, signing: false });
  if (earlyGuard && command !== 'status') fail(earlyGuard, 2);

  const status = await readRegistry(graphqlUrl, registryId);
  const cap = isId(capId) ? await readCap(graphqlUrl, capId) : null;
  if (command === 'status') {
    printStatus(status, cap);
    if (asJson) console.log(JSON.stringify({ network, registry: status, upgradeCap: cap }, null, 2));
    return;
  }
  if (!cap && (command === 'bless' || command === 'transfer-upgrade-cap')) fail(`no UpgradeCap id: pass --cap or add upgrade-capability to move/Published.toml [published.${network}]`, 2);

  const envErr = envGuard(network, await activeEnv());
  if (envErr) fail(envErr, 2);
  const sender = await activeAddress();
  printStatus(status, cap);
  say('');
  let out;
  if (command === 'bless') {
    out = await runPlan('bless', planBless(status, cap, packageId, sender), async () => {
      const s = await readRegistry(graphqlUrl, registryId); return { ok: s.canonical, note: s.canonical ? 'registry is canonical' : 'registry still not canonical' };
    });
  } else if (command === 'register-usdc') {
    const want = canonicalCoinType(coinType);
    const sourceRegistry = sourceNetwork === network ? registryId : (process.env[`NEXT_PUBLIC_${sourceNetwork.toUpperCase()}_NJANGI_ASSET_REGISTRY_ID`] || '').trim();
    if (!isId(sourceRegistry)) fail(`set NEXT_PUBLIC_${sourceNetwork.toUpperCase()}_NJANGI_ASSET_REGISTRY_ID: register-usdc copies the oracle id, max age and flags from the ${sourceNetwork} registry's USDC entry`, 2);
    const sourceStatus = sourceNetwork === network ? status : await readRegistry(GRAPHQL_URLS[sourceNetwork], sourceRegistry);
    const source = usdcEntryOf(sourceStatus, DEFAULT_USDC_COIN_TYPES[sourceNetwork]);
    if (!source) fail(`the ${sourceNetwork} registry has no USDC entry to copy the oracle id, max age and flags from`, 2);
    say(`source (${sourceNetwork} USDC): oracle ${source.oracleIdHex} · max age ${source.maxAgeSecs}s · flags ${source.flags} (${flagNames(source.flags).join(', ')}) · ${source.decimals} dp`);
    const metadata = await readMetadata(graphqlUrl, coinType);
    if (metadata) say(`${network} ${metadata.symbol} metadata ${metadata.id} (${metadata.decimals} dp, "${metadata.name}")`);
    out = await runPlan('register-usdc', planRegisterUsdc({ status, packageId, sender, coinType, metadata, source, network, explicitCoin: opt('--coin') !== undefined }), async () => {
      const s = await readRegistry(graphqlUrl, registryId); const a = s.assets.find((x) => x.coinType === want);
      return { ok: !!a && a.flags === source.flags, note: a ? `${prefixedCoinType(want)} registered with flags ${a.flags}` : 'asset not visible yet' };
    });
  } else if (command === 'transfer-admin') {
    const to = opt('--to');
    out = await runPlan('transfer-admin', planTransferAdmin(status, packageId, sender, to), async () => {
      const s = await readRegistry(graphqlUrl, registryId); return { ok: sameAddress(s.admin, to), note: `registry admin is now ${s.admin}` };
    });
  } else if (command === 'transfer-upgrade-cap') {
    const to = opt('--to');
    out = await runPlan('transfer-upgrade-cap', planTransferCap(cap, sender, to), async () => {
      const c = await readCap(graphqlUrl, capId); return { ok: !!c.owner && sameAddress(c.owner, to), note: `UpgradeCap owner is now ${c.owner ?? c.ownerKind}` };
    });
  } else fail(`unknown command ${command}`, 2);
  if (asJson) console.log(JSON.stringify(out, null, 2));
  if (network === 'mainnet') say(`\nmainnet order: ${MAINNET_ORDER.join(' → ')}`);
}

main().catch((e) => fail(e.stack || e.message));
