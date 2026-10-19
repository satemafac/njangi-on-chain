/**
 * registry-setup.ts — the network-free half of scripts/registry-setup.mjs: GraphQL queries and their
 * parsers, the decision for each command (run, skip or stop) and the exact `sui client ptb` arguments
 * that would be signed. Everything here is testable with recorded answers; the .mjs adds the fetch, the
 * CLI calls and the printing.
 *
 * Why GraphQL for reads: every public JSON-RPC endpoint for testnet is retired (publicnode on
 * 2026-10-16, the fullnodes in 2026-08), while graphql.{testnet,mainnet}.sui.io answer object reads on
 * both networks. Why the CLI for writes: the owner signs with the Sui CLI's keystore; the script never
 * holds a key, and the CLI resolves objects through its own endpoint, which still works for both
 * networks (it published v11).
 *
 * Imported by Node's type stripping as well as jest: keep it to plain TypeScript (no enums, no
 * parameter properties, no decorators) and no Node-only imports.
 */

export type Network = 'testnet' | 'mainnet';

export const GRAPHQL_URLS: Readonly<Record<Network, string>> = {
  testnet: 'https://graphql.testnet.sui.io/graphql',
  mainnet: 'https://graphql.mainnet.sui.io/graphql',
};

export const MODULE = 'njangi_price_validator';

/**
 * The native Circle USDC of each network. The app's single source is src/config/coin-types.ts; a script
 * cannot import it without Node re-parsing the app's module tree, so the values are repeated here and
 * src/__tests__/scripts/registry-setup.test.ts fails if the two ever differ.
 */
export const DEFAULT_USDC_COIN_TYPES: Readonly<Record<Network, string>> = {
  testnet: '0x26b3bc67befc214058ca78ea9a2690298d731a2d4309485ec3d40198063c4abc::usdc::USDC',
  mainnet: '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC',
};

/** Role flags of a registered asset (njangi_price_validator.move). */
export const FLAG_SETTLEMENT = 1;
export const FLAG_DEPOSIT = 2;
export const FLAG_USD_PEGGED = 4;
export const ALL_FLAGS = 7;

export function flagNames(flags: number): string[] {
  const out: string[] = [];
  if (flags & FLAG_SETTLEMENT) out.push('settlement');
  if (flags & FLAG_DEPOSIT) out.push('deposit');
  if (flags & FLAG_USD_PEGGED) out.push('usd-pegged');
  return out;
}

// ---------------------------------------------------------------------------------------------
// Coin types. The registry keys its table and its flag fields by the Move-canonical bytes of the
// type: a 64-hex address without 0x, as `core::coin_type_bytes<T>` writes it. The app and the env
// write the short form with 0x. Compare only after normalizing to the canonical form.
// ---------------------------------------------------------------------------------------------
const COIN_TYPE = /^(0x)?([0-9a-fA-F]{1,64})::([A-Za-z_][A-Za-z0-9_]*)::([A-Za-z_][A-Za-z0-9_]*)$/;

export function canonicalCoinType(type: string): string {
  const m = COIN_TYPE.exec(type.trim());
  if (!m) throw new Error(`not a coin type: ${JSON.stringify(type)}`);
  return `${m[2].toLowerCase().padStart(64, '0')}::${m[3]}::${m[4]}`;
}

/** The `0x…` form the CLI's type arguments and the app's env use. */
export function prefixedCoinType(type: string): string {
  return `0x${canonicalCoinType(type)}`;
}

export const SUI_CANONICAL = canonicalCoinType('0x2::sui::SUI');

export function b64ToBytes(b64: string): number[] {
  return Array.from(Buffer.from(b64, 'base64'));
}
export function b64ToAscii(b64: string): string {
  return Buffer.from(b64, 'base64').toString('utf8');
}
export function bytesToHex(bytes: readonly number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
}
export function hexToBytes(hex: string): number[] {
  const h = hex.replace(/^0x/, '');
  if (!/^[0-9a-fA-F]*$/.test(h) || h.length % 2 !== 0) throw new Error(`not hex: ${hex}`);
  const out: number[] = [];
  for (let i = 0; i < h.length; i += 2) out.push(parseInt(h.slice(i, i + 2), 16));
  return out;
}

