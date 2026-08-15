// /api/sponsor/execute — submits a client-signed sponsored transaction.
//
// The signature arrives from the browser; this route only relays it to Enoki
// along with the digest from prepare. `executeSponsoredTransaction` is inert
// without a valid user signature, and this server cannot produce one — which
// is the property the whole sponsored path exists to preserve.
//
// Usage is attributed from the reservation written at prepare time, never from
// the request body: the caller supplies only a digest and a signature.

import type { NextApiRequest, NextApiResponse } from 'next';
import { EnokiClient } from '@mysten/enoki';
import { getZkLoginSessionAccount } from '@/lib/zklogin-session-registry';
import { claimPendingSponsorship, recordSponsoredUsage } from '@/lib/gas-sponsorship';
import { getCurrentNetwork, getNetworkConfig } from '@/services/network-config';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { digest, signature } = (req.body ?? {}) as { digest?: string; signature?: string };
  if (typeof digest !== 'string' || !digest || typeof signature !== 'string' || !signature) {
    return res.status(400).json({ error: 'digest and signature are required' });
  }

  const sessionId = req.cookies['session-id'];
  const account = sessionId ? await getZkLoginSessionAccount(sessionId) : null;
  if (!account) {
    return res.status(401).json({ error: 'No active session', requireRelogin: true });
  }

  try {
    // Claiming is single-use and expiry-checked, so a digest cannot be
    // replayed and an abandoned reservation stops counting on its own.
    const pending = await claimPendingSponsorship(digest);
    if (!pending) {
      return res.status(409).json({
        error: 'This sponsorship request has expired or was already used. Please retry.',
        code: 'SPONSORSHIP_NOT_PENDING',
      });
    }

    // The reservation belongs to whoever passed the policy check. A different
    // session presenting the same digest must not be able to spend it.
    if (pending.sub !== account.sub) {
      console.error('[sponsor/execute] session/reservation mismatch — refusing');
      return res.status(403).json({ error: 'Sponsorship does not belong to this session' });
    }

    const networkConfig = getNetworkConfig(getCurrentNetwork());
    const apiKey = networkConfig.enoki?.apiKey;
    if (!apiKey) {
      return res.status(503).json({ error: 'Sponsorship is not configured' });
    }

    const enoki = new EnokiClient({ apiKey });
    const result = await enoki.executeSponsoredTransaction({ digest, signature });

    await recordSponsoredUsage({
      sub: pending.sub,
      userAddress: pending.userAddress,
      circleId: pending.circleId,
      action: pending.action,
      digest: result.digest,
    });

    // The client waits for effects itself — it owns the result, and holding a
    // serverless request open for on-chain finality just burns execution time.
    return res.status(200).json({ digest: result.digest, sponsored: true });
  } catch (err) {
    console.error('[sponsor/execute] submission failed:', err);
    return res.status(502).json({
      error: err instanceof Error ? err.message : 'Sponsored submission failed',
      code: 'SPONSOR_EXECUTE_FAILED',
    });
  }
}
