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
