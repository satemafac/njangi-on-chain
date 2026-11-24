// move-json-rpc.ts — Move values from @mysten/sui 2.x (gRPC and GraphQL JSON,
// or BCS) in the exact shapes JSON-RPC gave the app's parsers, driven by the
// value's Move type layout.
//
// 2.x JSON differs from JSON-RPC in ways a blind conversion would misread
// silently (tx-transport.ts): a nested struct has no `{ type, fields }`
// wrapper, a UID is a bare string, and a `vector<u8>` is base64 text, which
// looks exactly like a String. The layout (Sui GraphQL `type(type:) { layout }`)
// says which is which, so this conversion is exact: it reproduces JSON-RPC's
// rendering rules (sui-json-rpc-types SuiMoveValue, sui-json move_value_to_json):
//
//   - u8/u16/u32 are numbers; u64/u128/u256 are decimal strings; addresses are
//     full 0x-hex strings; `vector<u8>` is a list of numbers.
//   - 0x1::string::String, 0x1::ascii::String and 0x2::url::Url are strings;
//     0x2::object::ID is its address; 0x2::balance::Balance<T> is its value;
//     0x1::option::Option<T> is null or the value; 0x2::object::UID is `{ id }`.
//   - Object content (`content.fields`) wraps every other nested struct as
//     `{ type, fields }` ("typed"). Event `parsedJson` and dynamic-field names
//     render nested structs as bare field maps ("flat").
//   - Struct types print as JSON-RPC prints them: leading zeros dropped from
//     each address (`0x2::coin::Coin<0x2::sui::SUI>`), type arguments joined
//     by ", ".
//
// A value that does not match its layout throws MoveShapeError: an answer we
// cannot read is a failed read, never a default.

/** A Move type layout, as Sui GraphQL's `MoveType.layout` returns it. */
export type MoveLayout =
  | 'address'
  | 'bool'
  | 'u8'
  | 'u16'
  | 'u32'
  | 'u64'
  | 'u128'
  | 'u256'
  | 'signer'
  | { vector: MoveLayout }
  | { struct: { type: string; fields: Array<{ name: string; layout: MoveLayout }> } }
  | { enum: unknown };

/** A value that does not match its Move layout: the read that produced it failed. */
export class MoveShapeError extends Error {
  constructor(message: string) {
    super(`[move-json-rpc] ${message}`);
    this.name = 'MoveShapeError';
  }
}

type Mode = 'typed' | 'flat';

const PRIMITIVES = new Set(['address', 'bool', 'u8', 'u16', 'u32', 'u64', 'u128', 'u256', 'signer']);
const SMALL_UINTS = new Set(['u8', 'u16', 'u32']);
const BIG_UINTS = new Set(['u64', 'u128', 'u256']);
const UINT_BYTES: Record<string, number> = { u8: 1, u16: 2, u32: 4, u64: 8, u128: 16, u256: 32 };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Type strings
// ---------------------------------------------------------------------------

/** `0x…` with leading zeros dropped (at least one digit kept), lower case. */
function shortAddress(hex: string): string {
  return `0x${hex.replace(/^0+/, '').toLowerCase() || '0'}`;
}

/** A Move type as JSON-RPC prints it: `0x2::table::Table<address, 0x5f…::m::S>`. */
export function toRpcTypeString(type: string): string {
  return type
    .trim()
    .replace(/0x([0-9a-fA-F]+)/g, (_match, hex: string) => shortAddress(hex))
    .replace(/\s*,\s*/g, ', ')
    .replace(/\s*<\s*/g, '<')
    .replace(/\s*>/g, '>');
}

/** A Move type with every address at full 32-byte width and no spaces, for comparing types. */
export function toLongTypeString(type: string): string {
  return type
    .trim()
    .replace(/0x([0-9a-fA-F]+)/g, (_match, hex: string) => `0x${hex.toLowerCase().padStart(64, '0')}`)
    .replace(/\s+/g, '');
}

/** The struct name without type arguments, long form: `0x00…02::balance::Balance`. */
function structBase(type: string): string {
  const long = toLongTypeString(type);
  const open = long.indexOf('<');
  return open < 0 ? long : long.slice(0, open);
}

