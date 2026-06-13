// POST /api/legal/data-deletion-request — records a verified-later data
// deletion request in the `deletion_requests` Postgres table (created by
// scripts/migrate-postgres.mjs). Replaces the broken mailto form in the old
// public/data-deletion.html.
//
// Privacy posture matches the rest of the legal surface
// (docs/legal-drafts/ACCEPTANCE-GATE-SPEC.md): the raw client IP is never
// stored — only an HMAC keyed with LEGAL_ACCEPT_IP_SALT, the same salt used
// for legal-acceptance rows. Unauthenticated by design (a user locked out of
// their account must still be able to request deletion), so it is honeypot-
// and rate-limit guarded like /api/mainnet-signup.

import type { NextApiRequest, NextApiResponse } from 'next';
import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { getClientIp } from '../../../lib/client-ip';
import { consumeRateLimit } from '../../../lib/rate-limit';
import { getSharedPgPool, isPostgresConfigured } from '../../../lib/pg-pool';

type ResponseData = {
  success: boolean;
  message?: string;
  alreadyPending?: boolean;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SUI_ADDRESS_RE = /^0x[a-fA-F0-9]{1,64}$/;

// Deletion requests are rare per user; throttle hard.
const REQUESTS_PER_WINDOW = 3;
const WINDOW_MS = 10 * 60_000;

const emptyToUndefined = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const requestSchema = z.object({
  email: z.string().trim().max(254).regex(EMAIL_RE, 'Invalid email'),
  userAddress: z.preprocess(
    emptyToUndefined,
    z.string().trim().regex(SUI_ADDRESS_RE, 'Invalid Sui address format').optional(),
  ),
  details: z.preprocess(emptyToUndefined, z.string().trim().max(1000).optional()),
  locale: z.preprocess(emptyToUndefined, z.enum(['en', 'fr']).optional()),
  // Honeypot — hidden in the UI; real users never fill it.
  website: z.string().optional(),
});

/** HMAC of the client IP; never store the raw IP. Null when the salt is unset. */
function hashIp(ip: string): string | null {
  const salt = process.env.LEGAL_ACCEPT_IP_SALT;
  if (!salt) return null;
  return createHmac('sha256', salt).update(ip).digest('hex');
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<ResponseData>,
) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }

  const parsed = requestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ success: false, message: 'Invalid deletion request payload' });
  }
  const { email, userAddress, details, locale, website } = parsed.data;
  const normalizedEmail = email.toLowerCase();

  // Honeypot tripped — pretend success without touching the database.
  if (website && website.length > 0) {
    return res.status(200).json({ success: true, alreadyPending: false });
  }

  const rateOutcome = await consumeRateLimit({
    key: `legal-deletion:${getClientIp(req)}:${normalizedEmail}`,
    limit: REQUESTS_PER_WINDOW,
    windowMs: WINDOW_MS,
  });
  if (!rateOutcome.allowed) {
    res.setHeader('Retry-After', String(Math.ceil(rateOutcome.resetMs / 1000)));
    return res.status(429).json({
      success: false,
      message: 'Too many requests. Please wait a moment and try again.',
    });
  }

  if (!isPostgresConfigured()) {
    if (process.env.NODE_ENV === 'production') {
      // Never silently drop a legal request in production.
      return res.status(503).json({
        success: false,
        message: 'Deletion requests are temporarily unavailable. Please try again later.',
      });
    }
    // Dev fallback: no DATABASE_URL locally — log instead of recording.
    console.warn(
      `[legal] deletion request (not persisted; DATABASE_URL unset): email=${normalizedEmail}`,
    );
    return res.status(200).json({ success: true, alreadyPending: false });
  }

  try {
    // One pending request per email: the partial unique index
    // deletion_requests_pending_email_idx makes the duplicate POST a no-op.
    const result = await getSharedPgPool().query(
      `INSERT INTO deletion_requests (email, user_address, details, locale, ip_hash)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (email) WHERE status = 'pending' DO NOTHING
       RETURNING id`,
      [normalizedEmail, userAddress ?? null, details ?? null, locale ?? 'en', hashIp(getClientIp(req))],
    );

    const alreadyPending = (result.rowCount ?? 0) === 0;
    console.log(
      `[legal] deletion request recorded: email=${normalizedEmail}, alreadyPending=${alreadyPending}`,
    );
    return res.status(200).json({ success: true, alreadyPending });
  } catch (error) {
    console.error('[legal] failed to record deletion request:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error. Please try again later.',
    });
  }
}
