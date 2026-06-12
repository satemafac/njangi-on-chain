/**
 * GET /api/admin/notifications/recent
 *
 * Returns the most recent rows from `whatsapp_notifications` so the
 * compliance console can show ops "did the nudge go out?" without psql.
 *
 * Query: `?address=0x…&limit=50` (limit defaults to 25, capped at 100).
 * Auth: shared `INTERNAL_NOTIFY_SECRET` / `COMPLIANCE_ISSUANCE_SECRET`
 * via `guardComplianceRequest` (Phase 10 limiter included).
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { guardComplianceRequest } from '../../../../lib/compliance-auth';
import { findRecentNotifications } from '../../../../lib/whatsapp-notifier';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!guardComplianceRequest(req, res, 'admin-notifications')) return;

  const address = typeof req.query.address === 'string' ? req.query.address : null;
  if (!address || !address.startsWith('0x')) {
    return res.status(400).json({ error: 'address (0x…) query param required' });
  }
  const rawLimit = Number(req.query.limit ?? 25);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(1, Math.trunc(rawLimit)), 100) : 25;

  try {
    const rows = await findRecentNotifications(address, limit);
    return res.status(200).json({ rows });
  } catch (err) {
    console.error('[admin/notifications/recent] failed', err);
    return res.status(500).json({
      error: err instanceof Error ? err.message : 'Failed to read notifications',
    });
  }
}