// ---------------------------------------------------------------------------------------------
// GraphQL queries (strings; the caller posts them) and their parsers.
// ---------------------------------------------------------------------------------------------
export const DYNAMIC_FIELD_SELECTION =
  'dynamicFields(first:50){ nodes{ name{ type{repr} json } value{ __typename ... on MoveValue { type{repr} json } ... on MoveObject { contents { type{repr} json } } } } }';

export function registryQuery(registryId: string): string {
  return `{ object(address:"${registryId}"){ asMoveObject { contents { type{repr} json } } ${DYNAMIC_FIELD_SELECTION} } }`;
}
/** A Table's entries hang off a UID that is not an object; GraphQL reaches them through `address`. */
export function tableEntriesQuery(tableId: string): string {
  return `{ address(address:"${tableId}"){ ${DYNAMIC_FIELD_SELECTION} } }`;
}
export function objectOwnerQuery(objectId: string): string {
  return `{ object(address:"${objectId}"){ version owner { __typename ... on AddressOwner { address { address } } ... on Shared { initialSharedVersion } } asMoveObject { contents { type{repr} json } } } }`;
}
export function coinMetadataQuery(coinType: string): string {
  return `{ coinMetadata(coinType:"${prefixedCoinType(coinType)}"){ address decimals symbol name } }`;
}

export interface RegisteredAsset {
  coinType: string; // canonical, no 0x
  oracleIdHex: string;
  decimals: number;
  maxAgeSecs: number;
  enabled: boolean;
  flags: number; // 0 when no flag field exists (an asset registered before v11)
}
export interface RegistryStatus {
  registryId: string;
  type: string; // defining package of AssetRegistry
  admin: string;
  canonical: boolean;
  tableId: string;
  assetCount: number;
  assets: RegisteredAsset[];
}
export interface UpgradeCapStatus {
  id: string;
  owner: string | null; // null when shared or immutable
  ownerKind: string;
  package: string;
  version: number;
  policy: number;
}
export interface CoinMetadataStatus { id: string; decimals: number; symbol: string; name: string }

type DfNode = { name: { type: { repr: string }; json: unknown }; value: { __typename: string; type?: { repr: string }; json?: unknown; contents?: { type: { repr: string }; json: unknown } } };

export function parseRegistry(registryAnswer: unknown, tableAnswer: unknown): RegistryStatus {
  const obj = (registryAnswer as { data?: { object?: { asMoveObject?: { contents?: { type: { repr: string }; json: { id: string; admin: string; assets: { id: string; size: string } } } }; dynamicFields?: { nodes: DfNode[] } } } }).data?.object;
  const contents = obj?.asMoveObject?.contents;
  if (!contents) throw new Error('the registry object was not found or is not a Move object');
  if (!contents.type.repr.endsWith(`::${MODULE}::AssetRegistry`)) throw new Error(`object is a ${contents.type.repr}, not an AssetRegistry`);
  const flagsByType = new Map<string, number>();
  let canonical = false;
  for (const n of obj?.dynamicFields?.nodes ?? []) {
    if (n.name.type.repr.endsWith(`::${MODULE}::CanonicalKey`)) canonical = n.value.json === true;
    if (n.name.type.repr.endsWith(`::${MODULE}::AssetFlagsKey`)) {
      const key = b64ToAscii((n.name.json as { coin_type: string }).coin_type);
      flagsByType.set(key, Number(n.value.json));
    }
  }
  const entries = (tableAnswer as { data?: { address?: { dynamicFields?: { nodes: DfNode[] } } } }).data?.address?.dynamicFields?.nodes;
  if (!entries) throw new Error('the registry\'s asset table could not be read');
  const assets: RegisteredAsset[] = entries.map((n) => {
    const coinType = b64ToAscii(n.name.json as string);
    const v = (n.value.json ?? n.value.contents?.json) as { oracle_price_id: string; decimals: number; max_age_secs: string | number; enabled: boolean };
    return { coinType, oracleIdHex: bytesToHex(b64ToBytes(v.oracle_price_id)), decimals: Number(v.decimals), maxAgeSecs: Number(v.max_age_secs), enabled: v.enabled === true, flags: flagsByType.get(coinType) ?? 0 };
  });
  const size = Number(contents.json.assets.size);
  if (assets.length !== size) throw new Error(`the asset table says ${size} entries but ${assets.length} were read; refusing to plan on a partial read`);
  return { registryId: contents.json.id, type: contents.type.repr, admin: contents.json.admin, canonical, tableId: contents.json.assets.id, assetCount: size, assets };
}

