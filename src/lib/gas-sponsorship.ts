// gas-sponsorship.ts — server-side policy + metering for Enoki-sponsored
// gas on njangi member actions.
//
// WHY THIS EXISTS
// A brand-new zkLogin user who funds their wallet by withdrawing USDC from a
// centralized exchange holds ZERO SUI and therefore cannot pay gas for any
// Move call — not even the swap that would get them SUI. That bricks the whole
// "just transfer from your exchange" onboarding. The fix is to let the app
// sponsor gas for the core member actions so holding SUI is never a
// precondition to participate.
//
// WHO PAYS
// Sponsorship is a PREMIUM benefit funded by the circle ADMIN's subscription:
// if the circle's on-chain admin holds a premium entitlement, that circle's
// members transact gas-free (within fair-use caps). Free-tier circles fall
// back to self-paid gas — nothing is ever *blocked*, it just costs the member
// the small Sui network fee. The fund-flow itself (contribute/claim/withdraw/
// recover) is NEVER paywalled; sponsorship only removes friction.
//
// SAFETY MODEL
//   1. Feature flag GAS_SPONSORSHIP_ENABLED must be "true".
//   2. Enoki `allowedMoveCallTargets` is pinned to this package's entry
//      functions only, so a griefer cannot make us sponsor arbitrary calls.
//   3. Per-user (per zkLogin sub) daily caps + a global monthly cap bound the
//      blast radius of abuse and runaway cost.
//   4. SUI-denominated contributions are NEVER sponsored: that path splits the
//      contribution amount from `txb.gas` (payment-coin-builder.ts), and under
//      sponsorship `txb.gas` is the SPONSOR's coin — sponsoring it would pay
//      the contribution out of our pocket. Only owned-Coin (USDC/stable) paths
//      are sponsorable, which is exactly the zero-SUI user we care about.
//   5. Any sponsorship failure is non-fatal: callers fall back to self-paid
//      gas so a sponsor outage never stops a member from transacting.
//
// OPERATOR PRE-REQS before flipping GAS_SPONSORSHIP_ENABLED=true:
//   - Rotate the previously-leaked NEXT_PUBLIC_ENOKI_* key and use the
//     server-only ENOKI_API_KEY_{TESTNET,MAINNET} (it can now spend a gas
//     budget, so a leak is a spend vector).
//   - In the Enoki dev portal: allowlist this package's move-call targets,
//     set a monthly gas budget cap, and enable only the intended network.

import { getSharedPgPool, isPostgresConfigured } from './pg-pool';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export function isGasSponsorshipEnabled(): boolean {
  return (process.env.GAS_SPONSORSHIP_ENABLED || 'false').toLowerCase() === 'true';
}

/** Max sponsored transactions per zkLogin subject per rolling 24h. */
export function perUserDailyCap(): number {
  const raw = Number(process.env.GAS_SPONSORSHIP_DAILY_CAP_PER_USER);
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 30;
}

/** Max sponsored transactions across ALL users per calendar month. */
export function globalMonthlyCap(): number {
  const raw = Number(process.env.GAS_SPONSORSHIP_MONTHLY_CAP_GLOBAL);
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 100_000;
}

// The njangi entry functions we are willing to sponsor. Fully-qualified
// targets are built per-network from the active package id. Native
// splitCoins/mergeCoins are TransactionBlock *commands*, not MoveCalls, so
// they are unaffected by this allowlist — only actual move calls are gated.
//
// Format: `${module}::${function}` (generic type params are NOT part of the
// Enoki target string). Deliberately EXCLUDES swap/Cetus targets — sponsored
// swaps widen the abuse surface and the swap path always has SUI anyway.
export const SPONSORABLE_MOVE_FUNCTIONS: readonly string[] = Object.freeze([
  // Cycle escrow — the money path a zero-SUI member must reach.
  'njangi_cycle_escrow::contribute',
  'njangi_cycle_escrow::contribute_with_attestation',
  'njangi_cycle_escrow::finalize_and_redeem',
  'njangi_cycle_escrow::finalize_and_redeem_with_attestation',
  'njangi_cycle_escrow::advance_circle_after_claim',
  'njangi_cycle_escrow::open_cycle_stable',
  'njangi_cycle_escrow::open_cycle_stable_with_gate',
  // Membership + recovery so a gas-less member is never trapped.
  'njangi_circles::member_deposit_security_deposit',
  'njangi_circles::execute_recovery',
  'njangi_circles::trigger_auto_release',
]);

/**
 * Fully-qualified Enoki `allowedMoveCallTargets` for the given package id.
 * Returns [] when packageId is missing (caller should then decline to sponsor
 * rather than sponsor an unbounded target set).
 */
