// circle-quick-start.ts — the defaults behind the one-screen circle setup.
//
// The organizer types a name, an amount and (optionally) how often and how
// many people; everything else the contract needs is derived here so the
// happy path never shows a slider that starts at zero. Pure functions, so
// the derivation is unit-tested under jest's node environment even though
// the form itself is a page component.

/** Contract limits (move/sources/njangi_core.move: MIN_MEMBERS / MAX_MEMBERS). */
export const MIN_MEMBERS = 3;
export const MAX_MEMBERS = 20;

/** A first circle is usually a handful of people, not the contract minimum. */
export const QUICK_START_MEMBERS = 5;

export type QuickStartFrequency = 'weekly' | 'bi-weekly' | 'monthly' | 'quarterly';

export const QUICK_START_FREQUENCIES: ReadonlyArray<{
  value: QuickStartFrequency;
  labelKey: string;
}> = [
  { value: 'weekly', labelKey: 'create.frequency.weekly' },
  { value: 'bi-weekly', labelKey: 'create.frequency.biweekly' },
  { value: 'monthly', labelKey: 'create.frequency.monthly' },
  { value: 'quarterly', labelKey: 'create.frequency.quarterly' },
];

/** Weekly cadences are keyed by weekday, monthly ones by day-of-month. */
export function defaultCycleDay(frequency: QuickStartFrequency): 'monday' | 1 {
  return frequency === 'weekly' || frequency === 'bi-weekly' ? 'monday' : 1;
}

/**
 * The contract's minimum security deposit is half of one contribution
 * (`njangi_core::min_security_deposit`, integer division on cents:
 * `security_deposit_usd >= contribution_amount_usd / 2`). Rounding half a
 * contribution UP to the cent always satisfies that, including for odd cent
 * counts, and never produces zero for a positive contribution.
 */
export function deriveSecurityDeposit(contribution: number): number {
  if (!Number.isFinite(contribution) || contribution <= 0) return 0;
  return Math.ceil(contribution * 50) / 100;
}

/** Clamp a typed member count into the contract range. */
export function clampMembers(raw: number): number {
  if (!Number.isFinite(raw)) return QUICK_START_MEMBERS;
  const whole = Math.trunc(raw);
  return Math.min(MAX_MEMBERS, Math.max(MIN_MEMBERS, whole));
}

/**
 * The invite text the organizer forwards to their group. Kept short: the
 * link's own server-rendered card carries the details.
 */
export function buildWhatsAppShareUrl(message: string): string {
  return `https://wa.me/?text=${encodeURIComponent(message)}`;
}
