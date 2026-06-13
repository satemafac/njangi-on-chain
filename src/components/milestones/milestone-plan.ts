// milestone-plan.ts — Shared model + validation for the smart-goal
// milestone UI. Mirrors the abort conditions of
// move/sources/njangi_milestones.move so users hit a readable inline
// message instead of a raw on-chain abort code:
//
//   E_TARGET_INVALID (405)        — zero monetary target / past time target
//   E_TARGET_NOT_INCREASING (406) — same-kind targets must strictly grow
//   E_TOO_MANY_MILESTONES (407)   — at most 32 milestones per tracker
//   E_DESCRIPTION_TOO_LONG (421)  — descriptions capped at 256 UTF-8 bytes
//
// Two validation layers:
//   * SKETCH (create-circle): the admin outlines milestones before the
//     circle exists. Monetary targets are captured in USD; the plan is
//     persisted locally and pre-fills the on-chain creator later.
//   * PUBLISH (goals page): exact base-unit targets of the settlement
//     coin, validated against the tracker's already-on-chain floors.

// Mirror the Move module's hard caps (njangi_milestones.move).
export const MAX_MILESTONES = 32;
export const MAX_DESCRIPTION_BYTES = 256;

export type MilestoneDraftKind = 'monetary' | 'time';

/** One planned milestone. Sketches carry `targetUsd`; publish-ready
 *  entries carry `targetAmountBase` (exact base units of the settlement
 *  coin). Time milestones always use `targetTimestampMs`. */
export interface MilestoneDraft {
  kind: MilestoneDraftKind;
  description: string;
  /** Monetary target in USD (creation-time sketch). */
  targetUsd?: number;
  /** Monetary target in base units of the settlement coin, as a decimal
   *  string (publish-ready). */
  targetAmountBase?: string;
  /** Time target as a Unix epoch in ms. */
  targetTimestampMs?: number;
  requiresVerification: boolean;
}

export function descriptionByteLength(description: string): number {
  return new TextEncoder().encode(description ?? '').length;
}

function describeEntry(index: number): string {
  return `Milestone ${index + 1}`;
}

