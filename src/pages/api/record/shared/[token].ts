// GET /api/record/shared/[token] — the record behind a share link.
//
// Deliberately UNAUTHENTICATED: the point of a share link is that the
// member can hand it to a landlord, a cooperative, or another circle's
// organizer who has no account here.
//
// Two properties matter:
//
//   * Unknown, expired and revoked tokens all return the same 404. Telling
//     a visitor "this link expired" versus "no such link" would leak
//     whether a token ever existed.
//   * The response carries the record and the object ids behind it, so the
//     recipient can verify against the public ledger instead of trusting
//     our rendering. A statement only we can vouch for is worthless.

import type { NextApiRequest, NextApiResponse } from 'next';
import { resolveShareToken } from '../../../../lib/circle-record-share';
import { buildCircleRecord } from '../../../../lib/circle-record';
import { consumeRateLimit } from '../../../../lib/rate-limit';
import { getClientIp } from '../../../../lib/client-ip';

const REQUESTS_PER_WINDOW = 30;
const WINDOW_MS = 60_000;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const rateOutcome = await consumeRateLimit({
    key: `record-shared:${getClientIp(req)}`,
    limit: REQUESTS_PER_WINDOW,
    windowMs: WINDOW_MS,
  });
  if (!rateOutcome.allowed) {
    res.setHeader('Retry-After', String(Math.ceil(rateOutcome.resetMs / 1000)));
    return res.status(429).json({ success: false, error: 'Too many requests' });
  }

  const token = Array.isArray(req.query.token) ? req.query.token[0] : req.query.token;
  if (!token) {
    return res.status(404).json({ success: false, error: 'NOT_FOUND' });
  }

  try {
    const address = await resolveShareToken(token);
    if (!address) {
      // Same response for unknown / expired / revoked — see header.
      return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    }

    const record = await buildCircleRecord(address);
    return res.status(200).json({ success: true, record });
  } catch (error) {
    console.error('[api/record/shared] failed', error);
    return res.status(500).json({
      success: false,
      error: 'RECORD_BUILD_FAILED',
      message: 'Could not read this record right now.',
    });
  }
}
