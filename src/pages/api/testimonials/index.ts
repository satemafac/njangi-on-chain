// /api/testimonials — a member's own stories.
//
//   POST   { circleId, quote, consentMarketing: true }  → 201 { testimonial }
//   GET                                                 → 200 { testimonials }
//   DELETE { id }                                       → 200 (withdraws)
//
// Identity comes only from the server-verified zkLogin session (HttpOnly
// `session-id` cookie), never from the body. The schema is strict: a body
// with any extra field is a 400. consentMarketing must be literally true —
// there is no path to store a story without explicit consent.

import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { getZkLoginSessionAccount } from '../../../lib/zklogin-session-registry';
import {
  createTestimonial,
  listOwnTestimonials,
  QUOTE_MAX_CHARS,
  QUOTE_MIN_CHARS,
  withdrawOwnTestimonial,
} from '../../../lib/testimonials';
import { consumeRateLimit } from '../../../lib/rate-limit';
import { getClientIp } from '../../../lib/client-ip';
import { isPostgresConfigured } from '../../../lib/pg-pool';

const REQUESTS_PER_WINDOW = 10;
const WINDOW_MS = 10 * 60_000;

const createSchema = z
  .object({
    circleId: z.string().regex(/^0x[0-9a-fA-F]{2,64}$/),
    quote: z.string().min(QUOTE_MIN_CHARS).max(QUOTE_MAX_CHARS * 2),
    consentMarketing: z.literal(true),
  })
  .strict();

const withdrawSchema = z.object({ id: z.number().int().positive() }).strict();

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!['POST', 'GET', 'DELETE'].includes(req.method ?? '')) {
    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }
  if (!isPostgresConfigured()) {
    return res.status(503).json({ success: false, error: 'STORE_UNAVAILABLE' });
  }

  const rateOutcome = await consumeRateLimit({
    key: `testimonials:${getClientIp(req)}`,
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
  const userAddress = sessionAccount.userAddr;

  try {
    if (req.method === 'GET') {
      const testimonials = await listOwnTestimonials(userAddress);
      return res.status(200).json({ success: true, testimonials });
    }

    if (req.method === 'DELETE') {
      const parsed = withdrawSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: 'INVALID_PAYLOAD' });
      }
      const withdrawn = await withdrawOwnTestimonial(parsed.data.id, userAddress);
      return res.status(withdrawn ? 200 : 404).json({ success: withdrawn });
    }

    const parsed = createSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: 'INVALID_PAYLOAD',
        message:
          'Send { circleId, quote, consentMarketing: true } only. A story is ' +
          'stored only with your explicit consent.',
      });
    }
    const testimonial = await createTestimonial({
      userAddress,
      circleId: parsed.data.circleId,
      quote: parsed.data.quote,
      consentMarketing: parsed.data.consentMarketing,
    });
    return res.status(201).json({ success: true, testimonial });
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    if (code === 'QUOTE_LENGTH') {
      return res.status(400).json({
        success: false,
        error: 'QUOTE_LENGTH',
        message: `Your story should be between ${QUOTE_MIN_CHARS} and ${QUOTE_MAX_CHARS} characters.`,
      });
    }
    console.error('[api/testimonials] failed', error);
    return res.status(500).json({ success: false, error: 'TESTIMONIAL_FAILED' });
  }
}
