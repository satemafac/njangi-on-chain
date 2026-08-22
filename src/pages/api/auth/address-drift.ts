// GET /api/auth/address-drift — has this signed-in identity resolved to a
// different Sui address than it has before?
//
// Auth: bound to the server-verified zkLogin session (HttpOnly `session-id`
// cookie via the session registry). Identity is NEVER taken from the
// request — a body- or query-supplied sub/address would let a caller probe
// someone else's binding history.
//
// Modeled on /api/legal/status.ts, which solves the same shape of problem
// (a blocking client gate that needs a cheap, session-bound status read).
//
// Response: {
//   success, status: 'first_seen'|'known'|'drifted'|'unavailable',
//   drifted: boolean,
//   currentAddress: string,
//   previousAddresses: string[],   // empty unless drifted
// }
//
// Read-only: this deliberately does not record a binding. It is polled on
// ordinary page loads, and bumping login_count on every poll would corrupt
// the signal that distinguishes a real login from a page view.

import type { NextApiRequest, NextApiResponse } from 'next';
import { getZkLoginSessionAccount } from '../../../lib/zklogin-session-registry';
import { getDriftStatusForIdentity } from '../../../lib/zklogin-address-bindings';
import { consumeRateLimit } from '../../../lib/rate-limit';
import { getClientIp } from '../../../lib/client-ip';

const REQUESTS_PER_WINDOW = 30;
const WINDOW_MS = 60_000;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const rateOutcome = await consumeRateLimit({
    key: `address-drift:${getClientIp(req)}`,
    limit: REQUESTS_PER_WINDOW,
    windowMs: WINDOW_MS,
  });
  if (!rateOutcome.allowed) {
    res.setHeader('Retry-After', String(Math.ceil(rateOutcome.resetMs / 1000)));
    return res.status(429).json({ success: false, error: 'Too many requests' });
  }

  const sessionAccount = await getZkLoginSessionAccount(req.cookies?.['session-id']);
  if (!sessionAccount?.sub || !sessionAccount.userAddr) {
    return res.status(401).json({
      success: false,
      error: 'AUTH_REQUIRED',
      message: 'Authentication required: no valid zkLogin session. Please sign in again.',
      requiresReauth: true,
    });
  }

  try {
    const result = await getDriftStatusForIdentity({
      iss: sessionAccount.iss ?? null,
      sub: sessionAccount.sub,
      provider: sessionAccount.provider,
      userAddress: sessionAccount.userAddr,
    });

    return res.status(200).json({
      success: true,
      status: result.status,
      drifted: result.drifted,
      currentAddress: result.currentAddress,
      previousAddresses: result.previousAddresses,
    });
  } catch (error) {
    console.error('[auth/address-drift] status lookup failed', error);
    // Fail OPEN, consistently with the detection path: a lookup outage must
    // not raise a blocking interstitial in front of every user.
    return res.status(200).json({
      success: true,
      status: 'unavailable',
      drifted: false,
      currentAddress: sessionAccount.userAddr,
      previousAddresses: [],
    });
  }
}
