/**
 * scripts/bootstrap-package.mjs used to skip `init_registry` whenever the
 * registry env var started with `0x`. That kept .env.example's
 * `0xyour_…_registry_id` placeholders, and after a fresh publish it kept the
 * previous lineage's registries, which abort `link_circle` with a
 * TypeMismatch. These tests pin the replacement rule, and the lineage trap
 * that comes with it: an upgraded package id must still keep the live
 * registry.
 *
 * The ids are real testnet objects (read 2026-10-01): the original package,
 * its v8 and v9 upgrades, the live WhatsApp registry, and an older lineage's
 * package and registry from TYPEMISMATCH_FIX.md.
 */
import { readFileSync } from 'fs';
import path from 'path';
import {
  definingType,
  isSuiObjectId,
  normalizeStructType,
  normalizeSuiId,
  planComplianceConfig,
  planRegistry,
  planUpgradeCap,
  publishedValue,
  type ObjectResponse,
  type TypeOrigin,
} from '../../../scripts/lib/registry-bootstrap';

const ORIGINAL = '0x89cddf4dfe654e7c7b16333096d9e750cf04bb96f7de934403a512d460594f02';
const V8 = '0x401ed4202913c9a91a98b029bddb91c78532b24e3c5cf8700fd0b2544e7ec10b';
const V9 = '0xf8afd3dfcf94f152ec9d1f8cb870b77525353a20564bb0224bcad5520d621614';
const LIVE_REGISTRY = '0xeda9982219bd3c0c2506f8ae753a28a228b5e62c04aaebc6c8a906477433be21';
const OLD_LINEAGE = '0xd0f586ee515a0289be671399c3a4550f96cd556592e10686b820cdba6a56ecdc';
const OLD_REGISTRY = '0x9e203f7dd2d56b058d82fb4f1fafe135133245fef347d8de4967e2c1c78b9459';

const WA_TYPE = `${ORIGINAL}::whatsapp_integration::WhatsAppLinksRegistry`;
const SHARED = { Shared: { initial_shared_version: 406633527 } };

/** A `sui_getObject` result for a package, read with `showBcs`. */
function packageResponse(typeOriginTable: TypeOrigin[]): ObjectResponse {
  return { data: { type: 'package', owner: 'Immutable', bcs: { dataType: 'package', typeOriginTable } } };
}

/** The v9 package as testnet returns it, trimmed to four rows. */
const v9Package = packageResponse([
  { module_name: 'whatsapp_integration', datatype_name: 'WhatsAppLinksRegistry', package: ORIGINAL },
  { module_name: 'njangi_price_validator', datatype_name: 'AssetRegistry', package: ORIGINAL },
  { module_name: 'njangi_compliance', datatype_name: 'AttestorCap', package: ORIGINAL },
  { module_name: 'njangi_circles', datatype_name: 'OpenRound', package: V8 },
]);

function reader(response: ObjectResponse) {
  return jest.fn(async () => response);
}

describe('isSuiObjectId', () => {
  it('accepts full, short and uppercase ids', () => {
    expect(isSuiObjectId(LIVE_REGISTRY)).toBe(true);
    expect(isSuiObjectId('0x6')).toBe(true);
    expect(isSuiObjectId(LIVE_REGISTRY.toUpperCase().replace('0X', '0x'))).toBe(true);
  });

  it('rejects the .env.example placeholders and other non-ids', () => {
    expect(isSuiObjectId('0xyour_testnet_whatsapp_registry_id')).toBe(false);
    expect(isSuiObjectId('0xyour_mainnet_asset_registry_id')).toBe(false);
    expect(isSuiObjectId('')).toBe(false);
    expect(isSuiObjectId('0x')).toBe(false);
    expect(isSuiObjectId(LIVE_REGISTRY.slice(2))).toBe(false);
    expect(isSuiObjectId(`${LIVE_REGISTRY}0`)).toBe(false);
    expect(isSuiObjectId(`"${LIVE_REGISTRY}"`)).toBe(false);
  });
});

