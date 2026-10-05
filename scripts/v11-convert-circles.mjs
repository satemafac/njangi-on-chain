#!/usr/bin/env node
// v11-convert-circles.mjs — the conversion step of the v11 publish window.
//
// Every circle created before v11 converts with the permissionless
// `njangi_circles::adopt_asset_policy<T>`: it pins the circle's asset terms
// and moves its legacy security deposits into v11 deposit records in the
// SAME custody wallet, per member, from the wallet's ledger. Nothing leaves
// the wallet. This script never signs anything:
//
//   node scripts/v11-convert-circles.mjs                 # dry run (devInspect)
//   node scripts/v11-convert-circles.mjs --emit <file>   # + unsigned tx bytes
//
// The dry run devInspects `adopt_asset_policy` for every circle of the lineage
// against the active package (which must already be v11) and prints which
// would convert. `--emit` additionally writes ONE unsigned transaction that
// converts every circle that passed, built for `--sender` (default: the
// address in SUI_SENDER, or the registry admin). The owner signs and executes
// it themselves, e.g.:
//
//   sui keytool sign --address <sender> --data "$(jq -r .txBytes <file>)"
//   sui client execute-signed-tx --tx-bytes <bytes> --signatures <signature>
//
// Afterwards, run the dry run again: every converted circle reports
// "already converted" (abort 91).
//
// Environment (same names as the app): NEXT_PUBLIC_SUI_NETWORK,
// NEXT_PUBLIC_<NET>_PACKAGE_ID, NEXT_PUBLIC_<NET>_NJANGI_ASSET_REGISTRY_ID,
// NEXT_PUBLIC_<NET>_USDC, NEXT_PUBLIC_<NET>_RPC_URL, NEXT_PUBLIC_<NET>_GRAPHQL_URL.
// The lineage's original package id comes from move/Published.toml.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SuiClient } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
    }
  }
}
loadDotEnv(path.join(ROOT, '.env.local'));

const args = process.argv.slice(2);
const argValue = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

const network = (argValue('--network') || process.env.NEXT_PUBLIC_SUI_NETWORK || 'testnet').toLowerCase();
const NET = network.toUpperCase();
const env = (key) => (process.env[`NEXT_PUBLIC_${NET}_${key}`] || '').trim();

const DEFAULTS = {
  testnet: {
    rpc: 'https://sui-testnet-rpc.publicnode.com',
    graphql: 'https://graphql.testnet.sui.io/graphql',
    usdc: '0x26b3bc67befc214058ca78ea9a2690298d731a2d4309485ec3d40198063c4abc::usdc::USDC',
  },
  mainnet: {
    rpc: 'https://sui-rpc.publicnode.com',
    graphql: 'https://graphql.mainnet.sui.io/graphql',
    usdc: '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC',
  },
}[network];
if (!DEFAULTS) {
  console.error(`Unknown network "${network}".`);
  process.exit(1);
}

function originalPackageId() {
  const toml = fs.readFileSync(path.join(ROOT, 'move', 'Published.toml'), 'utf8');
  const section = toml.split(/^\[published\./m).find((block) => block.startsWith(`${network}]`));
  const match = section && section.match(/original-id\s*=\s*"(0x[0-9a-f]+)"/);
  if (!match) throw new Error(`No original-id for ${network} in move/Published.toml`);
  return match[1];
}

const packageId = argValue('--package') || env('PACKAGE_ID');
const registryId = argValue('--registry') || env('NJANGI_ASSET_REGISTRY_ID');
const usdcType = env('USDC') || DEFAULTS.usdc;
const rpcUrl = env('RPC_URL') || DEFAULTS.rpc;
const graphqlUrl = DEFAULTS.graphql;
const emitFile = argValue('--emit');

if (!/^0x[0-9a-f]{1,64}$/i.test(packageId)) {
  console.error('Set NEXT_PUBLIC_<NET>_PACKAGE_ID (or --package) to the v11 package id.');
  process.exit(1);
}
if (!/^0x[0-9a-f]{1,64}$/i.test(registryId)) {
  console.error('Set NEXT_PUBLIC_<NET>_NJANGI_ASSET_REGISTRY_ID (or --registry).');
  process.exit(1);
}

const client = new SuiClient({ url: rpcUrl });
const ORIGINAL = originalPackageId();

async function gqlObjectsOfType(type) {
  const ids = [];
  let after = null;
  for (;;) {
    const res = await fetch(graphqlUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: 'query($t:String!,$a:String){ objects(filter:{type:$t}, first:50, after:$a){ nodes{ address } pageInfo{ hasNextPage endCursor } } }',
        variables: { t: type, a: after },
      }),
    });
    const body = await res.json();
    if (!body.data) throw new Error(`GraphQL error: ${JSON.stringify(body.errors || body)}`);
    ids.push(...body.data.objects.nodes.map((n) => n.address));
    if (!body.data.objects.pageInfo.hasNextPage) return ids;
    after = body.data.objects.pageInfo.endCursor;
  }
}

