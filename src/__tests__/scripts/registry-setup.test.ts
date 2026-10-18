/**
 * scripts/registry-setup.mjs: the post-publish AssetRegistry steps of the mainnet runbook. These tests
 * pin the parsers to recorded GraphQL answers from testnet (read 2026-10-18: registry 0x1668b503…,
 * UpgradeCap 0xc590f7b3…, both USDC metadata objects) and the plans and guards that decide what the
 * script may sign. Nothing here touches a network.
 */
import { DEFAULT_USDC_COIN_TYPES as APP_USDC } from '../../config/coin-types';
import {
  ALL_FLAGS,
  DEFAULT_USDC_COIN_TYPES,
  MAINNET_ORDER,
  b64ToAscii,
  blessPtb,
  canonicalCoinType,
  coinMetadataQuery,
  envGuard,
  flagNames,
  hexToBytes,
  mainnetGuard,
  parseCliOutcome,
  parseCoinMetadata,
  parseRegistry,
  parseUpgradeCap,
  planBless,
  planRegisterUsdc,
  planTransferAdmin,
  planTransferCap,
  prefixedCoinType,
  registerWithMetadataPtb,
  sameAddress,
  transferAdminPtb,
  transferObjectPtb,
  usdcEntryOf,
  type RegistryStatus,
  type UpgradeCapStatus,
} from '../../../scripts/lib/registry-setup';

const REGISTRY = '0x1668b5030d65a87523df4374c739c4707a1dbef3d17dd498f1a8d2d10c71a72c';
const TABLE = '0xef42a1199214e7daa68c6912652a3ef007821aa6ca45b15107f9079c09e92c77';
const DEPLOYER = '0xdde1086c98c6023db8e3d8267992e4c9aeba3d0271f6bac85dc2f6daa8301c77';
const V11 = '0x5f71b5c82f167be517a09604a1f911a642e037ce0ae2e8f9e004f67eb52893ee';
const ORIGINAL = '0x89cddf4dfe654e7c7b16333096d9e750cf04bb96f7de934403a512d460594f02';
const CAP = '0xc590f7b3ad86a637d2a85100703417b1a918dd02d64ebdc2c8413d0d179a7cb4';
const TESTNET_USDC = '0x26b3bc67befc214058ca78ea9a2690298d731a2d4309485ec3d40198063c4abc::usdc::USDC';
const MAINNET_USDC = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';
const MULTISIG = '0x1111111111111111111111111111111111111111111111111111111111111111';
const USDC_ORACLE = 'eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a';

const b64 = (s: string) => Buffer.from(s).toString('base64');
const suiKey = '0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';
const usdcKey = '26b3bc67befc214058ca78ea9a2690298d731a2d4309485ec3d40198063c4abc::usdc::USDC';