export function parseUpgradeCap(answer: unknown): UpgradeCapStatus {
  const obj = (answer as { data?: { object?: { owner?: { __typename: string; address?: { address: string } }; asMoveObject?: { contents?: { type: { repr: string }; json: { id: string; package: string; version: string; policy: number } } } } } }).data?.object;
  const contents = obj?.asMoveObject?.contents;
  if (!contents) throw new Error('the UpgradeCap object was not found');
  if (!contents.type.repr.endsWith('::package::UpgradeCap')) throw new Error(`object is a ${contents.type.repr}, not an UpgradeCap`);
  const ownerKind = obj?.owner?.__typename ?? 'unknown';
  return { id: contents.json.id, owner: ownerKind === 'AddressOwner' ? (obj?.owner?.address?.address ?? null) : null, ownerKind, package: contents.json.package, version: Number(contents.json.version), policy: Number(contents.json.policy) };
}

export function parseCoinMetadata(answer: unknown): CoinMetadataStatus | null {
  const m = (answer as { data?: { coinMetadata?: { address: string; decimals: number; symbol: string; name: string } | null } }).data?.coinMetadata;
  return m ? { id: m.address, decimals: Number(m.decimals), symbol: m.symbol, name: m.name } : null;
}

// ---------------------------------------------------------------------------------------------
// Plans: what a command would do, before anything is built or signed.
// ---------------------------------------------------------------------------------------------
export type Plan =
  | { action: 'run'; summary: string; ptb: string[]; signer: string }
  | { action: 'skip'; reason: string }
  | { action: 'stop'; reason: string };

const isAddress = (s: string) => /^0x[0-9a-fA-F]{1,64}$/.test(s);
const ZERO = /^0x0*$/;
export function sameAddress(a: string, b: string): boolean {
  const n = (x: string) => x.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  return n(a) === n(b);
}

export const DEFAULT_GAS_BUDGET = 50_000_000;

/** `sui client ptb` arguments for one Move call; the caller appends --gas-budget and --dry-run/--json. */
export function blessPtb(packageId: string, registryId: string, capId: string): string[] {
  return ['--move-call', `${packageId}::${MODULE}::bless_canonical`, `@${registryId}`, `@${capId}`];
}
export function registerWithMetadataPtb(packageId: string, registryId: string, coinType: string, metadataId: string, oracleIdHex: string, maxAgeSecs: number, flags: number): string[] {
  const bytes = hexToBytes(oracleIdHex);
  if (bytes.length !== 32) throw new Error(`an oracle price id is 32 bytes, got ${bytes.length}`);
  return [
    '--make-move-vec', '<u8>', `[${bytes.join(',')}]`,
    '--assign', 'price_id',
    '--move-call', `${packageId}::${MODULE}::register_asset_with_metadata`, `<${prefixedCoinType(coinType)}>`, `@${registryId}`, `@${metadataId}`, 'price_id', `${maxAgeSecs}u64`, `${flags}u64`,
  ];
}
export function transferAdminPtb(packageId: string, registryId: string, to: string): string[] {
  return ['--move-call', `${packageId}::${MODULE}::transfer_registry_admin`, `@${registryId}`, `@${to}`];
}
export function transferObjectPtb(objectId: string, to: string): string[] {
  return ['--transfer-objects', `[@${objectId}]`, `@${to}`];
}

export function planBless(status: RegistryStatus, cap: UpgradeCapStatus, packageId: string, sender: string): Plan {
  if (status.canonical) return { action: 'skip', reason: `registry ${status.registryId} is already canonical` };
  if (!cap.owner) return { action: 'stop', reason: `the UpgradeCap is ${cap.ownerKind}, not owned by an address; bless_canonical needs its holder to sign` };
  if (!sameAddress(cap.owner, sender)) return { action: 'stop', reason: `the UpgradeCap is owned by ${cap.owner}, but the CLI's active address is ${sender}` };
  if (!sameAddress(cap.package, packageId)) return { action: 'stop', reason: `the UpgradeCap belongs to package ${cap.package}, not ${packageId}; blessing with a foreign cap aborts (E_FOREIGN_UPGRADE_CAP)` };
  return { action: 'run', summary: `bless_canonical on ${status.registryId} with UpgradeCap ${cap.id} (package ${cap.package} v${cap.version})`, ptb: blessPtb(packageId, status.registryId, cap.id), signer: cap.owner };
}

