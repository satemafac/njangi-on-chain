// GET /api/sanctions/check?address=0x... — UX preflight for the
// client-signed flows (goal-pool create, escrow open), which submit
// straight to RPC and never pass through a server choke point. The SDN
// list is public, so this oracle leaks nothing; rate-limited per IP to
// keep it from being used as a bulk lookup service.
//
// The AUTHORITATIVE screens live at the server choke points
// (docs/sanctions-program.md). A blocked:false here is a convenience,
// never a clearance.

import type { NextApiRequest, NextApiResponse } from 'next';
import { screenAddress } from '../../../lib/sanctions';
import { getClientIp } from '../../../lib/client-ip';
import { consumeRateLimit } from '../../../lib/rate-limit';

const REQUESTS_PER_MINUTE = 20;
const MINUTE_WINDOW_MS = 60_000;

const ADDRESS_RE = /^0x[a-fA-F0-9]{1,64}$/;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const address = typeof req.query.address === 'string' ? req.query.address.trim() : '';
  if (!ADDRESS_RE.test(address)) {
    return res.status(400).json({ error: 'Invalid address' });
  }

  const rateOutcome = await consumeRateLimit({
    key: `sanctions-check:${getClientIp(req)}`,
    limit: REQUESTS_PER_MINUTE,
    windowMs: MINUTE_WINDOW_MS,
  });
  if (!rateOutcome.allowed) {
    res.setHeader('Retry-After', String(Math.ceil(rateOutcome.resetMs / 1000)));
    return res.status(429).json({ error: 'Too many requests' });
  }

  const { blocked } = await screenAddress(address, 'client_preflight');
  res.setHeader('Cache-Control', 'private, no-store');
  return res.status(200).json({ blocked });
}