describe('normalizeSuiId / normalizeStructType', () => {
  it('pads and lowercases', () => {
    expect(normalizeSuiId('0x6')).toBe(`0x${'0'.repeat(63)}6`);
    expect(normalizeSuiId(ORIGINAL.toUpperCase().replace('0X', '0x'))).toBe(ORIGINAL);
  });

  it('normalizes only the address of a non-generic struct type', () => {
    expect(normalizeStructType('0x2::clock::Clock')).toBe(`0x${'0'.repeat(63)}2::clock::Clock`);
    expect(normalizeStructType(WA_TYPE)).toBe(WA_TYPE);
    expect(normalizeStructType('0x2::coin::Coin<0x2::sui::SUI>')).toBeNull();
    expect(normalizeStructType('not a type')).toBeNull();
  });
});

describe('definingType', () => {
  it('gives an upgraded package the ORIGINAL id for types it did not declare', () => {
    // `${V9}::whatsapp_integration::WhatsAppLinksRegistry` names no type at all.
    expect(definingType(v9Package, 'whatsapp_integration', 'WhatsAppLinksRegistry')).toBe(WA_TYPE);
    expect(definingType(v9Package, 'njangi_price_validator', 'AssetRegistry')).toBe(
      `${ORIGINAL}::njangi_price_validator::AssetRegistry`,
    );
    expect(definingType(v9Package, 'njangi_compliance', 'AttestorCap')).toBe(
      `${ORIGINAL}::njangi_compliance::AttestorCap`,
    );
  });

  it('gives a type added by an upgrade that upgrade id, not the original', () => {
    expect(definingType(v9Package, 'njangi_circles', 'OpenRound')).toBe(`${V8}::njangi_circles::OpenRound`);
  });

  it('reads the struct_name rows of older nodes', () => {
    const pkg = packageResponse([
      { module_name: 'whatsapp_integration', struct_name: 'WhatsAppLinksRegistry', package: ORIGINAL },
    ]);
    expect(definingType(pkg, 'whatsapp_integration', 'WhatsAppLinksRegistry')).toBe(WA_TYPE);
  });

  it('refuses a package it cannot read, a non-package and an undeclared type', () => {
    expect(() =>
      definingType({ error: { code: 'notExists', object_id: V9 } }, 'whatsapp_integration', 'WhatsAppLinksRegistry'),
    ).toThrow(/cannot be read.*notExists/);
    expect(() =>
      definingType({ data: { type: WA_TYPE, owner: SHARED } }, 'whatsapp_integration', 'WhatsAppLinksRegistry'),
    ).toThrow(/not a package/);
    expect(() => definingType(v9Package, 'whatsapp_integration', 'Missing')).toThrow(
      /does not declare whatsapp_integration::Missing/,
    );
  });
});

