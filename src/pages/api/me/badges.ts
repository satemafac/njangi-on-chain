// GET /api/me/badges — the signed-in member's own badges.
//
// Badges are facts about the member's own history, returned only to that
// member (session-bound, never by address) and rendered only on their own
// /record view. They are deliberately NOT part of /api/record or the shared
// record payload, so a share link can never carry them.

import type { NextApiRequest, NextApiResponse } from 'next';
import { getZkLoginSessionAccount } from '../../../lib/zklogin-session-registry';
import { listBadges } from '../../../lib/member-badges';
import { consumeRateLimit } from '../../../lib/rate-limit';
import { getClientIp } from '../../../lib/client-ip';
import { isPostgresConfigured } from '../../../lib/pg-pool';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }
  const rateOutcome = await consumeRateLimit({
    key: `badges:${getClientIp(req)}`,
    limit: 30,
    windowMs: 60_000,
  });
  if (!rateOutcome.allowed) {
    res.setHeader('Retry-After', String(Math.ceil(rateOutcome.resetMs / 1000)));
    return res.status(429).json({ success: false, error: 'Too many requests' });
  }
  const sessionAccount = await getZkLoginSessionAccount(req.cookies?.['session-id']);
  if (!sessionAccount?.userAddr) {
    return res.status(401).json({ success: false, error: 'AUTH_REQUIRED', requiresReauth: true });
  }
  if (!isPostgresConfigured()) {
    return res.status(200).json({ success: true, badges: [] });
  }
  try {
    const badges = await listBadges(sessionAccount.userAddr);
    return res.status(200).json({ success: true, badges });
  } catch (error) {
    console.error('[api/me/badges] failed', error);
    return res.status(500).json({ success: false, error: 'BADGES_FAILED' });
  }
}
