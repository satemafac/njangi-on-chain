/**
 * POST /api/compliance/prepare-issuance
 *
 * Server-side helper that computes the policy hash + HMAC of the
 * provider case id without exposing `COMPLIANCE_REF_HMAC_SALT` to the
 * browser. Returns the hashes + the exact PTB argument encoding so the
 * client can sign the `njangi_compliance::issue` transaction with either
 * the legacy server signer or the Phase 2 client-side zkLogin signer.
 *
 * Auth: shared-secret header (`x-internal-auth`) plus an explicit
 * `issuerAddress` field — the route itself doesn't hold the AttestorCap;
 * the signer does. We reject if the caller doesn't know the internal
 * notify/compliance secret so a random browser can't hammer the
 * hashing helper.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import {
  computeExternalRefHash,
  computePolicyHash,
  type AttestationIssuanceInput,
  type PolicyDocument,
} from '../../../services/compliance-attestation-service';
import type { NetworkType } from '../../../services/whatsapp-registry-service';
import { guardComplianceRequest } from '../../../lib/compliance-auth';

interface RequestBody {
  subject?: string;
  providerCaseId?: string;
  ttlMs?: number;
  network?: NetworkType;
  policy?: PolicyDocument;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!guardComplianceRequest(req, res, 'prepare-issuance')) return;

  const body = (req.body || {}) as RequestBody;
  if (!body.subject || !body.providerCaseId || !body.policy || !body.network) {
    return res.status(400).json({
      error: 'subject, providerCaseId, policy, and network are required',
    });
  }
  try {
    const input: AttestationIssuanceInput = {
      subject: body.subject,
      providerCaseId: body.providerCaseId,
      policy: body.policy,
      ttlMs: body.ttlMs,
      network: body.network,
    };
    const policyHash = computePolicyHash(input.policy);
    const externalRefHash = computeExternalRefHash(input.providerCaseId);
    return res.status(200).json({
      subject: input.subject,
      policyHashHex: policyHash.toString('hex'),
      externalRefHashHex: externalRefHash.toString('hex'),
      ttlMs: input.ttlMs ?? 90 * 24 * 60 * 60 * 1000,
    });
  } catch (error) {
    console.error('[compliance/prepare-issuance] failed', error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to prepare issuance',
    });
  }
}
