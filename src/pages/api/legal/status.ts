// GET /api/legal/status — acceptance-gate status for the authenticated
// session user (docs/legal-drafts/ACCEPTANCE-GATE-SPEC.md "API").
//
// Auth: bound to the server-verified zkLogin session (HttpOnly `session-id`
// cookie via the session registry) — identity is NEVER taken from the
// request. Versions are resolved server-side from CURRENT_LEGAL_VERSIONS.
//
// Response: {
//   success, allAccepted, accepted (alias of allAccepted),
//   missing: LegalDocId[],
//   required: [{ doc, currentVersion, acceptedVersion|null }],
// }

import type { NextApiRequest, NextApiResponse } from 'next';
import { getZkLoginSessionAccount } from '../../../lib/zklogin-session-registry';
import { getLegalAcceptanceStatus } from '../../../lib/legal-acceptance-server';
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
    key: `legal-status:${getClientIp(req)}`,
    limit: REQUESTS_PER_WINDOW,
    windowMs: WINDOW_MS,
  });
  if (!rateOutcome.allowed) {
    res.setHeader('Retry-After', String(Math.ceil(rateOutcome.resetMs / 1000)));
    return res.status(429).json({ success: false, error: 'Too many requests' });
  }

  const sessionAccount = await getZkLoginSessionAccount(req.cookies?.['session-id']);
  if (!sessionAccount?.sub || !sessionAccount.aud || !sessionAccount.userAddr) {
    return res.status(401).json({
      success: false,
      error: 'AUTH_REQUIRED',
      message: 'Authentication required: no valid zkLogin session. Please sign in again.',
      requiresReauth: true,
    });
  }

  try {
    const status = await getLegalAcceptanceStatus(sessionAccount.sub, sessionAccount.aud);
    return res.status(200).json({
      success: true,
      allAccepted: status.allAccepted,
      accepted: status.allAccepted,
      missing: status.missing,
      required: status.required,
    });
  } catch (error) {
    console.error('[legal/status] failed to read acceptance status', error);
    return res.status(500).json({
      success: false,
      error: 'STATUS_LOOKUP_FAILED',
      message: 'Failed to read legal acceptance status.',
    });
  }
}