async function recordedWalletId(circleId) {
  try {
    const field = await client.getDynamicFieldObject({
      parentId: circleId,
      name: { type: '0x1::string::String', value: 'wallet_id' },
    });
    return field.data?.content?.fields?.value ?? null;
  } catch {
    return null;
  }
}

async function circleConfig(circleId) {
  const field = await client.getDynamicFieldObject({
    parentId: circleId,
    name: { type: 'vector<u8>', value: Array.from(Buffer.from('circle_config')) },
  });
  return field.data.content.fields.value.fields;
}

function pickWallet(circle, circleId, wallets, recorded) {
  const own = wallets.filter((w) => w.fields.circle_id === circleId);
  if (recorded && recorded !== circleId) return own.find((w) => w.id === recorded) || null;
  return own.find((w) => w.fields.admin === circle.admin && String(w.fields.created_at) === String(circle.created_at)) || null;
}

function adoptCall(tx, circleId, walletId, coinType) {
  tx.moveCall({
    target: `${packageId}::njangi_circles::adopt_asset_policy`,
    typeArguments: [coinType],
    arguments: [tx.object(circleId), tx.object(walletId), tx.object(registryId), tx.object('0x6')],
  });
}

async function main() {
  const registry = await client.getObject({ id: registryId, options: { showContent: true } });
  const registryAdmin = registry.data?.content?.fields?.admin;
  const sender = argValue('--sender') || process.env.SUI_SENDER || registryAdmin;
  console.log(`network ${network} · package ${packageId} · registry ${registryId} · sender ${sender}\n`);
  try {
    await client.getNormalizedMoveFunction({ package: packageId, module: 'njangi_circles', function: 'adopt_asset_policy' });
  } catch {
    console.error(`Package ${packageId} has no njangi_circles::adopt_asset_policy — point --package at the published v11 package.`);
    process.exit(1);
  }

  const circleIds = await gqlObjectsOfType(`${ORIGINAL}::njangi_circles::Circle`);
  const walletIds = await gqlObjectsOfType(`${ORIGINAL}::njangi_custody::CustodyWallet`);
  const walletObjects = [];
  for (let i = 0; i < walletIds.length; i += 50) {
    const page = await client.multiGetObjects({ ids: walletIds.slice(i, i + 50), options: { showContent: true } });
    walletObjects.push(...page.map((o) => ({ id: o.data.objectId, fields: o.data.content.fields })));
  }

  const convertible = [];
  for (const circleId of circleIds) {
    const circle = (await client.getObject({ id: circleId, options: { showContent: true } })).data.content.fields;
    const cfg = await circleConfig(circleId);
    const coinType = cfg.auto_swap_enabled ? '0x2::sui::SUI' : usdcType;
    const wallet = pickWallet(circle, circleId, walletObjects, await recordedWalletId(circleId));
    const label = `${circleId} ${JSON.stringify(circle.name)}`;
    if (!wallet) {
      console.log(`SKIP ${label}: custody wallet not found`);
      continue;
    }
    const tx = new Transaction();
    adoptCall(tx, circleId, wallet.id, coinType);
    let result;
    try {
      result = await client.devInspectTransactionBlock({ sender, transactionBlock: tx });
    } catch (error) {
      console.log(`--   ${label}: devInspect error: ${error.message}`);
      continue;
    }
    const status = result.effects?.status;
    if (status?.status === 'success') {
      convertible.push({ circleId, walletId: wallet.id, coinType });
      console.log(`OK   ${label} -> ${coinType.split('::').pop()} (wallet ${wallet.id})`);
    } else {
      const abort = String(status?.error || result.error || '').match(/, (\d+)\)/);
      const code = abort ? Number(abort[1]) : null;
      const reason = code === 91 ? 'already converted' : code === 88 ? 'ledger does not match' : `failed: ${status?.error || result.error}`;
      console.log(`--   ${label}: ${reason}`);
    }
  }

  console.log(`\n${convertible.length} of ${circleIds.length} circles would convert now.`);
  if (!emitFile || convertible.length === 0) return;

  const tx = new Transaction();
  tx.setSender(sender);
  for (const entry of convertible) adoptCall(tx, entry.circleId, entry.walletId, entry.coinType);
  tx.setGasBudget(50_000_000 + convertible.length * 20_000_000);
  const bytes = await tx.build({ client });
  const dry = await client.dryRunTransactionBlock({ transactionBlock: bytes });
  fs.writeFileSync(
    emitFile,
    JSON.stringify(
      {
        network,
        packageId,
        sender,
        circles: convertible,
        dryRunStatus: dry.effects.status,
        txBytes: Buffer.from(bytes).toString('base64'),
      },
      null,
      2,
    ),
  );
  console.log(`Unsigned transaction (dry run: ${dry.effects.status.status}) written to ${emitFile}. Sign it yourself; this script never signs.`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