export function allowedMoveCallTargets(packageId: string | null | undefined): string[] {
  const pkg = (packageId || '').trim();
  if (!pkg) return [];
  return SPONSORABLE_MOVE_FUNCTIONS.map((fn) => `${pkg}::${fn}`);
}

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

export interface SponsorshipAssessmentInput {
  /** Whether the circle admin (the payer) holds a premium entitlement. */
  adminIsPremium: boolean;
  /**
   * True when the transaction's *value* is drawn from `txb.gas` (SUI-mode
   * contributions). Such transactions must NOT be sponsored — see file header.
   */
  usesGasCoinForValue: boolean;
  /** Active package id; required to pin the move-target allowlist. */
  packageId: string | null | undefined;
}

export interface SponsorshipDecision {
  sponsor: boolean;
  reason: string;
}

/**
 * Pure policy check (no I/O). Cap enforcement is a separate async step so this
 * stays trivially testable. Order matters: cheapest / most-common declines
 * first.
 */
export function assessSponsorship(input: SponsorshipAssessmentInput): SponsorshipDecision {
  if (!isGasSponsorshipEnabled()) {
    return { sponsor: false, reason: 'disabled' };
  }
  if (input.usesGasCoinForValue) {
    return { sponsor: false, reason: 'sui_value_from_gas_coin' };
  }
  if (!input.adminIsPremium) {
    return { sponsor: false, reason: 'admin_not_premium' };
  }
  if (allowedMoveCallTargets(input.packageId).length === 0) {
    return { sponsor: false, reason: 'no_package_id' };
  }
  return { sponsor: true, reason: 'eligible' };
}

// ---------------------------------------------------------------------------
// Metering (Postgres; degrades to allow when the DB is absent)
// ---------------------------------------------------------------------------

export interface UsageCounts {
  userToday: number;
  globalThisMonth: number;
}

/**
 * Reads current sponsorship usage. If Postgres is not configured we return
 * zeros and let the transaction proceed sponsored — metering is a cost guard,
 * not a security control, and failing closed here would break onboarding on a
 * misconfigured deploy. (The Enoki portal budget cap is the hard backstop.)
 */
export async function getSponsorshipUsage(sub: string): Promise<UsageCounts> {
  if (!isPostgresConfigured()) {
    return { userToday: 0, globalThisMonth: 0 };
  }
  try {
    const pool = getSharedPgPool();
    const [userRes, globalRes] = await Promise.all([
      pool.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM gas_sponsorship_usage
         WHERE zklogin_sub = $1 AND sponsored_at > NOW() - INTERVAL '24 hours'`,
        [sub],
      ),
      pool.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM gas_sponsorship_usage
         WHERE sponsored_at >= date_trunc('month', NOW())`,
      ),
    ]);
    return {
      userToday: Number(userRes.rows[0]?.n ?? '0'),
      globalThisMonth: Number(globalRes.rows[0]?.n ?? '0'),
    };
  } catch (err) {
    console.error('[gas-sponsorship] usage read failed; allowing', err);
    return { userToday: 0, globalThisMonth: 0 };
  }
}

/**
 * Combines the pure policy decision with cap enforcement. Returns the final
 * go/no-go the caller uses to choose the sponsored vs self-paid path.
 */
export async function shouldSponsor(
  input: SponsorshipAssessmentInput & { sub: string },
): Promise<SponsorshipDecision> {
  const base = assessSponsorship(input);
  if (!base.sponsor) return base;

  const usage = await getSponsorshipUsage(input.sub);
  if (usage.userToday >= perUserDailyCap()) {
    return { sponsor: false, reason: 'user_daily_cap' };
  }
  if (usage.globalThisMonth >= globalMonthlyCap()) {
    return { sponsor: false, reason: 'global_monthly_cap' };
  }
  return { sponsor: true, reason: 'eligible' };
}

/**
 * Records one successful sponsored transaction for metering. Best-effort:
 * a logging failure must never fail the (already-executed) transaction.
 */
export async function recordSponsoredUsage(args: {
  sub: string;
  userAddress: string;
  circleId?: string | null;
  action: string;
  digest: string;
}): Promise<void> {
  if (!isPostgresConfigured()) return;
  try {
    const pool = getSharedPgPool();
    await pool.query(
      `INSERT INTO gas_sponsorship_usage
         (zklogin_sub, user_address, circle_id, action, tx_digest)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tx_digest) DO NOTHING`,
      [args.sub, args.userAddress, args.circleId ?? null, args.action, args.digest],
    );
  } catch (err) {
    console.error('[gas-sponsorship] usage write failed (non-fatal)', err);
  }
}
