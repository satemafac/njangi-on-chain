// compliance-auth.ts — Shared shared-secret + rate-limit guard for every
// `/api/compliance/*` endpoint. Centralises the auth logic so we don't
// drift between the three routes.

import type { NextApiRequest, NextApiResponse } from 'next';
import { createHash } from 'crypto';
import { consumeRateLimit } from './rate-limit';
import { timingSafeEqualStrings } from './timing-safe';

const DEFAULT_LIMIT = Number(process.env.COMPLIANCE_RATE_LIMIT ?? '60');
const DEFAULT_WINDOW_MS = Number(process.env.COMPLIANCE_RATE_LIMIT_WINDOW_MS ?? '60000');

function sharedSecret(): string | null {
  const candidate =
    process.env.COMPLIANCE_ISSUANCE_SECRET || process.env.INTERNAL_NOTIFY_SECRET;
  return candidate && candidate.length > 0 ? candidate : null;
}

function rateKey(action: string, secret: string): string {
  const digest = createHash('sha256').update(secret).digest('hex').slice(0, 32);
  return `compliance:${action}:${digest}`;
}

export interface ComplianceAuthResult {
  ok: boolean;
}

/**
 * Returns true when the request passes the shared-secret check AND the
 * per-secret rate limit. Sends the appropriate 401/429 response and
 * returns false otherwise — callers should early-return in that case.
 * Async since the limiter may consult Postgres (serverless deployments).
 */
export async function guardComplianceRequest(
  req: NextApiRequest,
  res: NextApiResponse,
  action: string,
): Promise<boolean> {
  const secret = sharedSecret();
  const supplied = req.headers['x-internal-auth'];
  // Constant-time comparison — a plain `!==` short-circuits and leaks
  // timing information about the shared secret.
  if (!secret || !timingSafeEqualStrings(supplied, secret)) {
    res.status(401).json({ error: 'Invalid internal auth' });
    return false;
  }
  const outcome = await consumeRateLimit({
    key: rateKey(action, secret),
    limit: DEFAULT_LIMIT,
    windowMs: DEFAULT_WINDOW_MS,
  });
  res.setHeader('X-RateLimit-Remaining', String(outcome.remaining));
  if (!outcome.allowed) {
    res.setHeader('Retry-After', String(Math.ceil(outcome.resetMs / 1000)));
    res.status(429).json({
      error: 'Too many compliance requests. Slow down and try again shortly.',
    });
    return false;
  }
  return true;
}