export interface UsdcSource { coinType: string; oracleIdHex: string; maxAgeSecs: number; flags: number; decimals: number }

/** The USDC entry of a registry: what mainnet copies from testnet (oracle id, max age, flags). */
export function usdcEntryOf(status: RegistryStatus, usdcType: string): UsdcSource | null {
  const want = canonicalCoinType(usdcType);
  const a = status.assets.find((x) => x.coinType === want);
  return a ? { coinType: a.coinType, oracleIdHex: a.oracleIdHex, maxAgeSecs: a.maxAgeSecs, flags: a.flags, decimals: a.decimals } : null;
}

export function planRegisterUsdc(args: { status: RegistryStatus; packageId: string; sender: string; coinType: string; metadata: CoinMetadataStatus | null; source: UsdcSource; network: Network; explicitCoin: boolean }): Plan {
  const { status, source } = args;
  const want = canonicalCoinType(args.coinType);
  if (!sameAddress(status.admin, args.sender)) return { action: 'stop', reason: `the registry admin is ${status.admin}, but the CLI's active address is ${args.sender}` };
  if (!status.canonical) return { action: 'stop', reason: 'the registry is not canonical yet; run bless first so the lineage is pinned before assets are registered' };
  if (args.network === 'mainnet' && args.explicitCoin && !want.endsWith('::usdc::USDC')) return { action: 'stop', reason: `mainnet registers USDC only at launch (decision 2026-10-18); ${args.coinType} needs its own decision` };
  const existing = status.assets.find((a) => a.coinType === want);
  if (existing) {
    if (existing.flags === source.flags) return { action: 'skip', reason: `${want} is already registered with flags ${existing.flags} (${flagNames(existing.flags).join(', ')})` };
    return { action: 'stop', reason: `${want} is registered with flags ${existing.flags} but the source has ${source.flags}; set_asset_flags is a separate decision, not done here` };
  }
  if (!args.metadata) return { action: 'stop', reason: `no CoinMetadata found for ${args.coinType} on ${args.network}; register_asset_with_metadata needs it` };
  if (args.metadata.decimals !== source.decimals) return { action: 'stop', reason: `${args.coinType} has ${args.metadata.decimals} decimals on ${args.network} but the source entry has ${source.decimals}; the USD-peg formula depends on it` };
  if (source.flags & ~ALL_FLAGS) return { action: 'stop', reason: `source flags ${source.flags} are outside the contract's ${ALL_FLAGS}` };
  return {
    action: 'run',
    summary: `register_asset_with_metadata<${prefixedCoinType(want)}> on ${status.registryId}: metadata ${args.metadata.id} (${args.metadata.decimals} dp), oracle ${source.oracleIdHex}, max age ${source.maxAgeSecs}s, flags ${source.flags} (${flagNames(source.flags).join(', ')})`,
    ptb: registerWithMetadataPtb(args.packageId, status.registryId, want, args.metadata.id, source.oracleIdHex, source.maxAgeSecs, source.flags),
    signer: status.admin,
  };
}

export function planTransferAdmin(status: RegistryStatus, packageId: string, sender: string, to: string | undefined): Plan {
  if (!to || !isAddress(to)) return { action: 'stop', reason: 'pass --to <address> (the multisig address)' };
  if (ZERO.test(to)) return { action: 'stop', reason: 'refusing to transfer the registry admin to 0x0 (the contract aborts with E_INVALID_ADMIN, and nobody could ever administer it)' };
  if (!status.canonical) return { action: 'stop', reason: 'the registry is not canonical; bless it first, since blessing needs the UpgradeCap holder and the admin handover comes last' };
  if (!sameAddress(status.admin, sender)) return { action: 'stop', reason: `the registry admin is ${status.admin}, but the CLI's active address is ${sender}` };
  if (sameAddress(status.admin, to)) return { action: 'skip', reason: `${to} is already the registry admin` };
  return { action: 'run', summary: `transfer_registry_admin on ${status.registryId}: ${status.admin} → ${to}`, ptb: transferAdminPtb(packageId, status.registryId, to), signer: status.admin };
}

