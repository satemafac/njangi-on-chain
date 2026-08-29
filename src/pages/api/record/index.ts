// GET /api/record — the authenticated member's own Circle Record.
//
// Auth: bound to the server-verified zkLogin session (HttpOnly `session-id`
// cookie). Identity is NEVER taken from the request — a caller-supplied
// address would let anyone pull anyone else's record, which is exactly the
// furnishing behaviour this feature refuses to have.

import type { NextApiRequest, NextApiResponse } from 'next';
import { getZkLoginSessionAccount } from '../../../lib/zklogin-session-registry';
import { buildCircleRecord } from '../../../lib/circle-record';
import { consumeRateLimit } from '../../../lib/rate-limit';
import { getClientIp } from '../../../lib/client-ip';

const REQUESTS_PER_WINDOW = 20;
const WINDOW_MS = 60_000;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const rateOutcome = await consumeRateLimit({
    key: `record:${getClientIp(req)}`,
    limit: REQUESTS_PER_WINDOW,
    windowMs: WINDOW_MS,
  });
  if (!rateOutcome.allowed) {
    res.setHeader('Retry-After', String(Math.ceil(rateOutcome.resetMs / 1000)));
    return res.status(429).json({ success: false, error: 'Too many requests' });
  }

  const sessionAccount = await getZkLoginSessionAccount(req.cookies?.['session-id']);
  if (!sessionAccount?.userAddr) {
    return res.status(401).json({
      success: false,
      error: 'AUTH_REQUIRED',
      message: 'Authentication required: no valid zkLogin session. Please sign in again.',
      requiresReauth: true,
    });
  }

  try {
    const record = await buildCircleRecord(sessionAccount.userAddr);
    return res.status(200).json({ success: true, record });
  } catch (error) {
    console.error('[api/record] failed to build record', error);
    return res.status(500).json({
      success: false,
      error: 'RECORD_BUILD_FAILED',
      message: 'Could not read your record right now. Please try again shortly.',
    });
  }
}