describe('planRegistry', () => {
  it('creates a registry when the variable is unset, without reading anything', async () => {
    for (const configured of [undefined, '', '   ']) {
      const read = reader({});
      await expect(planRegistry(configured, WA_TYPE, read)).resolves.toEqual({
        action: 'create',
        reason: 'it is not set',
      });
      expect(read).not.toHaveBeenCalled();
    }
  });

  it('treats an .env.example placeholder as unset', async () => {
    const read = reader({});
    const plan = await planRegistry('0xyour_testnet_whatsapp_registry_id', WA_TYPE, read);

    expect(plan).toEqual({
      action: 'create',
      reason: '0xyour_testnet_whatsapp_registry_id is a placeholder, not an object id',
    });
    expect(read).not.toHaveBeenCalled();
  });

  it('keeps the live registry when bootstrapping with the upgraded v9 id', async () => {
    const expected = definingType(v9Package, 'whatsapp_integration', 'WhatsAppLinksRegistry');
    const read = reader({ data: { type: WA_TYPE, owner: SHARED } });

    await expect(planRegistry(LIVE_REGISTRY, expected, read)).resolves.toEqual({ action: 'keep' });
    expect(read).toHaveBeenCalledWith(LIVE_REGISTRY);
  });

  it('compares types after normalizing their addresses', async () => {
    const shortType = '0x2::clock::Clock';
    const read = reader({ data: { type: shortType, owner: SHARED } });

    await expect(planRegistry('0x6', `0x${'0'.repeat(63)}2::clock::Clock`, read)).resolves.toEqual({
      action: 'keep',
    });
  });

  it("replaces a previous lineage's registry after a fresh publish", async () => {
    // 0x89cddf4d… was itself a fresh publish over an env file that held the
    // 0xd0f586ee… lineage's registry. A fresh package declares its own
    // types, so the old registry no longer matches: the link_circle
    // TypeMismatch that keeping it caused.
    const freshPackage = packageResponse([
      { module_name: 'whatsapp_integration', datatype_name: 'WhatsAppLinksRegistry', package: ORIGINAL },
    ]);
    const expected = definingType(freshPackage, 'whatsapp_integration', 'WhatsAppLinksRegistry');
    const oldType = `${OLD_LINEAGE}::whatsapp_integration::WhatsAppLinksRegistry`;

    const plan = await planRegistry(OLD_REGISTRY, expected, reader({ data: { type: oldType, owner: SHARED } }));

    expect(plan).toEqual({ action: 'create', reason: `${OLD_REGISTRY} is a ${oldType}, not a ${WA_TYPE}` });
  });

  it('replaces an id that points at another kind of object', async () => {
    // The WhatsApp registry pasted into the asset registry's variable.
    const plan = await planRegistry(
      LIVE_REGISTRY,
      `${ORIGINAL}::njangi_price_validator::AssetRegistry`,
      reader({ data: { type: WA_TYPE, owner: SHARED } }),
    );

    expect(plan.action).toBe('create');
  });

  it('replaces an id that does not exist on this network, or was deleted', async () => {
    await expect(
      planRegistry(LIVE_REGISTRY, WA_TYPE, reader({ error: { code: 'notExists', object_id: LIVE_REGISTRY } })),
    ).resolves.toEqual({ action: 'create', reason: `${LIVE_REGISTRY} does not exist on this network` });
    await expect(
      planRegistry(LIVE_REGISTRY, WA_TYPE, reader({ error: { code: 'deleted', object_id: LIVE_REGISTRY } })),
    ).resolves.toEqual({ action: 'create', reason: `${LIVE_REGISTRY} was deleted` });
  });

  it('replaces an object of the right type that is not shared', async () => {
    for (const owner of [{ AddressOwner: ORIGINAL }, 'Immutable']) {
      const plan = await planRegistry(LIVE_REGISTRY, WA_TYPE, reader({ data: { type: WA_TYPE, owner } }));
      expect(plan.action).toBe('create');
    }
  });

  it('stops, rather than guessing, when the read fails', async () => {
    const failing = jest.fn(async () => {
      throw new Error('rpc sui_getObject http 429');
    });
    await expect(planRegistry(LIVE_REGISTRY, WA_TYPE, failing)).resolves.toEqual({
      action: 'stop',
      reason: `reading ${LIVE_REGISTRY} failed: rpc sui_getObject http 429`,
    });

    const unknown = await planRegistry(LIVE_REGISTRY, WA_TYPE, reader({ error: { code: 'unknown' } }));
    expect(unknown.action).toBe('stop');

    const bare = await planRegistry(LIVE_REGISTRY, WA_TYPE, reader({ data: { owner: SHARED } }));
    expect(bare).toEqual({ action: 'stop', reason: `the RPC returned ${LIVE_REGISTRY} without its type and owner` });
  });
});

/**
 * The ComplianceConfig cannot follow the registries' "anything unusable gets
 * a fresh one" rule: `njangi_compliance::init` already shares a config on
 * every fresh publish (move/build_and_test.sh's path), and a second config
 * splits revocations from the one gated escrows pinned. These tests pin
 * "record the lineage's config if it has one, create one only if it has
 * none".
 *
 * The package, transaction and UpgradeCap ids are real testnet values (read
 * 2026-10-03); the config ids and the hypothetical lineages are made up.
 */