const SYS1 = `0x${'0'.repeat(63)}1`;
const SYS2 = `0x${'0'.repeat(63)}2`;
const STRING_TYPES = new Set([`${SYS1}::string::String`, `${SYS1}::ascii::String`, `${SYS2}::url::Url`]);
const ID_TYPE = `${SYS2}::object::ID`;
const UID_TYPE = `${SYS2}::object::UID`;
const BALANCE_TYPE = `${SYS2}::balance::Balance`;
const OPTION_TYPE = `${SYS1}::option::Option`;

/** Splits `A, B<C, D>` at its top-level commas. */
function splitTypeArgs(args: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < args.length; i += 1) {
    const ch = args[i];
    if (ch === '<') depth += 1;
    else if (ch === '>') depth -= 1;
    else if (ch === ',' && depth === 0) {
      parts.push(args.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(args.slice(start).trim());
  return parts.filter((part) => part !== '');
}

/** The type arguments of a struct type: `Field<address, 0x…::m::S>` gives `['address', '0x…::m::S']`. */
export function typeArguments(type: string): string[] {
  const compact = type.trim();
  const open = compact.indexOf('<');
  if (open < 0 || !compact.endsWith('>')) return [];
  return splitTypeArgs(compact.slice(open + 1, -1));
}

/**
 * The layout of a type that needs no lookup: primitives, vectors of them, and
 * the strings and IDs whose layout is fixed. Null for any other struct (ask
 * Sui GraphQL for it).
 */
export function knownLayout(type: string): MoveLayout | null {
  const trimmed = type.trim();
  if (PRIMITIVES.has(trimmed)) return trimmed as MoveLayout;
  const vector = /^vector\s*<([\s\S]+)>$/.exec(trimmed);
  if (vector) {
    const inner = knownLayout(vector[1]);
    return inner ? { vector: inner } : null;
  }
  const base = structBase(trimmed);
  if (STRING_TYPES.has(base)) {
    return { struct: { type: toLongTypeString(trimmed), fields: [{ name: 'bytes', layout: { vector: 'u8' } }] } };
  }
  if (base === ID_TYPE) {
    return { struct: { type: ID_TYPE, fields: [{ name: 'bytes', layout: 'address' }] } };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Base64 and bytes
// ---------------------------------------------------------------------------

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** The bytes of padded base64 text; throws on anything else. */
export function base64ToBytes(text: string): number[] {
  if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) {
    throw new MoveShapeError(`expected base64 bytes, got ${JSON.stringify(text.slice(0, 40))}`);
  }
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i += 4) {
    const sextets = [0, 1, 2, 3].map((k) => BASE64.indexOf(text.charAt(i + k)));
    const bits = sextets.reduce((acc, sextet) => (acc << 6) | Math.max(sextet, 0), 0);
    bytes.push((bits >> 16) & 0xff);
    if (text.charAt(i + 2) !== '=') bytes.push((bits >> 8) & 0xff);
    if (text.charAt(i + 3) !== '=') bytes.push(bits & 0xff);
  }
  return bytes;
}

export function bytesToBase64(bytes: ArrayLike<number>): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const bits = (b0 << 16) | (b1 << 8) | b2;
    out += BASE64[(bits >> 18) & 63] + BASE64[(bits >> 12) & 63];
    out += i + 1 < bytes.length ? BASE64[(bits >> 6) & 63] : '=';
    out += i + 2 < bytes.length ? BASE64[bits & 63] : '=';
  }
  return out;
}

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
const utf8Encoder = new TextEncoder();

// ---------------------------------------------------------------------------
// 2.x JSON -> JSON-RPC
// ---------------------------------------------------------------------------

function fail(path: string, expected: string, value: unknown): never {
  const shown = JSON.stringify(value);
  throw new MoveShapeError(`${path || 'value'}: expected ${expected}, got ${shown === undefined ? 'nothing' : shown.slice(0, 80)}`);
}

function convertPrimitive(value: unknown, layout: string, path: string): unknown {
  if (layout === 'bool') {
    if (typeof value !== 'boolean') fail(path, 'a bool', value);
    return value;
  }
  if (layout === 'address' || layout === 'signer') {
    if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(value)) fail(path, 'an address', value);
    return `0x${value.slice(2).toLowerCase().padStart(64, '0')}`;
  }
  if (SMALL_UINTS.has(layout)) {
    const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) fail(path, layout, value);
    return n;
  }
  if (BIG_UINTS.has(layout)) {
    if (typeof value === 'string' && /^\d+$/.test(value)) return value;
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
    fail(path, layout, value);
  }
  throw new MoveShapeError(`${path || 'value'}: unknown primitive layout ${layout}`);
}

