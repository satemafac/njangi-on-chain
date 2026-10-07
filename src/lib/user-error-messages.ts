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

// ---------------------------------------------------------------------------
// Contract refusals with copy of their own
// ---------------------------------------------------------------------------
//
// A failed transaction names the aborting module and the abort code:
// `MoveAbort(MoveLocation { module: ModuleId { address: 0x…, name:
// Identifier("njangi_cycle_escrow") }, …, function_name: Some("open_cycle") }, 237)`.
// A code is only trusted together with its module, as cycle-open-round-lock
// reads 234/235: 85 in njangi_circles is not 85 anywhere else.

interface MoveAbortCopy {
  moduleName: string;
  code: number;
  message: string;
}

const MOVE_ABORT_COPY: readonly MoveAbortCopy[] = [
  {
    moduleName: 'njangi_cycle_escrow',
    code: 236,
    message: "This circle isn't running, so a round can't be opened or paid into right now.",
  },
  {
    moduleName: 'njangi_cycle_escrow',
    code: 237,
    message: 'This circle is paused between laps. Resume the cycle, then open the next round.',
  },
  {
    moduleName: 'njangi_cycle_escrow',
    code: 239,
    message: "That isn't this circle's coin. Refresh the page and try again.",
  },
  {
    moduleName: 'njangi_cycle_escrow',
    code: 243,
    message: "That doesn't match this circle's coin settings. Refresh the page and try again.",
  },
  // The stalled-round cancel (cancel_unfinalized_escrow*). 205 and 226 are
  // left to the generic copy: the panel re-reads on any on-chain refusal and
  // then shows the settled or refunded round itself.
  {
    moduleName: 'njangi_cycle_escrow',
    code: 224,
    message:
      "This round can't be cancelled yet: the 7-day grace after its due date hasn't passed on the blockchain's clock. Refresh and try again later.",
  },
  {
    moduleName: 'njangi_cycle_escrow',
    code: 225,
    message:
      'There are no shares left in this round to send back. Refresh to see its current state.',
  },
  {
    moduleName: 'njangi_cycle_escrow',
    code: 227,
    message:
      "This circle hasn't been stopped by its members, so the round can only be cancelled once the 7-day grace after its due date has passed.",
  },
  {
    moduleName: 'njangi_circles',
    code: 92,
    message:
      'This circle needs its one-time update before an emergency stop can run or a member can be removed. Please try again shortly, or contact support.',
  },
  {
    moduleName: 'njangi_circles',
    code: 85,
    message: "This circle's coin and amounts are fixed and can't be changed.",
  },
];

/** The deprecation code every njangi module shares (89). */
const RETIRED_ACTION_CODE = 89;
const RETIRED_ACTION_MESSAGE = 'This action was retired. Refresh the page to use the current version.';

const MOVE_ABORT_LOCATION = /MoveAbort\([\s\S]*?Identifier\("([A-Za-z_][A-Za-z0-9_]*)"\)[\s\S]*?\}\s*,\s*(\d+)\s*\)/;

/**
 * Copy for a contract refusal this app explains in its own words, read from a
 * failed transaction's error. Null for anything else, including the same code
 * raised by a different module.
 */
export function moveAbortUserMessage(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const match = message.match(MOVE_ABORT_LOCATION);
  if (!match) return null;
  const [, moduleName, rawCode] = match;
  const code = Number(rawCode);
  if (code === RETIRED_ACTION_CODE && moduleName.startsWith('njangi_')) return RETIRED_ACTION_MESSAGE;
  return MOVE_ABORT_COPY.find((entry) => entry.moduleName === moduleName && entry.code === code)?.message ?? null;
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
  const refusal = moveAbortUserMessage(value);
  if (refusal) return refusal;
  if (looksLikeMachineCode(value)) return fallback;
  return value;
}
