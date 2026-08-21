import { normalizeSuiAddress } from '@mysten/sui/utils';
import { isResolvedSuiObjectId } from '@/lib/sui-object-id';

/**
 * Reading the mid-cycle migration ledger.
 *
 * A njangi that ran offline for months arrives part-way through its rotation:
 * some members have already collected, and the next turn belongs to somebody
 * in the middle of the order. The admin records that on chain as a
 * `MigrationLedger`, and `activate_circle` applies it — but only once every
 * member in the rotation has confirmed it, because declaring that a member
 * already collected removes them from this round's payout queue.
 *
 * This module is read-only. It parses the ledger out of the circle's config
 * and works out who still has to confirm. The gate itself lives in the
 * contract; nothing here can loosen it.
 */

export interface MigrationAck {
  member: string;
  version: number;
  ackedAt: number;
}

export interface MigrationLedger {
  declaredBy: string;
  declaredAt: number;
  /**
   * Bumped on every re-declaration. Acks are bound to the version they were
   * cast against, so rewriting the ledger sends everyone back to confirm.
   */
  version: number;
  /** Rounds the group completed before it migrated. Seeds `current_cycle`. */
  priorRoundsCompleted: number;
  /** Index into the rotation order where on-chain play resumes. */
  startPosition: number;
  /**
   * The rotation order as it stood when this was declared. A position number
   * means nothing on its own — reordering afterwards hands that position to
   * somebody else — so activation requires the live order to still match.
   */
  rotationSnapshot: string[];
  acks: MigrationAck[];
}

export interface MigrationRatification {
  ledger: MigrationLedger;
  /** Members whose turn came round before the circle joined the platform. */
  alreadyCollected: string[];
  /** Members still owed a turn in the migrated round, in order. */
  stillWaiting: string[];
  /** The member whose turn is next once the circle activates. */
  nextRecipient: string | null;
  confirmed: string[];
  pending: string[];
  isRatified: boolean;
  /**
   * False once the payout order changes after the history was declared. The
   * confirmations are then stale even though everyone has given one, and
   * activation aborts (EMigrationRotationChanged) until it is declared again.
   */
  matchesRotation: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function parseIntegerLike(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) {
      return Math.trunc(parsed);
    }
  }
  return null;
}

export function normalizeMemberAddress(value: unknown): string | null {
  // normalizeSuiAddress does NOT validate — 'not-an-address' comes back as
  // '0x00...0not-an-address', which compares equal to nothing and quietly
  // pollutes the roster. Screen the shape first. This also drops the @0x0
  // placeholder that an empty rotation slot carries.
  if (!isResolvedSuiObjectId(value)) return null;
  return normalizeSuiAddress(value.trim());
}

/**
 * Move structs reach us through several RPC shapes depending on nesting and
 * node version: a struct may arrive as `{ fields: {...} }` or flattened, and
 * an `Option` as `{ fields: { vec: [...] } }`, `{ vec: [...] }`, the bare
 * value, or null. Unwrap all of them rather than betting on one.
 */
function unwrapStruct(value: unknown): Record<string, unknown> | null {
  const record = asRecord(value);
  if (!record) return null;
  const nested = asRecord(record.fields);
  return nested ?? record;
}

function unwrapOption(value: unknown): unknown {
  if (value === null || value === undefined) return null;

  const record = asRecord(value);
  if (!record) return value;

  const inner = asRecord(record.fields) ?? record;
  if (Array.isArray(inner.vec)) {
    return inner.vec.length > 0 ? inner.vec[0] : null;
  }

  return value;
}

function toArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const inner = asRecord(asRecord(value)?.fields) ?? asRecord(value);
  return inner && Array.isArray(inner.vec) ? inner.vec : [];
}

function parseAcks(value: unknown): MigrationAck[] {
  const raw = toArray(value);
  const acks: MigrationAck[] = [];
  for (const entry of raw) {
    const fields = unwrapStruct(entry);
    if (!fields) continue;

    const member = normalizeMemberAddress(fields.member);
    const version = parseIntegerLike(fields.version);
    if (!member || version === null) continue;

    acks.push({
      member,
      version,
      ackedAt: parseIntegerLike(fields.acked_at) ?? 0,
    });
  }
  return acks;
}

function parseLedgerFields(fields: Record<string, unknown>): MigrationLedger | null {
  const version = parseIntegerLike(fields.version);
  const startPosition = parseIntegerLike(fields.start_position);
  // A ledger with no version is not a ledger — most likely a wrapper we failed
  // to unwrap. Treat it as absent rather than inventing a start of 0, which
  // would look like "no history" on a circle that has some.
  if (version === null || version < 1 || startPosition === null) return null;

  return {
    declaredBy: normalizeMemberAddress(fields.declared_by) ?? '',
    declaredAt: parseIntegerLike(fields.declared_at) ?? 0,
    version,
    priorRoundsCompleted: parseIntegerLike(fields.prior_rounds_completed) ?? 0,
    startPosition,
    rotationSnapshot: toArray(fields.rotation_snapshot)
      .map(normalizeMemberAddress)
      .filter((address): address is string => address !== null),
    acks: parseAcks(fields.acks),
  };
}

/**
 * Reads the ledger out of its dynamic-field object.
 *
 * It lives under `b"migration_ledger"` on the circle's own UID rather than
 * inside `CircleConfig`, because adding a field to that struct would change
 * the layout every existing circle already has serialized — which fails the
 * package upgrade check and misreads those circles. Same reason
 * `requires_attestation` is a dynamic field.
 */
