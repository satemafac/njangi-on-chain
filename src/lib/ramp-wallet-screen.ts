// ramp-wallet-screen.ts — the one destination-wallet screen every fiat ramp
// session route runs (docs/sanctions-program.md, "Ramp session" row).
//
// Server-only: imports src/lib/sanctions.ts, which pulls in the pg pool.
//
// Geo-blocking alone leaves the case this control exists for: a listed
// address funding itself from a permitted jurisdiction. The wallet is what
// receives the funds, so the wallet is what gets screened — before any
// signed widget URL or session token is minted. Fail CLOSED: starting a
// ramp session is a new commitment, and an unscreened one cannot be undone
// once the partner has delivered funds on chain (the asymmetry with
// claim/refund/recovery is spelled out on ScreenOptions.failClosed).
//
// Until 2026-10 only the Coinbase route ran this screen; MoonPay and Transak
// checked the IP country alone. All three ramps are switched off in
// production (NEXT_PUBLIC_*_ENABLED=false); routing every session route
// through this helper makes the documented control true for every ramp
// before any of them is switched on, and keeps the three refusals from
// drifting apart.

import { screenAddress } from './sanctions';

/**
 * User-facing copy, identical across the ramp routes and
 * api/join-requests/create.ts. Deliberately neutral: no OFAC/sanctions
 * wording user-side — the stable `error` code and the sanctions_screen_log
 * rows carry the real reason for ops.
 */
export const SANCTIONS_BLOCKED_MESSAGE = "This wallet can't use Njangi On-Chain.";
export const SCREENING_UNAVAILABLE_MESSAGE =
  'We could not complete a required compliance check. Please try again shortly.';

export interface RampWalletScreenRefusal {
  refused: true;
  /** 'hit' is a real SDN match; 'unavailable' means the check could not run. */
  reason: 'hit' | 'unavailable';
  /**
   * 403 for a match, 503 for an outage. An innocent user must not be told
   * they are banned because Postgres blinked — the 503 says "retry".
   */
  status: 403 | 503;
  error: 'SANCTIONS_BLOCKED' | 'SCREENING_UNAVAILABLE';
  message: string;
}

export type RampWalletScreenResult =
  | { refused: false; listVersion: string | null }
  | RampWalletScreenRefusal;

/**
 * Screens the ramp destination wallet as a NEW COMMITMENT
 * (`screenAddress(wallet, 'ramp_session', { failClosed: true })`) and maps
 * the outcome to the status/code/message the route must answer with. The
 * caller adds its own `provider` field (and, for Coinbase, `fallbackProvider`)
 * — a refusal here never offers another ramp.
 */
export async function screenRampWallet(
  walletAddress: string,
): Promise<RampWalletScreenResult> {
  const screen = await screenAddress(walletAddress, 'ramp_session', {
    failClosed: true,
  });
  if (!screen.blocked) {
    return { refused: false, listVersion: screen.listVersion };
  }
  if (screen.reason === 'unavailable') {
    return {
      refused: true,
      reason: 'unavailable',
      status: 503,
      error: 'SCREENING_UNAVAILABLE',
      message: SCREENING_UNAVAILABLE_MESSAGE,
    };
  }
  return {
    refused: true,
    reason: 'hit',
    status: 403,
    error: 'SANCTIONS_BLOCKED',
    message: SANCTIONS_BLOCKED_MESSAGE,
  };
}
