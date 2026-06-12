/**
 * POST /api/billing/checkout-session
 *
 * Creates a Stripe Checkout session for the premium subscription and
 * returns its hosted URL. Card data never touches this app (same
 * partner-hosted philosophy as the fiat ramps).
 *
 * Auth: the HttpOnly `session-id` cookie issued by /api/zkLogin must
 * resolve to a completed zkLogin session (durable registry — see
 * src/lib/zklogin-session-registry.ts). The verified {sub, aud, userAddr}
 * triple is the billing identity; client-supplied identity is never
 * trusted for anything that grants paid entitlements.
 *
 * The subscriptions row is upserted in 'incomplete' state BEFORE checkout
 * so the webhook always has a row to update, and so a row alone never
 * implies entitlement.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { getZkLoginSessionAccount } from '../../../lib/zklogin-session-registry';
import {
  createCheckoutSession,
  findOrCreateStripeCustomer,
  isBillingEnabled,
  isStripeConfigured,
} from '../../../services/stripe-service';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  // Kill switch: while billing is disabled everything is free, so refusing
  // checkout here guarantees no one pays for a tier that is not enforced.
  if (!isBillingEnabled()) {
    return res.status(409).json({
      success: false,
      error: 'BILLING_DISABLED',
      message: 'Billing is not enabled on this deployment; all features are currently free.',
    });
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

  const identity = {
    sub: sessionAccount.sub,
    aud: sessionAccount.aud,
    userAddress: sessionAccount.userAddr,
  };

  try {
    const customerId = await findOrCreateStripeCustomer(identity);
    const checkout = await createCheckoutSession(identity, customerId);
    if (!checkout.url) {
      throw new Error('Stripe returned a checkout session without a URL.');
    }
    return res.status(200).json({
      success: true,
      data: { url: checkout.url, sessionId: checkout.id },
    });
  } catch (error) {
    console.error('[billing/checkout-session] failed to create checkout session', error);
    return res.status(500).json({
      success: false,
      error: 'CHECKOUT_SESSION_FAILED',
      message: 'Failed to start checkout. Please try again.',
    });
  }
}
