// API routes reply with two kinds of `error` strings: sentences written
// for people ("Circle activation failed: ...") and stable machine codes
// written for branching (UPGRADE_REQUIRED, OBJECT_ALREADY_DELETED, raw
// MoveAbort dumps). Toasting the second kind verbatim leaks internals at
// the exact moment a user is already confused. This module is the single
// place that decides what a user-facing error string should say: known
// codes get real copy, unrecognized machine-looking tokens collapse to a
// generic apology (the raw value still goes to the console at the call
// site), and human sentences pass through untouched.

export const GENERIC_USER_ERROR =
  'Something went wrong. Please try again — if it keeps happening, contact support.';

const KNOWN_CODE_MESSAGES: Record<string, string> = {
  UPGRADE_REQUIRED:
    'This feature is part of the Premium plan. Visit the Pricing page to upgrade.',
  OBJECT_ALREADY_DELETED:
    'This item is no longer available. Refresh the page to see the latest state.',
  EWalletHasBalance:
    'The circle wallet still holds funds. Withdraw them first, then try again.',
  EWalletHasStablecoin:
    'The circle wallet still holds stablecoins. Withdraw them first, then try again.',
};

/**
 * True for strings that read as machine identifiers rather than prose:
 * SCREAMING_SNAKE codes, Move-style ECamelCase abort names, and raw
 * MoveAbort/ModuleId dumps.
 */
export function looksLikeMachineCode(value: string): boolean {
  const v = value.trim();
  if (/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/.test(v)) return true;
  if (/^E[A-Z][A-Za-z0-9]*$/.test(v)) return true;
  if (v.includes('MoveAbort') || v.includes('ModuleId')) return true;
  return false;
}

/**
 * Turns a server/back-end error string into copy safe to show a user.
 * Known codes map to real messages, unknown machine codes fall back to
 * `fallback`, and anything that already reads as a sentence is returned
 * as-is (server-crafted messages stay authoritative).
 */
export function humanizeErrorMessage(
  raw: string | null | undefined,
  fallback: string = GENERIC_USER_ERROR,
): string {
  const value = (raw ?? '').trim();
  if (!value) return fallback;
  const known = KNOWN_CODE_MESSAGES[value];
  if (known) return known;
  if (looksLikeMachineCode(value)) return fallback;
  return value;
}
