// feature-flags.ts — the single place a capability is switched on or off.
//
// Before this, each flag was a bespoke `isXEnabled()` next to the code it
// gated, and several gates were UI-only: hiding a button while the API route
// behind it stayed open to anyone who called it directly. A kill switch that
// only hides UI is not a kill switch.
//
// Two rules hold for everything here:
//
//   1. Default OFF. An unset or malformed value disables the capability. A
//      typo must not silently enable a money path.
//   2. Server-enforced. The route refuses the request; the UI merely stops
//      offering it. UI checks are for ergonomics, never for enforcement.
//
// The capability flags are NEXT_PUBLIC_ so ONE value drives both the server
// gate and the UI. A separate client mirror would eventually drift, and a UI
// that offers a capability the server refuses is worse than one that hides it.
// Being readable in the browser costs nothing here: these say what the product
// offers, not how it is protected, and enforcement lives in the route either
// way. Each read below is a static `process.env.NEXT_PUBLIC_*` member access so
// Next.js can inline it into the bundle.

/** Parses a flag with an explicit default. Anything but "true" is false. */
function flagEnabled(raw: string | undefined, defaultOn = false): boolean {
  if (raw === undefined || raw === '') return defaultOn;
  return raw.trim().toLowerCase() === 'true';
}

/**
 * Member-initiated DEX/CEX swap routing (Cetus today, other venues later).
 *
 * A SUPPORTED PRODUCT FEATURE, not a retired one — members need a way to
 * convert what they hold into the circle's contribution currency, and the
 * roadmap adds venues rather than removing them. The flag exists to disable
 * routing per environment (an outage, an unvetted new venue), not to phase
 * the capability out.
 *
 * The kill switch stays default-OFF because that is the safe direction for an
 * unset value, NOT a recommendation: production sets it true.
 *
 * What keeps this compatible with compliance invariant #5 ("neutral DEX
 * routing — member-initiated swaps only, no routing fee"), and what any new
 * venue integration has to preserve:
 *
 *   1. MEMBER-INITIATED. The app never swaps on a member's behalf or as a
 *      side effect of another action.
 *   2. NO FEE, SPREAD, REBATE, OR PAYMENT FOR ORDER FLOW. Revenue is the
 *      coordination subscription; taking a cut of a swap converts this into
 *      a fee on a fund flow, which invariant #3 forbids outright.
 *   3. CLIENT-SIGNED. Routing transactions are built and signed in the
 *      browser (`cetusService.getSwapTransactionPayload` ->
 *      `ZkLoginClient.sendPrebuiltTransactionBytes`). The server must never
 *      regain the ability to sign one — that was the Phase 0 oracle.
 *   4. DISCLOSED, OBJECTIVE ROUTING. Venue and slippage should be visible to
 *      the member and chosen on stated criteria, not silently by the app.
 *
 * (3) already holds. (4) is the weakest today: route and default slippage are
 * app-chosen, which is the part most worth tightening before a jurisdiction
 * where broker/order-routing analysis bites — surfacing the venue and letting
 * the member set slippage would close it.
 */
export function isSwapsEnabled(): boolean {
  return flagEnabled(process.env.NEXT_PUBLIC_SWAPS_ENABLED);
}

/**
 * The legacy custody / payments rail (njangi_payments::contribute,
 * trigger_payout, njangi_circles::contribute_stablecoin).
 *
 * OFF for v1. The per-cycle snapshot escrow has a materially stronger
 * non-custodial posture — rules frozen at open, exact-amount matching,
 * recipient-only redemption, refunds to recorded contributors — and running
 * both rails means two money paths to audit instead of one. Nothing here
 * removes funds already in the legacy rail: recovery and refund paths stay
 * open, because a kill switch must never trap money.
 */
export function isLegacyRailEnabled(): boolean {
  return flagEnabled(process.env.NEXT_PUBLIC_LEGACY_RAIL_ENABLED);
}

/**
 * Partner-hosted fiat on-ramps, per provider.
 *
 * Each provider's session endpoint must consult this. MoonPay and Transak
 * already did; Coinbase's endpoint never checked its own flag, so the ramp was
 * reachable by direct call while the UI hid it.
 */
/**
 * Circle Record v1.1 escrow entry points (indexed opens + timed
 * contributions). The v6 package adds `open_cycle*_indexed` — which append
 * the new escrow's id to the circle's on-chain history so past escrows are
 * enumerable by object read — and `contribute_timed*`, which record a
 * per-member contribution timestamp so "paid on time" can be an on-chain
 * fact.
 *
 * The flag says WHICH TARGETS THE CLIENT BUILDS, nothing more: flip it on
 * only after the package version carrying these functions is published on
 * the active network, or every open/contribute aborts with an unknown-
 * function error. Old circles and old escrows keep working through the
 * original entries either way — readers treat missing history/timestamps
 * as "not recorded", never as "didn't happen".
 */
export function isTimedEscrowEntriesEnabled(): boolean {
  return flagEnabled(process.env.NEXT_PUBLIC_ESCROW_TIMED_ENTRIES_ENABLED);
}

