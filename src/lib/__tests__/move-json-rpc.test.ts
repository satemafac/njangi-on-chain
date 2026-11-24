// move-json-rpc.ts: 2.x JSON (gRPC / GraphQL) and BCS rendered exactly as
// JSON-RPC rendered them, from each type's Move layout. The layouts and JSON
// below are what Sui testnet returned on 2026-11-24 for the activation-test
// circle 0x7beabc6c… (trimmed to the fields that exercise each rule). Pure
// functions: nothing here reaches the network.

import {
  bcsToRpcFlatValue,
  knownLayout,
  moveJsonToRpcContentFields,
  moveJsonToRpcParsedJson,
  MoveShapeError,
  ownerToRpc,
  rpcValueToBcs,
  toLongTypeString,
  toRpcTypeString,
  typeArguments,
  type MoveLayout,
} from '@/lib/move-json-rpc';

const PKG = '0x89cddf4dfe654e7c7b16333096d9e750cf04bb96f7de934403a512d460594f02';
const SYS1 = `0x${'0'.repeat(63)}1`;
const SYS2 = `0x${'0'.repeat(63)}2`;

const UID: MoveLayout = {
  struct: {
    type: `${SYS2}::object::UID`,
    fields: [{ name: 'id', layout: { struct: { type: `${SYS2}::object::ID`, fields: [{ name: 'bytes', layout: 'address' }] } } }],
  },
};
const STRING: MoveLayout = { struct: { type: `${SYS1}::string::String`, fields: [{ name: 'bytes', layout: { vector: 'u8' } }] } };
const optionOf = (inner: MoveLayout, innerType: string): MoveLayout => ({
  struct: { type: `${SYS1}::option::Option<${innerType}>`, fields: [{ name: 'vec', layout: { vector: inner } }] },
});

const CIRCLE_LAYOUT: MoveLayout = {
  struct: {
    type: `${PKG}::njangi_circles::Circle`,
    fields: [
      { name: 'id', layout: UID },
      { name: 'name', layout: STRING },
      { name: 'admin', layout: 'address' },
      { name: 'current_members', layout: 'u64' },
      {
        name: 'members',
        layout: {
          struct: {
            type: `${SYS2}::table::Table<address,${PKG}::njangi_members::Member>`,
            fields: [
              { name: 'id', layout: UID },
              { name: 'size', layout: 'u64' },
            ],
          },
        },
      },
      {
        name: 'contributions',
        layout: { struct: { type: `${SYS2}::balance::Balance<${SYS2}::sui::SUI>`, fields: [{ name: 'value', layout: 'u64' }] } },
      },
      { name: 'rotation_order', layout: { vector: 'address' } },
      { name: 'active_auction', layout: optionOf('u64', 'u64') },
      { name: 'is_active', layout: 'bool' },
    ],
  },
};

const CIRCLE = '0x7beabc6c151fef9d1e2ce503295d05686457d433ad0993da07fe78890130ff6c';
const TABLE = '0x62f535462bd9728f986627f8042ce98b77a1af358c341c73a930bbf7bdbfe6df';
const ADMIN = '0xe833deaa9c038ac2edd397323ed5dbde1e622aadfd0d526332a214a31f9de17d';

const CIRCLE_JSON = {
  id: CIRCLE,
  name: 'Activation Test 1006',
  admin: ADMIN,
  current_members: '3',
  members: { id: TABLE, size: '3' },
  contributions: '0',
  rotation_order: [ADMIN],
  active_auction: null,
  is_active: true,
};

describe('object content in JSON-RPC shape', () => {
  it('wraps nested structs as { type, fields }, a UID as { id }, and keeps Balance, Option, String and u64 as JSON-RPC did', () => {
    expect(moveJsonToRpcContentFields(CIRCLE_JSON, CIRCLE_LAYOUT)).toEqual({
      id: { id: CIRCLE },
      name: 'Activation Test 1006',
      admin: ADMIN,
      current_members: '3',
      members: {
        type: `0x2::table::Table<address, ${PKG}::njangi_members::Member>`,
        fields: { id: { id: TABLE }, size: '3' },
      },
      contributions: '0',
      rotation_order: [ADMIN],
      active_auction: null,
      is_active: true,
    });
  });

  it('reads the members table id where JSON-RPC callers look for it', () => {
    const fields = moveJsonToRpcContentFields(CIRCLE_JSON, CIRCLE_LAYOUT) as { members: { fields: { id: { id: string } } } };
    expect(fields.members.fields.id.id).toBe(TABLE);
  });

  it('turns a base64 vector<u8> into its bytes, not a string', () => {
    const layout: MoveLayout = {
      struct: { type: `${PKG}::m::AssetTerms`, fields: [{ name: 'asset', layout: { vector: 'u8' } }] },
    };
    expect(moveJsonToRpcContentFields({ asset: 'c3Vp' }, layout)).toEqual({ asset: [115, 117, 105] });
  });

  it('renders Some(x) as x and accepts the { vec } form', () => {
    const layout: MoveLayout = {
      struct: { type: `${PKG}::m::S`, fields: [{ name: 'p', layout: optionOf('u64', 'u64') }] },
    };
    expect(moveJsonToRpcContentFields({ p: '0' }, layout)).toEqual({ p: '0' });
    expect(moveJsonToRpcContentFields({ p: { vec: ['7'] } }, layout)).toEqual({ p: '7' });
    expect(moveJsonToRpcContentFields({ p: { vec: [] } }, layout)).toEqual({ p: null });
  });

  it.each([
    ['a missing field', { ...CIRCLE_JSON, admin: undefined }],
    ['an extra field (another type)', { ...CIRCLE_JSON, surprise: 1 }],
    ['a struct where a string belongs', { ...CIRCLE_JSON, name: { bytes: 'x' } }],
    ['a u64 that is not a number', { ...CIRCLE_JSON, current_members: 'three' }],
    ['a bool that is a string', { ...CIRCLE_JSON, is_active: 'true' }],
    ['an address that is not hex', { ...CIRCLE_JSON, admin: 'alice' }],
  ])('throws for %s: an answer that does not match its layout is a failed read', (_label, json) => {
    const cleaned = JSON.parse(JSON.stringify(json));
    expect(() => moveJsonToRpcContentFields(cleaned, CIRCLE_LAYOUT)).toThrow(MoveShapeError);
  });

  it('throws for an enum layout rather than guess', () => {
    const layout = { struct: { type: `${PKG}::m::S`, fields: [{ name: 'e', layout: { enum: {} } }] } } as MoveLayout;
    expect(() => moveJsonToRpcContentFields({ e: {} }, layout)).toThrow(MoveShapeError);
  });
});

