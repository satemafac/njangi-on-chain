// client-ip.ts — Best-effort client IP extraction for rate-limit keys.
//
// Behind Heroku/most proxies the left-most x-forwarded-for entry is the
// original client. This is good enough for abuse throttling (the limiter
// only needs a stable-ish key, not a trusted identity); endpoints that need
// a *trusted* IP should follow the stricter parser in
// `pages/api/onramp/coinbase/session.ts`.

import type { NextApiRequest } from 'next';

export function getClientIp(req: NextApiRequest): string {
  const forwarded = req.headers['x-forwarded-for'];
  const first = Array.isArray(forwarded)
    ? forwarded[0]
    : forwarded?.split(',')[0]?.trim();
  return first || req.socket?.remoteAddress || 'unknown';
}