describe('planComplianceConfig', () => {
  const PUBLISH_TX = '4QJj9JMDMBs5mUtvQwMXpFEbh3AigXJ5ZxAeXTRb25jt'; // published 0x89cddf4d…
  const FRESH = `0x${'a1'.repeat(32)}`; // a package published just now
  const UPGRADED = `0x${'b2'.repeat(32)}`; // an upgrade that added njangi_compliance
  const FRESH_CONFIG = `0x${'c3'.repeat(32)}`;
  const EARLIER_CONFIG = `0x${'d4'.repeat(32)}`;
  const UPGRADE_CAP = '0xc590f7b3ad86a637d2a85100703417b1a918dd02d64ebdc2c8413d0d179a7cb4';
  const DEPLOYER = '0xdde1086c98c6023db8e3d8267992e4c9aeba3d0271f6bac85dc2f6daa8301c77';
  const typesOf = (pkg: string) => ({
    config: `${pkg}::njangi_compliance::ComplianceConfig`,
    createdEvent: `${pkg}::njangi_compliance::ComplianceConfigCreated`,
  });
  const ref = (objectId: string, owner: unknown) => ({ owner, reference: { objectId, version: '1', digest: 'x' } });

  interface FakeChain {
    objects?: Record<string, ObjectResponse>;
    transactions?: Record<string, unknown>;
    events?: Record<string, unknown[]>;
    /** `method` or `method:firstParam` → the error the RPC answers with. */
    fail?: Record<string, string>;
  }

  /** Answers like rpcCall in the script: object errors inside the result, JSON-RPC errors thrown. */
  function fakeRpc(chain: FakeChain) {
    const missing = (id: string): ObjectResponse => ({ error: { code: 'notExists', object_id: id } });
    return jest.fn(async (method: string, params: unknown[]): Promise<unknown> => {
      const first = params[0];
      const failure = chain.fail?.[`${method}:${typeof first === 'string' ? first : ''}`] ?? chain.fail?.[method];
      if (failure) throw new Error(failure);
      switch (method) {
        case 'sui_getObject':
          return chain.objects?.[normalizeSuiId(first as string)] ?? missing(first as string);
        case 'sui_multiGetObjects':
          return (first as string[]).map((id) => chain.objects?.[normalizeSuiId(id)] ?? missing(id));
        case 'sui_getTransactionBlock': {
          const tx = chain.transactions?.[first as string];
          if (tx) return tx;
          throw new Error(
            `rpc sui_getTransactionBlock error: {"code":-32602,"message":"Could not find the referenced transaction [TransactionDigest(${first})]."}`,
          );
        }
        case 'suix_queryEvents':
          return {
            data: chain.events?.[(first as { MoveEventType: string }).MoveEventType] ?? [],
            nextCursor: null,
            hasNextPage: false,
          };
        default:
          throw new Error(`unexpected ${method}`);
      }
    });
  }
  const methods = (rpc: ReturnType<typeof fakeRpc>) => rpc.mock.calls.map(([method]) => method);

  /** A package whose creating transaction is `digest`. */
  const packageObject = (digest: string): ObjectResponse => ({
    data: { type: 'package', owner: 'Immutable', previousTransaction: digest },
  });
  const config = (pkg: string): ObjectResponse => ({ data: { type: typesOf(pkg).config, owner: SHARED } });

  /** The publish of FRESH: package, UpgradeCap and AttestorCap to the deployer, config shared by init. */
  const freshPublish: FakeChain = {
    objects: { [FRESH]: packageObject('FreshPublishTx'), [FRESH_CONFIG]: config(FRESH) },
    transactions: {
      FreshPublishTx: {
        effects: {
          status: { status: 'success' },
          created: [
            ref(FRESH, 'Immutable'),
            ref(UPGRADE_CAP, { AddressOwner: DEPLOYER }),
            ref(`0x${'e5'.repeat(32)}`, { AddressOwner: DEPLOYER }),
            ref(FRESH_CONFIG, SHARED),
          ],
        },
      },
    },
  };

  /** UPGRADED came from `sui client upgrade`: no init, so no config was made with it. */
  const upgradeWithoutConfig: FakeChain = {
    objects: { [UPGRADED]: packageObject('UpgradeTx') },
    transactions: { UpgradeTx: { effects: { created: [ref(UPGRADED, 'Immutable')] } } },
  };

  it('keeps a live shared config of the lineage, reading nothing else', async () => {
    const rpc = fakeRpc({ objects: { [FRESH_CONFIG]: config(FRESH) } });

    await expect(planComplianceConfig(FRESH_CONFIG, typesOf(FRESH), rpc)).resolves.toEqual({ action: 'keep' });
    expect(methods(rpc)).toEqual(['sui_getObject']);
  });

  it('keeps the testnet config when bootstrapping with the upgraded v9 id', async () => {
    // v9 declares none of the compliance types: the table names 0x89cddf4d….
    const pkg = packageResponse([
      { module_name: 'njangi_compliance', datatype_name: 'ComplianceConfig', package: ORIGINAL },
      { module_name: 'njangi_compliance', datatype_name: 'ComplianceConfigCreated', package: ORIGINAL },
    ]);
    const types = {
      config: definingType(pkg, 'njangi_compliance', 'ComplianceConfig'),
      createdEvent: definingType(pkg, 'njangi_compliance', 'ComplianceConfigCreated'),
    };
    const rpc = fakeRpc({ objects: { [EARLIER_CONFIG]: config(ORIGINAL) } });

    await expect(planComplianceConfig(EARLIER_CONFIG, types, rpc)).resolves.toEqual({ action: 'keep' });
  });

  it('stops without reading further when the configured id cannot be read', async () => {
    const rpc = fakeRpc({ fail: { sui_getObject: 'rpc sui_getObject http 429' } });

    await expect(planComplianceConfig(FRESH_CONFIG, typesOf(FRESH), rpc)).resolves.toEqual({
      action: 'stop',
      reason: `reading ${FRESH_CONFIG} failed: rpc sui_getObject http 429`,
    });
    expect(methods(rpc)).toEqual(['sui_getObject']);
  });

  it.each([
    ['unset', undefined],
    ['an .env.example placeholder', '0xyour_testnet_compliance_config_id'],
    ["the previous lineage's config", EARLIER_CONFIG],
  ])('records the config init shared on a fresh publish when the variable is %s', async (_label, configured) => {
    const rpc = fakeRpc({ ...freshPublish, objects: { ...freshPublish.objects, [EARLIER_CONFIG]: config(ORIGINAL) } });

    const plan = await planComplianceConfig(configured, typesOf(FRESH), rpc);

    expect(plan).toEqual({
      action: 'record',
      id: FRESH_CONFIG,
      reason: expect.stringContaining(`was created when ${FRESH} was published`),
    });
    // Never a second config, and no event query needed.
    expect(methods(rpc)).not.toContain('suix_queryEvents');
  });

  it.each([
    ['unset', undefined, 'it is not set'],
    ['a placeholder', '0xyour_mainnet_compliance_config_id', 'is a placeholder'],
    ['another type', LIVE_REGISTRY, `is a ${WA_TYPE}`],
    ['an id missing on this network', FRESH_CONFIG, 'does not exist on this network'],
  ])('creates a config on a lineage that has none when the variable is %s', async (_label, configured, why) => {
    const rpc = fakeRpc({
      ...upgradeWithoutConfig,
      objects: { ...upgradeWithoutConfig.objects, [LIVE_REGISTRY]: { data: { type: WA_TYPE, owner: SHARED } } },
    });

    const plan = await planComplianceConfig(configured, typesOf(UPGRADED), rpc);

    expect(plan).toEqual({ action: 'create', reason: expect.stringContaining(why) });
    expect(plan).toEqual({ action: 'create', reason: expect.stringContaining('this lineage has no ComplianceConfig yet') });
    expect(rpc).toHaveBeenCalledWith('suix_queryEvents', [
      { MoveEventType: typesOf(UPGRADED).createdEvent },
      null,
      1,
      false,
    ]);
  });

  it('creates a config when the configured object is not shared', async () => {
    const owned = { data: { type: typesOf(UPGRADED).config, owner: { AddressOwner: DEPLOYER } } };
    const rpc = fakeRpc({ ...upgradeWithoutConfig, objects: { ...upgradeWithoutConfig.objects, [FRESH_CONFIG]: owned } });

    await expect(planComplianceConfig(FRESH_CONFIG, typesOf(UPGRADED), rpc)).resolves.toMatchObject({
      action: 'create',
    });
  });

  it('records the config an earlier create_config made, from the first ComplianceConfigCreated event', async () => {
    const rpc = fakeRpc({
      ...upgradeWithoutConfig,
      objects: { ...upgradeWithoutConfig.objects, [EARLIER_CONFIG]: config(UPGRADED) },
      events: { [typesOf(UPGRADED).createdEvent]: [{ parsedJson: { config_id: EARLIER_CONFIG, source: 1 } }] },
    });

    await expect(planComplianceConfig(undefined, typesOf(UPGRADED), rpc)).resolves.toEqual({
      action: 'record',
      id: EARLIER_CONFIG,
      reason: expect.stringContaining('first ComplianceConfigCreated event'),
    });
  });

  it("stops when the transaction that published the config's type is pruned (publicnode, testnet)", async () => {
    // Read-only on publicnode, 2026-10-03: the original publish is gone.
    const rpc = fakeRpc({ objects: { [ORIGINAL]: packageObject(PUBLISH_TX) } });

    const plan = await planComplianceConfig(undefined, typesOf(ORIGINAL), rpc);

    expect(plan).toEqual({ action: 'stop', reason: expect.stringContaining(`TransactionDigest(${PUBLISH_TX})`) });
    expect(methods(rpc)).not.toContain('suix_queryEvents');
  });

  it('stops when that transaction comes back without its created objects', async () => {
    const rpc = fakeRpc({
      objects: { [UPGRADED]: packageObject('StrippedTx') },
      transactions: { StrippedTx: { effects: { status: { status: 'success' }, created: [] } } },
    });

    await expect(planComplianceConfig(undefined, typesOf(UPGRADED), rpc)).resolves.toEqual({
      action: 'stop',
      reason: expect.stringContaining('without its created objects'),
    });
  });

  it('stops when the event query fails, as publicnode does over pruned history', async () => {
    const rpc = fakeRpc({
      ...upgradeWithoutConfig,
      fail: {
        suix_queryEvents: `rpc suix_queryEvents error: {"code":-32603,"message":"Could not find the referenced transaction events [TransactionDigest(${PUBLISH_TX})]."}`,
      },
    });

    await expect(planComplianceConfig(undefined, typesOf(UPGRADED), rpc)).resolves.toEqual({
      action: 'stop',
      reason: expect.stringContaining('-32603'),
    });
  });

  it('stops when reading the created objects fails', async () => {
    const rpc = fakeRpc({ ...freshPublish, fail: { sui_multiGetObjects: 'rpc sui_multiGetObjects http 503' } });

    await expect(planComplianceConfig(undefined, typesOf(FRESH), rpc)).resolves.toEqual({
      action: 'stop',
      reason: expect.stringContaining('http 503'),
    });
  });

  it('stops when the announced config does not verify, rather than creating another', async () => {
    const rpc = fakeRpc({
      ...upgradeWithoutConfig,
      events: { [typesOf(UPGRADED).createdEvent]: [{ parsedJson: { config_id: EARLIER_CONFIG } }] },
    });

    await expect(planComplianceConfig(undefined, typesOf(UPGRADED), rpc)).resolves.toEqual({
      action: 'stop',
      reason: expect.stringContaining(`${EARLIER_CONFIG} does not exist on this network`),
    });
  });

  it('refuses to pick between two configs made by one publish', async () => {
    const tx = freshPublish.transactions?.FreshPublishTx as { effects: { created: unknown[] } };
    const rpc = fakeRpc({
      objects: { ...freshPublish.objects, [EARLIER_CONFIG]: config(FRESH) },
      transactions: { FreshPublishTx: { effects: { created: [...tx.effects.created, ref(EARLIER_CONFIG, SHARED)] } } },
    });

    await expect(planComplianceConfig(undefined, typesOf(FRESH), rpc)).resolves.toMatchObject({ action: 'stop' });
  });

  it('stops when the event type was declared after the config type', async () => {
    const types = { config: typesOf(ORIGINAL).config, createdEvent: typesOf(V8).createdEvent };

    await expect(planComplianceConfig(undefined, types, fakeRpc({}))).resolves.toMatchObject({ action: 'stop' });
  });
});