function convertByteVector(value: unknown, path: string): number[] {
  if (typeof value === 'string') return base64ToBytes(value);
  if (Array.isArray(value) && value.every((b) => typeof b === 'number' && Number.isInteger(b) && b >= 0 && b <= 255)) {
    return value as number[];
  }
  return fail(path, 'vector<u8> (base64 or bytes)', value);
}

function convert(value: unknown, layout: MoveLayout, mode: Mode, path: string): unknown {
  if (typeof layout === 'string') return convertPrimitive(value, layout, path);
  if ('vector' in layout) {
    if (layout.vector === 'u8') return convertByteVector(value, path);
    if (!Array.isArray(value)) fail(path, 'a vector', value);
    return value.map((item, index) => convert(item, layout.vector, mode, `${path}[${index}]`));
  }
  if ('struct' in layout) return convertStruct(value, layout.struct, mode, path);
  throw new MoveShapeError(`${path || 'value'}: enums are not supported`);
}

function convertStruct(
  value: unknown,
  struct: { type: string; fields: Array<{ name: string; layout: MoveLayout }> },
  mode: Mode,
  path: string,
): unknown {
  const base = structBase(struct.type);
  if (STRING_TYPES.has(base)) {
    if (typeof value !== 'string') fail(path, 'a string', value);
    return value;
  }
  if (base === ID_TYPE) return convertPrimitive(value, 'address', path);
  if (base === UID_TYPE) {
    const id = isRecord(value) ? value.id : value;
    return { id: convertPrimitive(isRecord(id) ? id.id : id, 'address', path) };
  }
  if (base === BALANCE_TYPE) {
    return convertPrimitive(isRecord(value) ? value.value : value, 'u64', path);
  }
  if (base === OPTION_TYPE) {
    const inner = struct.fields[0]?.layout;
    if (!inner || typeof inner === 'string' || !('vector' in inner)) {
      throw new MoveShapeError(`${path || 'value'}: Option without a vec layout`);
    }
    if (value === null || value === undefined) return null;
    // Some renderings keep the Move form `{ vec: [x] }` or `[x]`.
    const vec = isRecord(value) && Array.isArray(value.vec) ? value.vec : null;
    if (vec) return vec.length === 0 ? null : convert(vec[0], inner.vector, mode, path);
    return convert(value, inner.vector, mode, path);
  }
  const fields = convertFields(value, struct, mode, path);
  return mode === 'typed' ? { type: toRpcTypeString(struct.type), fields } : fields;
}

function convertFields(
  value: unknown,
  struct: { type: string; fields: Array<{ name: string; layout: MoveLayout }> },
  mode: Mode,
  path: string,
): Record<string, unknown> {
  if (!isRecord(value)) fail(path, `a ${toRpcTypeString(struct.type)} struct`, value);
  const expected = new Set(struct.fields.map((field) => field.name));
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) {
      throw new MoveShapeError(`${path || 'value'}: field ${key} is not in ${toRpcTypeString(struct.type)}`);
    }
  }
  const out: Record<string, unknown> = {};
  for (const field of struct.fields) {
    const fieldPath = path ? `${path}.${field.name}` : field.name;
    if (!(field.name in value)) throw new MoveShapeError(`${fieldPath}: missing`);
    out[field.name] = convert(value[field.name], field.layout, mode, fieldPath);
  }
  return out;
}

function topStruct(layout: MoveLayout) {
  if (typeof layout === 'string' || !('struct' in layout)) {
    throw new MoveShapeError('an object or event layout must be a struct');
  }
  return layout.struct;
}

/** An object's 2.x `json` as JSON-RPC's `content.fields` (nested structs typed). */
export function moveJsonToRpcContentFields(json: unknown, layout: MoveLayout): Record<string, unknown> {
  return convertFields(json, topStruct(layout), 'typed', '');
}

/** A 2.x event `json` as JSON-RPC's `parsedJson` (nested structs flat). */
export function moveJsonToRpcParsedJson(json: unknown, layout: MoveLayout): Record<string, unknown> {
  return convertFields(json, topStruct(layout), 'flat', '');
}

