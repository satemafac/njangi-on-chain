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
 * Embedded Cetus swap routing.
 *
 * OFF for v1. Member-initiated swaps are the feature most likely to pull the
 * product into exchange / broker / order-routing analysis, and route and
 * slippage are currently chosen by the app rather than the user — which
 * undercuts the "neutral routing" posture the compliance invariants claim.
 * Re-enabling needs user-selected assets and slippage, disclosed objective
 * routing, client-side construction and signing, and no spread or rebate.
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