describe('publishedValue', () => {
  const toml = [
    '[published.mainnet]',
    'chain-id = "35834a8a"',
    'published-at = "0x7bf5274804a6008ebfbd9bfe766defb7fd5aa5fe6777419c2b6531ec99120b55"',
    'version = 1',
    '',
    '[published.testnet]',
    'chain-id = "4c78adac"',
    'build-config = { flavor = "sui", edition = "2024" }',
    'upgrade-capability = "0xc590f7b3ad86a637d2a85100703417b1a918dd02d64ebdc2c8413d0d179a7cb4"',
  ].join('\n');

  it("reads a key from the network's table only", () => {
    expect(publishedValue(toml, 'testnet', 'upgrade-capability')).toBe(
      '0xc590f7b3ad86a637d2a85100703417b1a918dd02d64ebdc2c8413d0d179a7cb4',
    );
    expect(publishedValue(toml, 'mainnet', 'upgrade-capability')).toBeUndefined();
    expect(publishedValue(toml, 'mainnet', 'chain-id')).toBe('35834a8a');
    expect(publishedValue(toml, 'devnet', 'chain-id')).toBeUndefined();
    expect(publishedValue('', 'testnet', 'upgrade-capability')).toBeUndefined();
  });

  it('finds the testnet UpgradeCap in the real move/Published.toml', () => {
    const real = readFileSync(path.resolve(__dirname, '../../../move/Published.toml'), 'utf8');
    expect(isSuiObjectId(publishedValue(real, 'testnet', 'upgrade-capability') ?? '')).toBe(true);
  });
});