const registryAnswer = (over: { canonical?: boolean; flags?: Record<string, number> } = {}) => ({
  data: {
    object: {
      asMoveObject: { contents: { type: { repr: `${ORIGINAL}::njangi_price_validator::AssetRegistry` }, json: { id: REGISTRY, admin: DEPLOYER, assets: { id: TABLE, size: '2' } } } },
      dynamicFields: {
        nodes: [
          ...(over.canonical === false ? [] : [{ name: { type: { repr: `${V11}::njangi_price_validator::CanonicalKey` }, json: { dummy_field: false } }, value: { __typename: 'MoveValue', type: { repr: 'bool' }, json: true } }]),
          ...Object.entries(over.flags ?? { [suiKey]: 3, [usdcKey]: 7 }).map(([k, v]) => ({ name: { type: { repr: `${V11}::njangi_price_validator::AssetFlagsKey` }, json: { coin_type: b64(k) } }, value: { __typename: 'MoveValue', type: { repr: 'u64' }, json: String(v) } })),
        ],
      },
    },
  },
});
const tableAnswer = {
  data: {
    address: {
      dynamicFields: {
        nodes: [
          { name: { type: { repr: 'vector<u8>' }, json: b64(suiKey) }, value: { __typename: 'MoveValue', type: { repr: `${ORIGINAL}::njangi_price_validator::AssetEntry` }, json: { oracle_price_id: 'VFDclTbyM+qGPOn4kZGm91X4Djk7or4gV9ur2gzEB8k=', decimals: 9, max_age_secs: '60', enabled: true } } },
          { name: { type: { repr: 'vector<u8>' }, json: b64(usdcKey) }, value: { __typename: 'MoveValue', type: { repr: `${ORIGINAL}::njangi_price_validator::AssetEntry` }, json: { oracle_price_id: '6qAgxhzEeXEoE0Yc4VOJSpamwAsh7Qz8J5jR+anpyUo=', decimals: 6, max_age_secs: '60', enabled: true } } },
        ],
      },
    },
  },
};
const capAnswer = (owner: string | null = DEPLOYER, pkg = V11) => ({
  data: { object: { version: 1005821085, owner: owner ? { __typename: 'AddressOwner', address: { address: owner } } : { __typename: 'Shared', initialSharedVersion: 1 }, asMoveObject: { contents: { type: { repr: '0x0000000000000000000000000000000000000000000000000000000000000002::package::UpgradeCap' }, json: { id: CAP, package: pkg, version: '11', policy: 0 } } } } },
});
const metadataAnswer = { data: { coinMetadata: { address: '0x75cfbbf8c962d542e99a1d15731e6069f60a00db895407785b15d14f606f2b4a', decimals: 6, symbol: 'USDC', name: 'USDC' } } };

describe('coin types', () => {
  it('keeps the same USDC types as the app (src/config/coin-types.ts)', () => {
    expect(DEFAULT_USDC_COIN_TYPES).toEqual(APP_USDC);
  });
  it('normalizes to the registry key form (64-hex address, no 0x) and back', () => {
    expect(canonicalCoinType('0x2::sui::SUI')).toBe(suiKey);
    expect(canonicalCoinType(TESTNET_USDC)).toBe(usdcKey);
    expect(prefixedCoinType(usdcKey)).toBe(TESTNET_USDC);
    expect(() => canonicalCoinType('usdc')).toThrow(/not a coin type/);
    expect(b64ToAscii(b64(usdcKey))).toBe(usdcKey);
    expect(hexToBytes('0x0aff')).toEqual([10, 255]);
    expect(sameAddress('0x2', '0x0000000000000000000000000000000000000000000000000000000000000002')).toBe(true);
  });
});

describe('parsers (recorded testnet answers)', () => {
  it('reads the registry: admin, canonical flag, the two assets with their flags and oracle ids', () => {
    const s = parseRegistry(registryAnswer(), tableAnswer);
    expect(s).toMatchObject({ registryId: REGISTRY, admin: DEPLOYER, canonical: true, tableId: TABLE, assetCount: 2 });
    expect(s.assets).toEqual([
      { coinType: suiKey, oracleIdHex: '5450dc9536f233ea863ce9f89191a6f755f80e393ba2be2057dbabda0cc407c9', decimals: 9, maxAgeSecs: 60, enabled: true, flags: 3 },
      { coinType: usdcKey, oracleIdHex: USDC_ORACLE, decimals: 6, maxAgeSecs: 60, enabled: true, flags: 7 },
    ]);
    expect(flagNames(7)).toEqual(['settlement', 'deposit', 'usd-pegged']);
    expect(flagNames(3)).toEqual(['settlement', 'deposit']);
  });
  it('refuses a partial table read and a wrong object type', () => {
    const partial = { data: { address: { dynamicFields: { nodes: tableAnswer.data.address.dynamicFields.nodes.slice(0, 1) } } } };
    expect(() => parseRegistry(registryAnswer(), partial)).toThrow(/2 entries but 1 were read/);
    const wrong = JSON.parse(JSON.stringify(registryAnswer()));
    wrong.data.object.asMoveObject.contents.type.repr = `${ORIGINAL}::njangi_circles::Circle`;
    expect(() => parseRegistry(wrong, tableAnswer)).toThrow(/not an AssetRegistry/);
    expect(() => parseRegistry({ data: { object: null } }, tableAnswer)).toThrow(/not found/);
  });
  it('reads the UpgradeCap owner, package, version and policy; shared caps have no owner', () => {
    expect(parseUpgradeCap(capAnswer())).toEqual({ id: CAP, owner: DEPLOYER, ownerKind: 'AddressOwner', package: V11, version: 11, policy: 0 });
    expect(parseUpgradeCap(capAnswer(null))).toMatchObject({ owner: null, ownerKind: 'Shared' });
  });
  it('reads coin metadata, and absent metadata is null', () => {
    expect(parseCoinMetadata(metadataAnswer)).toEqual({ id: '0x75cfbbf8c962d542e99a1d15731e6069f60a00db895407785b15d14f606f2b4a', decimals: 6, symbol: 'USDC', name: 'USDC' });
    expect(parseCoinMetadata({ data: { coinMetadata: null } })).toBeNull();
    expect(coinMetadataQuery(usdcKey)).toContain(`coinType:"${TESTNET_USDC}"`);
  });
});