export function planTransferCap(cap: UpgradeCapStatus, sender: string, to: string | undefined): Plan {
  if (!to || !isAddress(to)) return { action: 'stop', reason: 'pass --to <address> (the multisig address)' };
  if (ZERO.test(to)) return { action: 'stop', reason: 'refusing to send the UpgradeCap to 0x0: that is not immutability, it is loss' };
  if (!cap.owner) return { action: 'stop', reason: `the UpgradeCap is ${cap.ownerKind}, not owned by an address` };
  if (!sameAddress(cap.owner, sender)) return { action: 'stop', reason: `the UpgradeCap is owned by ${cap.owner}, but the CLI's active address is ${sender}` };
  if (sameAddress(cap.owner, to)) return { action: 'skip', reason: `${to} already owns the UpgradeCap` };
  return { action: 'run', summary: `transfer UpgradeCap ${cap.id} (package ${cap.package} v${cap.version}, policy ${cap.policy}): ${cap.owner} → ${to}. IRREVERSIBLE.`, ptb: transferObjectPtb(cap.id, to), signer: cap.owner };
}

/** Mainnet is never implied: the word must be on the command line, and signing needs --yes as well. */
export function mainnetGuard(args: { network: Network; networkFromArgs: boolean; yes: boolean; signing: boolean }): string | null {
  if (args.network !== 'mainnet') return null;
  if (!args.networkFromArgs) return 'mainnet must be spelled out: pass --network mainnet (the env file alone does not select it)';
  if (args.signing && !args.yes) return 'signing on mainnet needs --yes after you have read the dry run';
  return null;
}

/** The active CLI environment must be the network the command names. */
export function envGuard(network: Network, activeEnv: string): string | null {
  return activeEnv.trim() === network ? null : `the Sui CLI's active env is "${activeEnv.trim()}", not "${network}": run \`sui client switch --env ${network}\` first`;
}

/**
 * What `sui client ptb` reports. A dry run prints prose and a table even with --json
 * ("Dry run completed, execution status: success"); an execution prints JSON with --json. Both are
 * reduced to the same shape here, and anything unreadable is "unknown", never a success.
 */
export interface CliOutcome { status: string; error: string | null; digest: string | null; gasUsed: unknown }
export function parseCliOutcome(output: string | Record<string, unknown>): CliOutcome {
  if (typeof output !== 'string') {
    const effects = (output as { effects?: { status?: unknown; gasUsed?: unknown; transactionDigest?: string } }).effects;
    const raw = effects?.status ?? (output as { status?: unknown }).status;
    const status = typeof raw === 'string' ? raw : (raw as { status?: string } | undefined)?.status ?? 'unknown';
    const error = typeof raw === 'object' && raw ? ((raw as { error?: string }).error ?? null) : null;
    return { status: status.toLowerCase(), error, digest: (output as { digest?: string }).digest ?? effects?.transactionDigest ?? null, gasUsed: effects?.gasUsed ?? null };
  }
  const status = /execution status:\s*([A-Za-z]+)/i.exec(output)?.[1]?.toLowerCase() ?? 'unknown';
  const digest = /Transaction Digest:\s*([1-9A-HJ-NP-Za-km-z]{32,64})/.exec(output)?.[1] ?? null;
  let error: string | null = null;
  if (status !== 'success') {
    const line = output.split('\n').find((l) => /abort|error|failure/i.test(l) && !/execution status/i.test(l));
    error = (line ?? output.split('\n')[0] ?? '').replace(/[│╭╰├─]/g, '').trim().slice(0, 300) || null;
  }
  return { status, error, digest, gasUsed: null };
}

/** The order the mainnet runbook runs these in, for the printed reminder. */
export const MAINNET_ORDER = ['status', 'bless', 'register-usdc', 'transfer-admin --to <multisig>', 'transfer-upgrade-cap --to <multisig>', 'status'] as const;
