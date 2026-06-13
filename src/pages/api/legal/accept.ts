// POST /api/legal/accept — records versioned legal acceptances for the
// authenticated session user (docs/legal-drafts/ACCEPTANCE-GATE-SPEC.md).
//
// Body: { docs: ('terms'|'privacy'|'risk')[], locale?: 'en'|'fr' } — and
// NOTHING else. The schema is strict on purpose:
//  * versions are resolved server-side from CURRENT_LEGAL_VERSIONS; any body
//    attempting to supply versions (or any other extra field) is a 400;
//  * identity comes exclusively from the server-verified zkLogin session
//    (HttpOnly `session-id` cookie) — never from the body.
//
// The POST must cover every currently-missing doc (all three on first
// signup; only the changed doc(s) after a version bump). Inserts are
// append-only with ON CONFLICT DO NOTHING, so a retried POST is idempotent
// and still succeeds. The client IP is stored only as
// HMAC-SHA256(ip, LEGAL_ACCEPT_IP_SALT).

import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { getZkLoginSessionAccount } from '../../../lib/zklogin-session-registry';
import {
  getLegalAcceptanceStatus,
  hashAcceptanceIp,
  recordLegalAcceptances,
} from '../../../lib/legal-acceptance-server';
import { LEGAL_DOC_IDS } from '../../../lib/legal-acceptance';
import { consumeRateLimit } from '../../../lib/rate-limit';
import { getClientIp } from '../../../lib/client-ip';

// Acceptance is a once-per-version event; throttle hard.
const REQUESTS_PER_WINDOW = 10;
const WINDOW_MS = 10 * 60_000;

const acceptSchema = z
  .object({
    docs: z.array(z.enum(LEGAL_DOC_IDS)).min(1).max(LEGAL_DOC_IDS.length),
    locale: z.enum(['en', 'fr']).default('en'),
  })
  .strict();

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const parsed = acceptSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      error: 'INVALID_PAYLOAD',
      message:
        'Invalid acceptance payload. Send { docs, locale } only — document ' +
        'versions are resolved server-side and must not be supplied.',
    });
  }
  const { docs, locale } = parsed.data;

  const rateOutcome = await consumeRateLimit({
    key: `legal-accept:${getClientIp(req)}`,
    limit: REQUESTS_PER_WINDOW,
    windowMs: WINDOW_MS,
  });
  if (!rateOutcome.allowed) {
    res.setHeader('Retry-After', String(Math.ceil(rateOutcome.resetMs / 1000)));
    return res.status(429).json({ success: false, error: 'Too many requests' });
  }

  // Identity binding: the verified zkLogin session only. Client-supplied
  // identity fields are rejected outright by the strict schema above.
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
    // Partial acceptance is not a thing: the POST must cover every doc whose
    // current version is still outstanding (all three on first signup).
    const status = await getLegalAcceptanceStatus(sessionAccount.sub, sessionAccount.aud);
    const notCovered = status.missing.filter((doc) => !docs.includes(doc));
    if (notCovered.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'INCOMPLETE_ACCEPTANCE',
        message: 'All outstanding documents must be accepted together.',
        missing: status.missing,
      });
    }

    const recorded = await recordLegalAcceptances(
      {
        sub: sessionAccount.sub,
        aud: sessionAccount.aud,
        userAddr: sessionAccount.userAddr,
      },
      docs,
      locale,
      hashAcceptanceIp(getClientIp(req)),
    );

    return res.status(200).json({
      success: true,
      allAccepted: true,
      recorded: recorded.map(({ doc, version }) => ({ doc, version })),
    });
  } catch (error) {
    console.error('[legal/accept] failed to record acceptance', error);
    return res.status(500).json({
      success: false,
      error: 'ACCEPTANCE_WRITE_FAILED',
      message: 'Failed to record acceptance. Please try again.',
    });
  }
}