/** Any 2.x JSON value of `layout` in JSON-RPC's flat rendering (dynamic-field names). */
export function moveJsonToRpcFlatValue(json: unknown, layout: MoveLayout): unknown {
  return convert(json, layout, 'flat', '');
}

// ---------------------------------------------------------------------------
// BCS (dynamic-field names: decode from 2.x listings, encode to derive ids)
// ---------------------------------------------------------------------------

class Reader {
  offset = 0;
  constructor(private readonly bytes: Uint8Array) {}
  take(count: number): Uint8Array {
    if (this.offset + count > this.bytes.length) throw new MoveShapeError('BCS value ends early');
    const slice = this.bytes.subarray(this.offset, this.offset + count);
    this.offset += count;
    return slice;
  }
  uleb(): number {
    let result = 0;
    let shift = 0;
    for (;;) {
      const [byte] = this.take(1);
      result += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
      if (shift > 28) throw new MoveShapeError('BCS length too long');
    }
    return result;
  }
  done(): boolean {
    return this.offset === this.bytes.length;
  }
}

function leToBigInt(bytes: Uint8Array): bigint {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i -= 1) n = (n << 8n) | BigInt(bytes[i]);
  return n;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Decodes BCS into the 2.x JSON form, which `convert` then renders. */
function decodeToV2Json(reader: Reader, layout: MoveLayout): unknown {
  if (typeof layout === 'string') {
    if (layout === 'bool') {
      const [b] = reader.take(1);
      if (b > 1) throw new MoveShapeError('BCS bool out of range');
      return b === 1;
    }
    if (layout === 'address' || layout === 'signer') return `0x${hex(reader.take(32))}`;
    const size = UINT_BYTES[layout];
    if (!size) throw new MoveShapeError(`unknown primitive layout ${layout}`);
    const n = leToBigInt(reader.take(size));
    return SMALL_UINTS.has(layout) ? Number(n) : n.toString();
  }
  if ('vector' in layout) {
    const length = reader.uleb();
    if (layout.vector === 'u8') return bytesToBase64(reader.take(length));
    return Array.from({ length }, () => decodeToV2Json(reader, layout.vector));
  }
  if ('struct' in layout) {
    const base = structBase(layout.struct.type);
    if (STRING_TYPES.has(base)) {
      const length = reader.uleb();
      try {
        return utf8Decoder.decode(reader.take(length));
      } catch {
        throw new MoveShapeError('BCS string is not UTF-8');
      }
    }
    if (base === OPTION_TYPE) {
      const inner = layout.struct.fields[0]?.layout;
      if (!inner || typeof inner === 'string' || !('vector' in inner)) throw new MoveShapeError('Option without a vec layout');
      const length = reader.uleb();
      if (length > 1) throw new MoveShapeError('BCS Option longer than one');
      return length === 0 ? null : decodeToV2Json(reader, inner.vector);
    }
    const out: Record<string, unknown> = {};
    for (const field of layout.struct.fields) out[field.name] = decodeToV2Json(reader, field.layout);
    if (base === ID_TYPE || base === UID_TYPE) {
      const inner = out.bytes ?? out.id;
      return typeof inner === 'string' ? inner : (inner as Record<string, unknown>)?.bytes;
    }
    if (base === BALANCE_TYPE) return out.value;
    return out;
  }
  throw new MoveShapeError('enums are not supported');
}

/** BCS bytes of `layout` in JSON-RPC's flat rendering (a dynamic-field name's `value`). */
export function bcsToRpcFlatValue(bytes: Uint8Array, layout: MoveLayout): unknown {
  const reader = new Reader(bytes);
  const json = decodeToV2Json(reader, layout);
  if (!reader.done()) throw new MoveShapeError('BCS value has trailing bytes');
  return moveJsonToRpcFlatValue(json, layout);
}

function uleb(n: number): number[] {
  const out: number[] = [];
  let value = n;
  do {
    let byte = value & 0x7f;
    value = Math.floor(value / 128);
    if (value > 0) byte |= 0x80;
    out.push(byte);
  } while (value > 0);
  return out;
}

