/**
 * GET /api/billing/status
 *
 * Returns the subscription state for the authenticated session user:
 *   { plan, status, periodEnd, cancelAtPeriodEnd, billingEnabled }
 *
 * Auth: server-verified zkLogin session (HttpOnly `session-id` cookie) —
 * billing state is per-identity and must not be readable for arbitrary
 * client-supplied addresses.
 *
 * Users with no billing row are reported as plan 'free' / status 'none'.
 * `billingEnabled` mirrors NEXT_PUBLIC_BILLING_ENABLED so UI surfaces can
 * hide upsells while the kill switch is off (during which everything is
 * free regardless of plan).
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { getZkLoginSessionAccount } from '../../../lib/zklogin-session-registry';
import {
  getSubscriptionForUser,
  isBillingEnabled,
} from '../../../services/stripe-service';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

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
    const record = await getSubscriptionForUser({
      sub: sessionAccount.sub,
      aud: sessionAccount.aud,
      userAddress: sessionAccount.userAddr,
    });

    return res.status(200).json({
      success: true,
      data: {
        plan: record?.plan ?? 'free',
        status: record?.status ?? 'none',
        periodEnd: record?.currentPeriodEnd ?? null,
        cancelAtPeriodEnd: record?.cancelAtPeriodEnd ?? false,
        billingEnabled: isBillingEnabled(),
      },
    });
  } catch (error) {
    console.error('[billing/status] failed to read subscription state', error);
    return res.status(500).json({
      success: false,
      error: 'STATUS_LOOKUP_FAILED',
      message: 'Failed to read billing status.',
    });
  }
}