describe('planUpgradeCap', () => {
  const CAP = '0xc590f7b3ad86a637d2a85100703417b1a918dd02d64ebdc2c8413d0d179a7cb4';
  const DEPLOYER = '0xdde1086c98c6023db8e3d8267992e4c9aeba3d0271f6bac85dc2f6daa8301c77';
  const OTHER = `0x${'f6'.repeat(32)}`;
  const published = `[published.testnet]\nupgrade-capability = "${CAP}"\n`;
  const source = { publishedToml: published, network: 'testnet' };
  const expected = { owner: DEPLOYER, packageId: V9 };
  /** The testnet UpgradeCap as publicnode returned it on 2026-10-03. */
  const capObject = (overrides: { owner?: unknown; type?: string; package?: string } = {}): ObjectResponse => ({
    data: {
      type: overrides.type ?? '0x2::package::UpgradeCap',
      owner: overrides.owner ?? { AddressOwner: DEPLOYER },
      content: { fields: { id: { id: CAP }, package: overrides.package ?? V9, policy: 0, version: '9' } },
    },
  });

  it("uses Published.toml's UpgradeCap when the signer holds it and it governs the package", async () => {
    const read = reader(capObject());

    await expect(planUpgradeCap(source, expected, read)).resolves.toEqual({ action: 'use', id: CAP });
    expect(read).toHaveBeenCalledWith(CAP);
  });

  it('prefers NJANGI_BOOTSTRAP_UPGRADE_CAP_ID', async () => {
    const read = reader(capObject());

    await expect(planUpgradeCap({ ...source, override: ` ${OTHER} ` }, expected, read)).resolves.toEqual({
      action: 'use',
      id: OTHER,
    });
    expect(read).toHaveBeenCalledWith(OTHER);
  });

  it('stops, naming both sources, when no UpgradeCap id is known', async () => {
    const read = reader({});
    const plan = await planUpgradeCap({ publishedToml: published, network: 'mainnet' }, expected, read);

    expect(plan).toEqual({
      action: 'stop',
      reason: expect.stringMatching(/NJANGI_BOOTSTRAP_UPGRADE_CAP_ID.*\[published\.mainnet\]/),
    });
    expect(read).not.toHaveBeenCalled();
  });

  it('stops on an override that is not an object id', async () => {
    await expect(planUpgradeCap({ ...source, override: 'cap' }, expected, reader({}))).resolves.toEqual({
      action: 'stop',
      reason: 'NJANGI_BOOTSTRAP_UPGRADE_CAP_ID is "cap", not an object id',
    });
  });

  it('stops when the cap cannot be read or no longer exists', async () => {
    const failing = jest.fn(async () => {
      throw new Error('rpc sui_getObject http 429');
    });
    await expect(planUpgradeCap(source, expected, failing)).resolves.toMatchObject({ action: 'stop' });
    await expect(
      planUpgradeCap(source, expected, reader({ error: { code: 'deleted', object_id: CAP } })),
    ).resolves.toMatchObject({ action: 'stop' });
  });

  it('stops on an object that is not an UpgradeCap', async () => {
    await expect(planUpgradeCap(source, expected, reader(capObject({ type: WA_TYPE })))).resolves.toEqual({
      action: 'stop',
      reason: expect.stringContaining('not an UpgradeCap'),
    });
  });

  it('stops when the active address does not hold the cap, e.g. after it moved to a multisig', async () => {
    for (const owner of [{ AddressOwner: OTHER }, SHARED, 'Immutable']) {
      await expect(planUpgradeCap(source, expected, reader(capObject({ owner })))).resolves.toEqual({
        action: 'stop',
        reason: expect.stringContaining(`not by the active address ${DEPLOYER}`),
      });
    }
  });

  it('stops when the cap governs another package, such as an older version id', async () => {
    await expect(planUpgradeCap(source, { ...expected, packageId: V8 }, reader(capObject()))).resolves.toEqual({
      action: 'stop',
      reason: expect.stringContaining(`governs ${V9}, not ${V8}`),
    });
  });
});