describe('event parsedJson in JSON-RPC shape', () => {
  it('keeps nested structs flat, as JSON-RPC parsedJson did', () => {
    const inner: MoveLayout = { struct: { type: `${PKG}::m::Inner`, fields: [{ name: 'x', layout: 'u8' }] } };
    const layout: MoveLayout = {
      struct: {
        type: `${PKG}::njangi_circles::MemberJoined`,
        fields: [
          { name: 'circle_id', layout: { struct: { type: `${SYS2}::object::ID`, fields: [{ name: 'bytes', layout: 'address' }] } } },
          { name: 'member', layout: 'address' },
          { name: 'member_status', layout: 'u8' },
          { name: 'inner', layout: inner },
        ],
      },
    };
    expect(
      moveJsonToRpcParsedJson({ circle_id: CIRCLE, member: ADMIN, member_status: 0, inner: { x: 1 } }, layout),
    ).toEqual({ circle_id: CIRCLE, member: ADMIN, member_status: 0, inner: { x: 1 } });
  });
});

describe('dynamic-field names', () => {
  it('decodes BCS names into JSON-RPC values: address, vector<u8> as bytes, String, and a struct key flat', () => {
    const address = rpcValueToBcs(ADMIN, 'address');
    expect(bcsToRpcFlatValue(address, 'address')).toBe(ADMIN);

    const name = rpcValueToBcs('circle_config', { vector: 'u8' });
    expect(bcsToRpcFlatValue(name, { vector: 'u8' })).toEqual(Array.from(Buffer.from('circle_config')));

    expect(bcsToRpcFlatValue(rpcValueToBcs('wallet_id', STRING), STRING)).toBe('wallet_id');

    const key: MoveLayout = {
      struct: {
        type: `${PKG}::njangi_circles::MemberDepositKey`,
        fields: [
          { name: 'member', layout: 'address' },
          { name: 'asset', layout: { vector: 'u8' } },
          { name: 'kind', layout: 'u8' },
        ],
      },
    };
    const value = { member: ADMIN, asset: [115, 117, 105], kind: 1 };
    expect(bcsToRpcFlatValue(rpcValueToBcs(value, key), key)).toEqual(value);
  });

  it('encodes a vector<u8> name given as text or as bytes the same way', () => {
    expect(Array.from(rpcValueToBcs('circle_config', { vector: 'u8' }))).toEqual(
      Array.from(rpcValueToBcs(Array.from(Buffer.from('circle_config')), { vector: 'u8' })),
    );
  });

  it('rejects trailing or missing bytes', () => {
    expect(() => bcsToRpcFlatValue(Uint8Array.from([1, 2]), 'u8')).toThrow(MoveShapeError);
    expect(() => bcsToRpcFlatValue(Uint8Array.from([1]), 'u64')).toThrow(MoveShapeError);
  });
});

describe('type strings and layouts', () => {
  it('prints types as JSON-RPC did: short system addresses, ", " between arguments', () => {
    expect(toRpcTypeString(`${SYS2}::coin::Coin<${SYS2}::sui::SUI>`)).toBe('0x2::coin::Coin<0x2::sui::SUI>');
    expect(toRpcTypeString(`${SYS2}::dynamic_field::Field<address,${PKG}::njangi_members::Member>`)).toBe(
      `0x2::dynamic_field::Field<address, ${PKG}::njangi_members::Member>`,
    );
  });

  it('compares types at full width', () => {
    expect(toLongTypeString('0x2::coin::Coin<0x2::sui::SUI>')).toBe(`${SYS2}::coin::Coin<${SYS2}::sui::SUI>`);
  });

  it('splits type arguments at the top level only', () => {
    expect(typeArguments(`0x2::dynamic_field::Field<address, 0x2::table::Table<u64, ${PKG}::m::S>>`)).toEqual([
      'address',
      `0x2::table::Table<u64, ${PKG}::m::S>`,
    ]);
  });

  it('knows primitive, vector, String and ID layouts without a lookup, and nothing else', () => {
    expect(knownLayout('address')).toBe('address');
    expect(knownLayout('vector<u8>')).toEqual({ vector: 'u8' });
    expect(knownLayout('0x1::string::String')).toMatchObject({ struct: { fields: [{ name: 'bytes' }] } });
    expect(knownLayout(`${PKG}::njangi_circles::Circle`)).toBeNull();
  });

  it('renders owners as JSON-RPC did', () => {
    expect(ownerToRpc({ $kind: 'Shared', Shared: { initialSharedVersion: '1' } })).toEqual({
      Shared: { initial_shared_version: 1 },
    });
    expect(ownerToRpc({ $kind: 'ObjectOwner', ObjectOwner: TABLE })).toEqual({ ObjectOwner: TABLE });
    expect(ownerToRpc({ $kind: 'Immutable', Immutable: true })).toBe('Immutable');
  });
});
