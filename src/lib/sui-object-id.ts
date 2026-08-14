import { normalizeSuiObjectId } from '@mysten/sui/utils';

/**
 * The all-zero object id. `normalizeSuiObjectId` left-pads whatever it is
 * given to 32 bytes and never throws, so an unresolved id — `''`, `'0x0'`, a
 * placeholder from a chain read that hasn't landed yet — silently becomes this
 * value instead of failing. It then travels all the way to the RPC, which
 * rejects the transaction with an opaque
 * `The following input objects are invalid: {"code":"0x000...000"}`.
 */
export const ZERO_SUI_OBJECT_ID = normalizeSuiObjectId('0x0');

// `normalizeSuiObjectId` does not validate its input either: 'garbage' becomes
// '0x0000...0garbage'. Screen the shape ourselves before normalizing.
const SUI_OBJECT_ID_PATTERN = /^(0x)?[0-9a-fA-F]{1,64}$/;

/**
 * True only for an object id that actually points somewhere: correctly shaped
 * hex, and not the all-zero placeholder that an unloaded id normalizes into.
 *
 * Use this — not a bare truthiness check — before enabling a control that
 * spends an id, or before building a transaction out of one.
 */
export function isResolvedSuiObjectId(value: unknown): value is string {
  if (typeof value !== 'string') return false;

  const trimmed = value.trim();
  if (!SUI_OBJECT_ID_PATTERN.test(trimmed)) return false;

  return normalizeSuiObjectId(trimmed) !== ZERO_SUI_OBJECT_ID;
}

/**
 * Normalize an object id that a transaction cannot be built without, failing
 * fast with a message naming the offending field rather than letting a zeroed
 * or malformed id reach the RPC.
 */
export function normalizeRequiredObjectId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} is required.`);
  }

  const trimmed = value.trim();

  if (SUI_OBJECT_ID_PATTERN.test(trimmed) && normalizeSuiObjectId(trimmed) === ZERO_SUI_OBJECT_ID) {
    throw new Error(`${label} has not loaded yet. Wait for the circle details to finish loading and retry.`);
  }

  if (!isResolvedSuiObjectId(trimmed)) {
    throw new Error(`${label} is invalid.`);
  }

  return normalizeSuiObjectId(trimmed);
}
