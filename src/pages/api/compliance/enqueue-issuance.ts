/**
 * POST /api/compliance/enqueue-issuance
 *
 * Ramp-partner webhooks (or an internal compliance worker) POST here
 * after a KYC decision so the attestor console can one-click the
 * on-chain issuance later.
 *
 * Auth: `x-internal-auth` matching COMPLIANCE_ISSUANCE_SECRET (falls
 * back to INTERNAL_NOTIFY_SECRET) so the queue can't be abused by
 * random browsers.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { enqueueAttestation } from '../../../lib/attestation-queue';
import type { PolicyDocument } from '../../../services/compliance-attestation-service';
import type { NetworkType } from '../../../services/whatsapp-registry-service';
import { guardComplianceRequest } from '../../../lib/compliance-auth';

interface RequestBody {
  subject?: string;
  providerCaseId?: string;
  policy?: PolicyDocument;
  ttlMs?: number;
  network?: NetworkType;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!(await guardComplianceRequest(req, res, 'enqueue-issuance'))) return;

  const body = (req.body || {}) as RequestBody;
  if (!body.subject || !body.providerCaseId || !body.policy || !body.network) {
    return res.status(400).json({
      error: 'subject, providerCaseId, policy, and network are required',
    });
  }

  try {
    const entry = await enqueueAttestation({
      subject: body.subject,
      providerCaseId: body.providerCaseId,
      policy: body.policy,
      ttlMs: body.ttlMs,
      network: body.network,
    });
    // Strip the raw case id from the response; we only need to confirm
    // enqueue to the caller.
    const { providerCaseId: _omit, ...safe } = entry;
    void _omit;
    return res.status(200).json({ entry: safe });
  } catch (err) {
    console.error('[compliance/enqueue-issuance] failed', err);
    return res.status(500).json({
      error: err instanceof Error ? err.message : 'Failed to enqueue attestation',
    });
  }
}
