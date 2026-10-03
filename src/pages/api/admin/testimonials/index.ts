/**
 * GET   /api/admin/testimonials?status=pending|approved|used|withdrawn
 * PATCH /api/admin/testimonials  { id, status }
 *
 * The operator's review queue for member stories. A story becomes usable in
 * marketing only when a human sets it to 'approved' here; 'used' records
 * that it went out; 'withdrawn' honours a member's request and removes it
 * from every list.
 *
 * Auth: shared `COMPLIANCE_ISSUANCE_SECRET` via `guardComplianceRequest`
 * (same operator secret as the compliance console; there is no admin role).
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { guardComplianceRequest } from '../../../../lib/compliance-auth';
import {
  listTestimonials,
  setTestimonialStatus,
  TESTIMONIAL_STATUSES,
} from '../../../../lib/testimonials';

const patchSchema = z
  .object({
    id: z.number().int().positive(),
    status: z.enum(TESTIMONIAL_STATUSES),
  })
  .strict();

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!(await guardComplianceRequest(req, res, 'testimonials-review'))) return;

  try {
    if (req.method === 'GET') {
      const raw = typeof req.query.status === 'string' ? req.query.status : 'pending';
      const status = (TESTIMONIAL_STATUSES as readonly string[]).includes(raw)
        ? (raw as (typeof TESTIMONIAL_STATUSES)[number])
        : 'pending';
      const testimonials = await listTestimonials(status);
      return res.status(200).json({ testimonials });
    }
    if (req.method === 'PATCH') {
      const parsed = patchSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ error: 'Send { id, status } only.' });
      }
      const updated = await setTestimonialStatus(parsed.data.id, parsed.data.status);
      if (!updated) return res.status(404).json({ error: 'Not found' });
      return res.status(200).json({ testimonial: updated });
    }
    res.setHeader('Allow', 'GET, PATCH');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('[api/admin/testimonials] failed', error);
    return res.status(500).json({ error: 'Review queue unavailable' });
  }
}
