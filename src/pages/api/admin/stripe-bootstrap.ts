// POST /api/admin/stripe-bootstrap — TEMPORARY one-shot billing provisioner.
//
// The Vercel Stripe integration provides STRIPE_SECRET_KEY (sensitive, not
// readable off-platform), but not the product/price/webhook the billing code
// needs. This route runs INSIDE the Vercel runtime where the key is available,
// creates those objects idempotently, and returns the price id + webhook secret
// so the operator can set them as env vars — without the secret key ever
// leaving Vercel.
//
// Gated on a one-time STRIPE_BOOTSTRAP_TOKEN bearer (timing-safe). DELETE this
// route + the token immediately after provisioning — it is not a permanent
// surface.

import type { NextApiRequest, NextApiResponse } from 'next';
import Stripe from 'stripe';
import { timingSafeEqualStrings } from '../../../lib/timing-safe';

const PRICE_LOOKUP_KEY = 'njangi_premium_monthly';
const WEBHOOK_EVENTS: Stripe.WebhookEndpointCreateParams.EnabledEvent[] = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.payment_failed',
];

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const token = process.env.STRIPE_BOOTSTRAP_TOKEN;
  if (!token) return res.status(404).json({ error: 'bootstrap disabled' });
  if (!timingSafeEqualStrings(req.headers.authorization, `Bearer ${token}`)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return res.status(500).json({ error: 'STRIPE_SECRET_KEY not set' });

  const stripe = new Stripe(key);
  const mode = key.startsWith('sk_test_') ? 'test' : key.startsWith('sk_live_') ? 'live' : 'unknown';
  const webhookUrl = `https://${req.headers.host}/api/billing/webhook`;

  try {
    // Idempotent product + $9.99/mo price via lookup_key.
    let priceId;
    const existing = await stripe.prices.list({ lookup_keys: [PRICE_LOOKUP_KEY], limit: 1 });
    if (existing.data.length) {
      priceId = existing.data[0].id;
    } else {
      const product = await stripe.products.create({
        name: 'Njangi Premium',
        description:
          'Bigger circles (up to 20 members, 5 circles), WhatsApp notifications, smart goals, and analytics. Funds always stay self-custodied.',
        metadata: { njangi_plan: 'premium' },
      });
      const price = await stripe.prices.create({
        product: product.id,
        unit_amount: 999,
        currency: 'usd',
        recurring: { interval: 'month' },
        lookup_key: PRICE_LOOKUP_KEY,
        metadata: { njangi_plan: 'premium' },
      });
      priceId = price.id;
    }

    // Idempotent webhook endpoint (secret only returned on creation).
    const eps = await stripe.webhookEndpoints.list({ limit: 100 });
    const match = eps.data.find((w) => w.url === webhookUrl);
    let webhookSecret = null;
    let webhookExisted = false;
    if (match) {
      webhookExisted = true;
    } else {
      const ep = await stripe.webhookEndpoints.create({
        url: webhookUrl,
        enabled_events: WEBHOOK_EVENTS,
        description: 'Njangi billing webhook',
        metadata: { njangi: 'billing' },
      });
      webhookSecret = ep.secret;
    }

    return res.status(200).json({ ok: true, mode, priceId, webhookSecret, webhookExisted, webhookUrl });
  } catch (err) {
    return res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
}