export function extractMigrationLedgerFromObjectContent(
  content: unknown,
): MigrationLedger | null {
  const root = asRecord(asRecord(content)?.fields);
  if (!root) return null;

  // `Field<K, V>` nests the value; some nodes flatten it.
  const fields = unwrapStruct(root.value) ?? root;
  return parseLedgerFields(fields);
}

export interface MigrationLedgerDynamicFieldLike {
  objectId?: string | null;
  objectType?: string | null;
  type?: string | null;
  name?: unknown;
}

/**
 * The struct name in the field's type is the reliable discriminator: a
 * `vector<u8>` dynamic-field name comes back as a byte array on most nodes,
 * not the readable string, so matching on the name alone silently finds
 * nothing.
 */
export function isMigrationLedgerDynamicField(
  field: MigrationLedgerDynamicFieldLike | null | undefined,
): boolean {
  if (!field) return false;

  const objectType = typeof field.objectType === 'string' ? field.objectType : '';
  const fieldType = typeof field.type === 'string' ? field.type : '';
  const nameRecord = asRecord(field.name);
  const nameType = typeof nameRecord?.type === 'string' ? nameRecord.type : '';
  const nameValue = nameRecord?.value;

  if (objectType.includes('MigrationLedger') || fieldType.includes('MigrationLedger')) {
    return true;
  }
  if (nameType.includes('MigrationLedger')) return true;
  if (typeof nameValue === 'string' && nameValue === 'migration_ledger') return true;

  // Byte-array spelling of the same key.
  if (Array.isArray(nameValue)) {
    const decoded = nameValue
      .map((byte) => (typeof byte === 'number' ? String.fromCharCode(byte) : ''))
      .join('');
    return decoded === 'migration_ledger';
  }

  return false;
}

export function getMigrationLedgerObjectId(
  dynamicFields: Iterable<MigrationLedgerDynamicFieldLike | null | undefined>,
): string | null {
  for (const field of dynamicFields) {
    if (
      isMigrationLedgerDynamicField(field)
      && typeof field?.objectId === 'string'
      && field.objectId.length > 0
    ) {
      return field.objectId;
    }
  }
  return null;
}

type MigrationLedgerObjectClient = {
  getObject: (args: {
    id: string;
    options?: { showContent?: boolean };
  }) => Promise<{ data?: { content?: unknown } | null }>;
};

/**
 * Returns null for an ordinary circle that never migrated — the common case,
 * and the one where no extra RPC round-trip is spent, because the field is
 * simply absent from the list.
 */
export async function getMigrationLedgerFromDynamicFields(
  client: MigrationLedgerObjectClient,
  dynamicFields: Iterable<MigrationLedgerDynamicFieldLike | null | undefined>,
): Promise<MigrationLedger | null> {
  const objectId = getMigrationLedgerObjectId(dynamicFields);
  if (!objectId) return null;

  const object = await client.getObject({ id: objectId, options: { showContent: true } });
  return extractMigrationLedgerFromObjectContent(object.data?.content);
}

/**
 * Compares two member addresses by identity, not by spelling.
 *
 * Everything this module returns is zero-padded to 32 bytes, but addresses
 * arriving from a chain read, a wallet, or a URL may not be. A plain
 * `a.toLowerCase() === b.toLowerCase()` therefore reports `0xa` and
 * `0x00..0a` as different people — which in a confirmation checklist means a
 * member who HAS confirmed still shows as waiting, and the circle looks stuck.
 */
export function isSameMember(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const left = normalizeMemberAddress(a);
  const right = normalizeMemberAddress(b);
  return left !== null && left === right;
}

/** True only for a confirmation cast against the ledger's CURRENT version. */
export function hasMemberAcknowledged(
  ledger: MigrationLedger | null | undefined,
  member: string | null | undefined,
): boolean {
  if (!ledger) return false;
  const normalized = normalizeMemberAddress(member);
  if (!normalized) return false;

  return ledger.acks.some(
    (ack) => ack.member === normalized && ack.version === ledger.version,
  );
}

/**
 * Works out who has confirmed and who has not, mirroring the contract's
 * `is_migration_ratified`: every seat in the rotation, at the current version.
 *
 * An empty rotation is never ratified. The contract says the same, and it
 * matters — a ratified-by-default empty circle would let activation apply a
 * ledger nobody agreed to.
 */
export function resolveMigrationRatification(
  ledger: MigrationLedger | null | undefined,
  rotationOrder: readonly (string | null | undefined)[],
): MigrationRatification | null {
  if (!ledger) return null;

  const seats = rotationOrder
    .map(normalizeMemberAddress)
    .filter((address): address is string => address !== null);

  const confirmed: string[] = [];
  const pending: string[] = [];
  for (const seat of seats) {
    if (hasMemberAcknowledged(ledger, seat)) {
      confirmed.push(seat);
    } else {
      pending.push(seat);
    }
  }

  const boundary = Math.min(Math.max(ledger.startPosition, 0), seats.length);

  const matchesRotation =
    ledger.rotationSnapshot.length === seats.length
    && ledger.rotationSnapshot.every((address, index) => address === seats[index]);

  return {
    ledger,
    alreadyCollected: seats.slice(0, boundary),
    stillWaiting: seats.slice(boundary),
    nextRecipient: seats[boundary] ?? null,
    confirmed,
    pending,
    isRatified: seats.length > 0 && pending.length === 0,
    matchesRotation,
  };
}
