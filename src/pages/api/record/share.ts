// /api/record/share — create, list and revoke share links for the
// authenticated member's own record.
//
//   GET    -> the member's live links
//   POST   -> create one { ttlDays? }
//   DELETE -> revoke one { token }
//
// Every route is bound to the server-verified zkLogin session. A member can
// only ever create or revoke links for their OWN address; the address is
// taken from the session, never from the request.

import type { NextApiRequest, NextApiResponse } from 'next';
import { getZkLoginSessionAccount } from '../../../lib/zklogin-session-registry';
import {
  createShareToken,
  listShareTokens,
  revokeShareToken,
  clampTtlDays,
  DEFAULT_TTL_DAYS,
} from '../../../lib/circle-record-share';
import { consumeRateLimit } from '../../../lib/rate-limit';
import { getClientIp } from '../../../lib/client-ip';

const REQUESTS_PER_WINDOW = 20;
const WINDOW_MS = 60_000;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!['GET', 'POST', 'DELETE'].includes(req.method ?? '')) {
    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const rateOutcome = await consumeRateLimit({
    key: `record-share:${getClientIp(req)}`,
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
  const address = sessionAccount.userAddr;

  try {
    if (req.method === 'GET') {
      const links = await listShareTokens(address);
      return res.status(200).json({ success: true, links });
    }

    if (req.method === 'POST') {
      const ttlDays = clampTtlDays(
        (req.body as { ttlDays?: unknown } | undefined)?.ttlDays ?? DEFAULT_TTL_DAYS,
      );
      const link = await createShareToken(address, ttlDays);
      return res.status(201).json({ success: true, link });
    }

    const token = (req.body as { token?: unknown } | undefined)?.token;
    if (typeof token !== 'string' || token.length === 0) {
      return res.status(400).json({ success: false, error: 'TOKEN_REQUIRED' });
    }
    const revoked = await revokeShareToken(address, token);
    return res.status(revoked ? 200 : 404).json({ success: revoked });
  } catch (error) {
    console.error('[api/record/share] failed', error);
    return res.status(500).json({
      success: false,
      error: 'SHARE_LINK_FAILED',
      message: 'Could not update your share links right now.',
    });
  }
}
