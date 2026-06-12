/**
 * POST /api/billing/portal-session
 *
 * Creates a Stripe billing-portal session (manage payment method, cancel,
 * download invoices) and returns its hosted URL.
 *
 * Auth: same server-verified zkLogin session primitive as
 * checkout-session.ts. Requires an existing Stripe customer binding —
 * users who never started checkout have nothing to manage.
 *
 * Deliberately NOT gated on NEXT_PUBLIC_BILLING_ENABLED: if billing is
 * ever switched off while subscriptions exist, subscribers must still be
 * able to reach the portal to cancel.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { getZkLoginSessionAccount } from '../../../lib/zklogin-session-registry';
import {
  createBillingPortalSession,
  getSubscriptionForUser,
  isStripeConfigured,
} from '../../../services/stripe-service';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  if (!isStripeConfigured()) {
    return res.status(503).json({
      success: false,
      error: 'STRIPE_NOT_CONFIGURED',
      message: 'Stripe is not configured on this deployment.',
    });
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
    if (!record?.stripeCustomerId) {
      return res.status(404).json({
        success: false,
        error: 'NO_BILLING_ACCOUNT',
        message: 'No billing account found for this user.',
      });
    }
    const portal = await createBillingPortalSession(record.stripeCustomerId);
    return res.status(200).json({ success: true, data: { url: portal.url } });
  } catch (error) {
    console.error('[billing/portal-session] failed to create portal session', error);
    return res.status(500).json({
      success: false,
      error: 'PORTAL_SESSION_FAILED',
      message: 'Failed to open the billing portal. Please try again.',
    });
  }
}