describe('plans', () => {
  const status: RegistryStatus = parseRegistry(registryAnswer(), tableAnswer);
  const unblessed: RegistryStatus = parseRegistry(registryAnswer({ canonical: false }), tableAnswer);
  const cap: UpgradeCapStatus = parseUpgradeCap(capAnswer());

  it('bless: skips a canonical registry, runs for the cap holder, stops for anyone else or a foreign cap', () => {
    expect(planBless(status, cap, V11, DEPLOYER)).toMatchObject({ action: 'skip' });
    const run = planBless(unblessed, cap, V11, DEPLOYER);
    expect(run).toMatchObject({ action: 'run', signer: DEPLOYER, ptb: blessPtb(V11, REGISTRY, CAP) });
    expect(blessPtb(V11, REGISTRY, CAP)).toEqual(['--move-call', `${V11}::njangi_price_validator::bless_canonical`, `@${REGISTRY}`, `@${CAP}`]);
    expect(planBless(unblessed, cap, V11, MULTISIG)).toMatchObject({ action: 'stop', reason: expect.stringContaining('active address') });
    expect(planBless(unblessed, parseUpgradeCap(capAnswer(DEPLOYER, ORIGINAL)), V11, DEPLOYER)).toMatchObject({ action: 'stop', reason: expect.stringContaining('E_FOREIGN_UPGRADE_CAP') });
    expect(planBless(unblessed, parseUpgradeCap(capAnswer(null)), V11, DEPLOYER)).toMatchObject({ action: 'stop' });
  });

  it('register-usdc: copies the testnet entry (oracle, max age, flags) onto mainnet USDC through its CoinMetadata', () => {
    const source = usdcEntryOf(status, TESTNET_USDC)!;
    expect(source).toEqual({ coinType: usdcKey, oracleIdHex: USDC_ORACLE, maxAgeSecs: 60, flags: 7, decimals: 6 });
    const mainnetEmpty: RegistryStatus = { ...status, assets: status.assets.filter((a) => a.coinType === suiKey), assetCount: 1 };
    const plan = planRegisterUsdc({ status: mainnetEmpty, packageId: V11, sender: DEPLOYER, coinType: MAINNET_USDC, metadata: parseCoinMetadata(metadataAnswer), source, network: 'mainnet', explicitCoin: false });
    expect(plan.action).toBe('run');
    const ptb = (plan as { ptb: string[] }).ptb;
    expect(ptb.slice(0, 5)).toEqual(['--make-move-vec', '<u8>', `[${hexToBytes(USDC_ORACLE).join(',')}]`, '--assign', 'price_id']);
    expect(ptb.slice(5)).toEqual(['--move-call', `${V11}::njangi_price_validator::register_asset_with_metadata`, `<${MAINNET_USDC}>`, `@${REGISTRY}`, '@0x75cfbbf8c962d542e99a1d15731e6069f60a00db895407785b15d14f606f2b4a', 'price_id', '60u64', '7u64']);
    expect(registerWithMetadataPtb(V11, REGISTRY, usdcKey, '0xabc', USDC_ORACLE, 60, 7)[7]).toBe(`<${TESTNET_USDC}>`);
    expect(() => registerWithMetadataPtb(V11, REGISTRY, usdcKey, '0xabc', 'abcd', 60, 7)).toThrow(/32 bytes/);
  });
  it('register-usdc: skips when registered alike, stops on a flags mismatch, a non-admin, an unblessed registry, missing metadata, wrong decimals, or another coin on mainnet', () => {
    const source = usdcEntryOf(status, TESTNET_USDC)!;
    const base = { status, packageId: V11, sender: DEPLOYER, coinType: TESTNET_USDC, metadata: parseCoinMetadata(metadataAnswer), source, network: 'testnet' as const, explicitCoin: false };
    expect(planRegisterUsdc(base)).toMatchObject({ action: 'skip', reason: expect.stringContaining('already registered with flags 7') });
    expect(planRegisterUsdc({ ...base, source: { ...source, flags: 3 } })).toMatchObject({ action: 'stop', reason: expect.stringContaining('set_asset_flags') });
    expect(planRegisterUsdc({ ...base, sender: MULTISIG })).toMatchObject({ action: 'stop', reason: expect.stringContaining('registry admin') });
    expect(planRegisterUsdc({ ...base, status: unblessed })).toMatchObject({ action: 'stop', reason: expect.stringContaining('not canonical') });
    const empty = { ...status, assets: [], assetCount: 0 };
    expect(planRegisterUsdc({ ...base, status: empty, metadata: null })).toMatchObject({ action: 'stop', reason: expect.stringContaining('CoinMetadata') });
    expect(planRegisterUsdc({ ...base, status: empty, metadata: { ...parseCoinMetadata(metadataAnswer)!, decimals: 9 } })).toMatchObject({ action: 'stop', reason: expect.stringContaining('decimals') });
    expect(planRegisterUsdc({ ...base, status: empty, network: 'mainnet', explicitCoin: true, coinType: '0x2::sui::SUI' })).toMatchObject({ action: 'stop', reason: expect.stringContaining('USDC only') });
    expect(planRegisterUsdc({ ...base, status: empty, source: { ...source, flags: 8 } })).toMatchObject({ action: 'stop', reason: expect.stringContaining(String(ALL_FLAGS)) });
  });

  it('transfer-admin: needs a target, refuses 0x0 and an unblessed registry, runs only for the current admin, skips when already there', () => {
    expect(planTransferAdmin(status, V11, DEPLOYER, undefined)).toMatchObject({ action: 'stop', reason: expect.stringContaining('--to') });
    expect(planTransferAdmin(status, V11, DEPLOYER, '0x0')).toMatchObject({ action: 'stop', reason: expect.stringContaining('0x0') });
    expect(planTransferAdmin(unblessed, V11, DEPLOYER, MULTISIG)).toMatchObject({ action: 'stop', reason: expect.stringContaining('not canonical') });
    expect(planTransferAdmin(status, V11, MULTISIG, MULTISIG)).toMatchObject({ action: 'stop', reason: expect.stringContaining('registry admin') });
    expect(planTransferAdmin(status, V11, DEPLOYER, DEPLOYER)).toMatchObject({ action: 'skip' });
    expect(planTransferAdmin(status, V11, DEPLOYER, MULTISIG)).toMatchObject({ action: 'run', signer: DEPLOYER, ptb: transferAdminPtb(V11, REGISTRY, MULTISIG) });
    expect(transferAdminPtb(V11, REGISTRY, MULTISIG)).toEqual(['--move-call', `${V11}::njangi_price_validator::transfer_registry_admin`, `@${REGISTRY}`, `@${MULTISIG}`]);
  });
  it('transfer-upgrade-cap: a plain object transfer by the holder, never to 0x0, marked irreversible', () => {
    expect(planTransferCap(cap, DEPLOYER, '0x0')).toMatchObject({ action: 'stop' });
    expect(planTransferCap(cap, MULTISIG, MULTISIG)).toMatchObject({ action: 'stop', reason: expect.stringContaining('active address') });
    expect(planTransferCap(cap, DEPLOYER, DEPLOYER)).toMatchObject({ action: 'skip' });
    const run = planTransferCap(cap, DEPLOYER, MULTISIG);
    expect(run).toMatchObject({ action: 'run', ptb: transferObjectPtb(CAP, MULTISIG), summary: expect.stringContaining('IRREVERSIBLE') });
    expect(transferObjectPtb(CAP, MULTISIG)).toEqual(['--transfer-objects', `[@${CAP}]`, `@${MULTISIG}`]);
  });
});

