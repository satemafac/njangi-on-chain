/**
 * GET  /api/compliance/queue    → list pending attestations
 * POST /api/compliance/queue    → mark an entry as issued or dismissed
 *
 * Admin-only surface gated by `x-internal-auth`. Returns raw provider
 * case ids so the attestor UI can pre-fill the issuance form with the
 * exact case id the ramp partner sent — the secret acts as the trust
 * boundary here.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import {
  dismissEntry,
  listPendingAttestations,
  markIssued,
} from '../../../lib/attestation-queue';
import { guardComplianceRequest } from '../../../lib/compliance-auth';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const action =
    req.method === 'GET' ? 'queue-list' : req.method === 'POST' ? 'queue-mutate' : 'queue-unknown';
  if (!(await guardComplianceRequest(req, res, action))) return;

  if (req.method === 'GET') {
    const entries = await listPendingAttestations();
    return res.status(200).json({ entries });
  }

  if (req.method === 'POST') {
    const { id, action, digest } = (req.body || {}) as {
      id?: string;
      action?: 'issued' | 'dismissed';
      digest?: string;
    };
    if (!id || !action) {
      return res.status(400).json({ error: 'id and action required' });
    }
    if (action === 'issued') {
      if (!digest) {
        return res.status(400).json({ error: 'digest required when marking issued' });
      }
      const entry = await markIssued(id, digest);
      if (!entry) return res.status(404).json({ error: 'Entry not found' });
      return res.status(200).json({ entry });
    }
    if (action === 'dismissed') {
      const ok = await dismissEntry(id);
      if (!ok) return res.status(404).json({ error: 'Entry not found' });
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ error: 'Unsupported action' });
  }

  res.setHeader('Allow', ['GET', 'POST']);
  return res.status(405).json({ error: 'Method not allowed' });
}