function commonEntryErrors(entry: MilestoneDraft, index: number): string[] {
  const errors: string[] = [];
  if (!entry.description.trim()) {
    errors.push(`${describeEntry(index)}: add a short description so the circle knows what it is working toward.`);
  } else if (descriptionByteLength(entry.description) > MAX_DESCRIPTION_BYTES) {
    errors.push(`${describeEntry(index)}: the description is too long (max ${MAX_DESCRIPTION_BYTES} characters).`);
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Sketch validation (create-circle, USD targets)
// ---------------------------------------------------------------------------

export interface SketchValidationContext {
  nowMs: number;
}

/**
 * Validates a creation-time milestone sketch. Monetary targets in USD
 * must be positive and strictly increasing; time targets must lie in the
 * future and strictly increase; descriptions and the 32-milestone cap
 * mirror the contract.
 */
export function validatePlanSketch(
  plan: MilestoneDraft[],
  ctx: SketchValidationContext,
): string[] {
  const errors: string[] = [];
  if (plan.length > MAX_MILESTONES) {
    errors.push(`A circle can hold at most ${MAX_MILESTONES} milestones.`);
  }
  let lastUsd = 0;
  let lastTimeMs = 0;
  plan.forEach((entry, index) => {
    errors.push(...commonEntryErrors(entry, index));
    if (entry.kind === 'monetary') {
      const usd = entry.targetUsd ?? 0;
      if (!Number.isFinite(usd) || usd <= 0) {
        errors.push(`${describeEntry(index)}: set a savings target greater than zero.`);
      } else if (usd <= lastUsd) {
        errors.push(
          `${describeEntry(index)}: each savings milestone must aim higher than the one before it (previous target $${lastUsd.toLocaleString()}).`,
        );
      } else {
        lastUsd = usd;
      }
    } else {
      const target = entry.targetTimestampMs ?? 0;
      if (!Number.isFinite(target) || target <= ctx.nowMs) {
        errors.push(`${describeEntry(index)}: pick a date in the future.`);
      } else if (target <= lastTimeMs) {
        errors.push(`${describeEntry(index)}: each date milestone must come after the previous one.`);
      } else {
        lastTimeMs = target;
      }
    }
  });
  return errors;
}

// ---------------------------------------------------------------------------
// Publish validation (goals page, base-unit targets)
// ---------------------------------------------------------------------------

export interface PublishValidationContext {
  nowMs: number;
  /** Highest monetary target already on chain (base units); 0n when none. */
  monetaryFloorBase: bigint;
  /** Highest time target already on chain (ms); 0 when none. */
  timeFloorMs: number;
  /** Milestones already on chain (counts toward MAX_MILESTONES). */
  existingOnChainCount: number;
}

/**
 * Validates a publish-ready plan against the contract's abort conditions,
 * including the floors set by milestones that already exist on chain.
 */
export function validatePublishPlan(
  plan: MilestoneDraft[],
  ctx: PublishValidationContext,
): string[] {
  const errors: string[] = [];
  if (plan.length === 0) {
    errors.push('Add at least one milestone before publishing.');
  }
  if (ctx.existingOnChainCount + plan.length > MAX_MILESTONES) {
    errors.push(`A circle can hold at most ${MAX_MILESTONES} milestones.`);
  }
  let lastMonetary = ctx.monetaryFloorBase;
  let lastTimeMs = ctx.timeFloorMs;
  plan.forEach((entry, index) => {
    errors.push(...commonEntryErrors(entry, index));
    if (entry.kind === 'monetary') {
      let target: bigint;
      try {
        target = BigInt(entry.targetAmountBase ?? '0');
      } catch {
        target = 0n;
      }
      if (target <= 0n) {
        errors.push(`${describeEntry(index)}: set a savings target greater than zero.`);
      } else if (target <= lastMonetary) {
        errors.push(
          `${describeEntry(index)}: each savings milestone must aim higher than the one before it.`,
        );
      } else {
        lastMonetary = target;
      }
    } else {
      const target = entry.targetTimestampMs ?? 0;
      if (!Number.isFinite(target) || target <= ctx.nowMs) {
        errors.push(`${describeEntry(index)}: pick a date in the future.`);
      } else if (target <= lastTimeMs) {
        errors.push(`${describeEntry(index)}: each date milestone must come after the previous one.`);
      } else {
        lastTimeMs = target;
      }
    }
  });
  return errors;
}

// ---------------------------------------------------------------------------
// Display-amount parsing/formatting (exact, no float round-trips)
// ---------------------------------------------------------------------------

/**
 * Parses a human decimal string ("1.5") into base units (1500000000n for
 * 9 decimals) without floating-point error. Returns null for anything
 * that is not a plain non-negative decimal number or that carries more
 * fractional digits than the coin supports.
 */
export function parseDisplayAmountToBase(
  input: string,
  decimals: number,
): bigint | null {
  const trimmed = (input ?? '').trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const [whole, fraction = ''] = trimmed.split('.');
  if (fraction.length > decimals) return null;
  try {
    const paddedFraction = fraction.padEnd(decimals, '0');
    return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(paddedFraction || '0');
  } catch {
    return null;
  }
}

/** Formats base units back into a human decimal string (no symbol). */
export function formatBaseAmount(
  base: string | bigint,
  decimals: number,
): string {
  let value: bigint;
  try {
    value = typeof base === 'bigint' ? base : BigInt(base);
  } catch {
    return String(base);
  }
  const divisor = 10n ** BigInt(decimals);
  const whole = value / divisor;
  const fraction = value % divisor;
  if (fraction === 0n) return whole.toString();
  const fractionStr = fraction
    .toString()
    .padStart(decimals, '0')
    .replace(/0+$/, '');
  return `${whole.toString()}.${fractionStr}`;
}

// ---------------------------------------------------------------------------
// Friendly abort-code mapping (njangi_milestones error codes 400-421)
// ---------------------------------------------------------------------------

const MILESTONE_ABORT_MESSAGES: Record<number, string> = {
  400: 'Only the circle admin can do that.',
  401: 'That round belongs to a different circle.',
  402: 'That milestone does not exist.',
  403: 'The milestone plan is locked — progress has already been recorded.',
  404: 'The rotation has already started, so the milestone plan can no longer change.',
  405: 'Milestone targets must be greater than zero and dates must be in the future.',
  406: 'Each milestone target must be bigger than the one before it.',
  407: `A circle can hold at most ${MAX_MILESTONES} milestones.`,
  408: 'That round has not been collected yet — only settled rounds count toward the goal.',
  409: 'That round has already been counted toward the goal.',
  410: 'Milestones complete in order — celebrate the earlier one first.',
  411: 'The milestone target has not been reached yet.',
  412: 'The admin needs to confirm this milestone before it can complete.',
  413: 'This milestone has already been confirmed by the admin.',
  414: 'This milestone completes automatically — no admin confirmation needed.',
  415: 'This milestone is already completed.',
  416: 'Only circle members can submit proof for a milestone.',
  417: 'That proof is too large (max 512 bytes).',
  418: 'This milestone already holds the maximum number of proofs.',
  419: 'That amount is too large to record.',
  420: 'This circle was not created with a smart goal.',
  421: `The milestone description is too long (max ${MAX_DESCRIPTION_BYTES} characters).`,
};

/**
 * Maps a Move abort from the njangi_milestones module to a friendly
 * sentence. Falls back to the raw error message for anything else.
 */
export function explainMilestoneError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (raw.includes('njangi_milestones')) {
    // MoveAbort(MoveLocation { ... name: Identifier("njangi_milestones") ... }, 406)
    const match = raw.match(/njangi_milestones[\s\S]*?[},]\s*(\d{3})\s*\)/);
    if (match) {
      const friendly = MILESTONE_ABORT_MESSAGES[Number(match[1])];
      if (friendly) return friendly;
    }
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Pending-plan persistence (create-circle → goals page hand-off)
// ---------------------------------------------------------------------------

/**
 * A milestone sketch saved at circle creation, waiting for the admin to
 * publish it on the goals page once the circle exists on chain.
 */
export interface PendingMilestonePlan {
  adminAddress: string;
  circleName: string;
  savedAtMs: number;
  entries: MilestoneDraft[];
}

const PENDING_PLAN_KEY_PREFIX = 'njangi.milestones.pendingPlan.';

function pendingPlanKey(adminAddress: string): string {
  return `${PENDING_PLAN_KEY_PREFIX}${(adminAddress ?? '').toLowerCase()}`;
}

export function savePendingMilestonePlan(plan: PendingMilestonePlan): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(pendingPlanKey(plan.adminAddress), JSON.stringify(plan));
  } catch {
    /* storage full/blocked — the sketch is a convenience, not a record */
  }
}

export function loadPendingMilestonePlan(
  adminAddress: string,
): PendingMilestonePlan | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(pendingPlanKey(adminAddress));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingMilestonePlan;
    if (!parsed || !Array.isArray(parsed.entries)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearPendingMilestonePlan(adminAddress: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(pendingPlanKey(adminAddress));
  } catch {
    /* ignore */
  }
}