function uintBytes(value: unknown, size: number, path: string): number[] {
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !/^\d+$/.test(text)) fail(path, `u${size * 8}`, value);
  let n = BigInt(text);
  if (n >= 1n << BigInt(size * 8)) fail(path, `u${size * 8} in range`, value);
  const out: number[] = [];
  for (let i = 0; i < size; i += 1) {
    out.push(Number(n & 0xffn));
    n >>= 8n;
  }
  return out;
}

function addressBytes(value: unknown, path: string): number[] {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(value)) fail(path, 'an address', value);
  const padded = value.slice(2).padStart(64, '0');
  return Array.from({ length: 32 }, (_, i) => parseInt(padded.slice(i * 2, i * 2 + 2), 16));
}

function encode(value: unknown, layout: MoveLayout, path: string): number[] {
  if (typeof layout === 'string') {
    if (layout === 'bool') {
      if (typeof value !== 'boolean') fail(path, 'a bool', value);
      return [value ? 1 : 0];
    }
    if (layout === 'address' || layout === 'signer') return addressBytes(value, path);
    const size = UINT_BYTES[layout];
    if (!size) throw new MoveShapeError(`unknown primitive layout ${layout}`);
    return uintBytes(value, size, path);
  }
  if ('vector' in layout) {
    if (layout.vector === 'u8') {
      const bytes =
        typeof value === 'string' ? Array.from(utf8Encoder.encode(value)) : convertByteVector(value, path);
      return [...uleb(bytes.length), ...bytes];
    }
    if (!Array.isArray(value)) fail(path, 'a vector', value);
    return [...uleb(value.length), ...value.flatMap((item, i) => encode(item, layout.vector, `${path}[${i}]`))];
  }
  if ('struct' in layout) {
    const base = structBase(layout.struct.type);
    if (STRING_TYPES.has(base)) {
      if (typeof value !== 'string') fail(path, 'a string', value);
      const bytes = Array.from(utf8Encoder.encode(value));
      return [...uleb(bytes.length), ...bytes];
    }
    if (base === ID_TYPE || base === UID_TYPE) {
      const id = isRecord(value) ? value.id ?? value.bytes : value;
      return addressBytes(id, path);
    }
    if (base === OPTION_TYPE) {
      const inner = layout.struct.fields[0]?.layout;
      if (!inner || typeof inner === 'string' || !('vector' in inner)) throw new MoveShapeError('Option without a vec layout');
      return value === null || value === undefined ? [0] : [1, ...encode(value, inner.vector, path)];
    }
    const fields = isRecord(value) && isRecord(value.fields) ? value.fields : value;
    if (!isRecord(fields)) fail(path, `a ${toRpcTypeString(layout.struct.type)} struct`, value);
    return layout.struct.fields.flatMap((field) => {
      if (!(field.name in fields)) throw new MoveShapeError(`${path ? `${path}.` : ''}${field.name}: missing`);
      return encode(fields[field.name], field.layout, path ? `${path}.${field.name}` : field.name);
    });
  }
  throw new MoveShapeError('enums are not supported');
}

/** BCS bytes of a dynamic-field name given as JSON-RPC callers give it (`{ type, value }`'s value). */
export function rpcValueToBcs(value: unknown, layout: MoveLayout): Uint8Array {
  return Uint8Array.from(encode(value, layout, ''));
}

// ---------------------------------------------------------------------------
// Owners
// ---------------------------------------------------------------------------

/** A 2.x object owner as JSON-RPC's `ObjectOwner`. */
export function ownerToRpc(owner: unknown): unknown {
  if (!isRecord(owner)) return null;
  switch (owner.$kind) {
    case 'AddressOwner':
      return { AddressOwner: owner.AddressOwner };
    case 'ObjectOwner':
      return { ObjectOwner: owner.ObjectOwner };
    case 'Shared': {
      const shared = owner.Shared as { initialSharedVersion?: string | number } | undefined;
      return { Shared: { initial_shared_version: Number(shared?.initialSharedVersion) } };
    }
    case 'Immutable':
      return 'Immutable';
    case 'ConsensusAddressOwner': {
      const c = owner.ConsensusAddressOwner as { startVersion?: string | number; owner?: string } | undefined;
      return { ConsensusAddressOwner: { start_version: Number(c?.startVersion), owner: c?.owner } };
    }
    default:
      return null;
  }
}