describe('CLI outcomes', () => {
  it("reads a dry run's prose header, and JSON or text from an execution; the unreadable is unknown", () => {
    const dry = 'Dry run completed, execution status: success\n╭──────╮\n│ Dry Run Transaction Data │\n│ Sender: 0xdde1 │\n';
    expect(parseCliOutcome(dry)).toMatchObject({ status: 'success', error: null, digest: null });
    const failed = 'Dry run completed, execution status: failure\n│ Error: MoveAbort(MoveLocation { module: ModuleId { address: 5f71, name: Identifier("njangi_price_validator") }, function: 12 }, 106) in command 0 │\n';
    expect(parseCliOutcome(failed)).toMatchObject({ status: 'failure', error: expect.stringContaining('MoveAbort') });
    expect(parseCliOutcome({ digest: 'HXPdLZJB', effects: { status: { status: 'success' }, gasUsed: { computationCost: '1' } } })).toMatchObject({ status: 'success', digest: 'HXPdLZJB', gasUsed: { computationCost: '1' } });
    expect(parseCliOutcome({ effects: { status: { status: 'failure', error: 'InsufficientGas' } } })).toMatchObject({ status: 'failure', error: 'InsufficientGas' });
    expect(parseCliOutcome('Transaction Digest: 4nqvBkxk1qoaHu8Yq3gWwLkYYuuSsTqVfVY7WEFk2pDJ\n│ Status: Success │\n')).toMatchObject({ status: 'unknown', digest: '4nqvBkxk1qoaHu8Yq3gWwLkYYuuSsTqVfVY7WEFk2pDJ' });
    expect(parseCliOutcome('garbage')).toMatchObject({ status: 'unknown' });
  });
});

