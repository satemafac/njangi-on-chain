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
import {
  definingType,
  isSuiObjectId,
  normalizeStructType,
  normalizeSuiId,
  planRegistry,
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