/**
 * Circle Record v1.2 duplicate-open guard. The package version carrying it
 * refuses a second escrow for a round that already has a live one
 * (`E_ROUND_ALREADY_OPEN`, 234) and adds `release_open_round`, which
 * unpins a round whose escrow can no longer pay out (refunded, or empty
 * past its cancel window) so the same round can be opened again.
 *
 * Same rule as `isTimedEscrowEntriesEnabled`: this says which targets the
 * client BUILDS. Flip it on only after that package is published on the
 * active network — before then the release call names a function that does
 * not exist and the whole open aborts. Left off after the publish, a
 * re-open of a refunded round aborts 234 instead, because nothing released
 * the marker; the panel explains that refusal, but flipping the flag is the
 * fix.
 */
export function isEscrowRoundGuardEnabled(): boolean {
  return flagEnabled(process.env.NEXT_PUBLIC_ESCROW_ROUND_GUARD_ENABLED);
}

/**
 * Collecting a round that is already finalized. The package version carrying
 * it lets `finalize_and_redeem*` pay out an escrow someone else finalized
 * (`finalize_to_recipient` is permissionless) straight from the escrow, so
 * Collect is one call whatever the round's finalize state and never needs
 * the recipient's `Claim<T>` object.
 *
 * Same rule as the flags above: this says which transaction the client
 * BUILDS. Flip it on only after that package is published on the active
 * network — before then `finalize_and_redeem` on a finalized escrow aborts
 * 205 E_ALREADY_FINALIZED. Left off, Collect on a finalized escrow redeems
 * the Claim from the recipient's wallet instead (cycle-escrow-collect.ts).
 */
export function isFinalizedEscrowCollectEnabled(): boolean {
  return flagEnabled(process.env.NEXT_PUBLIC_ESCROW_FINALIZED_COLLECT_ENABLED);
}

/**
 * v11 Move package: circles pin their asset terms (settlement coin, decimals,
 * native amounts), security deposits are v11 deposit records in the circle's
 * custody wallet (`post_security_deposit<T>`), new circles are created with
 * `create_circle_with_asset<T>`, and removal returns a deposit in the coin it
 * was paid in (`admin_remove_member_asset<T>`). See src/lib/v11-circle-tx.ts.
 *
 * Same rule as the flags above, and stricter: flip it on only after the v11
 * package is published on the active network, the AssetRegistry is blessed
 * with the circle assets registered, and the existing circles are converted.
 * v11 retires the unpinned `create_circle` and the legacy deposit entrypoint,
 * so once the active package id is v11 this flag must be ON or creating a
 * circle and posting a deposit abort (89).
 */
export function isV11AssetTermsEnabled(): boolean {
  return flagEnabled(process.env.NEXT_PUBLIC_V11_ENABLED);
}

/**
 * Planned close: the organizer's "Close the circle" on a circle paused at the
 * end of a lap (`njangi_circles::complete_circle`, chained with
 * `refund_asset<T>` so every recorded deposit goes back to its member in the
 * same transaction). Before this existed a circle had no ordinary ending:
 * deposits came back only through the emergency-stop vote or the opt-in
 * auto-release.
 *
 * Same rule as the flags above: this says which targets the client BUILDS.
 * Flip it on only after the package carrying `complete_circle` is published
 * on the active network — before then the call names a function that does
 * not exist and the whole transaction aborts.
 */
export function isCircleWindDownEnabled(): boolean {
  return flagEnabled(process.env.NEXT_PUBLIC_CIRCLE_WIND_DOWN_ENABLED);
}

/**
 * Goal pools: the non-rotating `njangi_goal_pool::GoalPool<T>` minted by the
 * "saving toward one goal" door on /create-circle (`buildOpenGoalPoolTx`,
 * client-signed straight to RPC).
 *
 * OFF for the first mainnet cohort. Owner decision 2026-10-07, stated in the
 * counsel brief: the pool is not enabled for members without counsel's
 * advice, so the deployment has to enforce it rather than rely on the
 * Premium entitlement — with `NEXT_PUBLIC_BILLING_ENABLED=false` every
 * organizer is treated as Premium, which left the option live for everyone.
 * Testnet may set it true for pilot testing; mainnet leaves it unset.
 *
 * Gates CREATION only. Pools that already exist stay readable and
 * operable (/pool/<id>, the dashboard's goal-pools section): a kill
 * switch must never trap money, and the brief covers new pools, not the
 * testnet ones already open.
 */
export function isGoalPoolsEnabled(): boolean {
  return flagEnabled(process.env.NEXT_PUBLIC_GOAL_POOLS_ENABLED);
}

export function isRampEnabled(provider: 'coinbase' | 'moonpay' | 'transak'): boolean {
  switch (provider) {
    case 'coinbase':
      return flagEnabled(process.env.NEXT_PUBLIC_COINBASE_ONRAMP_ENABLED);
    case 'moonpay':
      return flagEnabled(process.env.NEXT_PUBLIC_MOONPAY_ENABLED);
    case 'transak':
      return flagEnabled(process.env.NEXT_PUBLIC_TRANSAK_ENABLED);
  }
}

/** Uniform 503 body so a disabled capability is machine-distinguishable. */
export function disabledResponse(capability: string, message: string) {
  return {
    error: 'CAPABILITY_DISABLED',
    capability,
    message,
  };
}