describe('guards', () => {
  it('mainnet must be spelled out, and signing there needs --yes', () => {
    expect(mainnetGuard({ network: 'testnet', networkFromArgs: false, yes: false, signing: true })).toBeNull();
    expect(mainnetGuard({ network: 'mainnet', networkFromArgs: false, yes: true, signing: true })).toMatch(/--network mainnet/);
    expect(mainnetGuard({ network: 'mainnet', networkFromArgs: true, yes: false, signing: true })).toMatch(/--yes/);
    expect(mainnetGuard({ network: 'mainnet', networkFromArgs: true, yes: false, signing: false })).toBeNull();
    expect(mainnetGuard({ network: 'mainnet', networkFromArgs: true, yes: true, signing: true })).toBeNull();
  });
  it("the CLI's active env must match the network", () => {
    expect(envGuard('mainnet', 'testnet\n')).toMatch(/switch --env mainnet/);
    expect(envGuard('testnet', 'testnet')).toBeNull();
  });
  it('the runbook order ends with a status read', () => {
    expect(MAINNET_ORDER[0]).toBe('status');
    expect(MAINNET_ORDER[MAINNET_ORDER.length - 1]).toBe('status');
    expect(MAINNET_ORDER.indexOf('bless')).toBeLessThan(MAINNET_ORDER.indexOf('register-usdc'));
    expect(MAINNET_ORDER.indexOf('register-usdc')).toBeLessThan(MAINNET_ORDER.indexOf('transfer-admin --to <multisig>'));
  });
});
