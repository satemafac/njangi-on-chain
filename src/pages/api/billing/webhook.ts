/**
 * POST /api/billing/webhook
 *
 * Receives Stripe subscription lifecycle events. Follows the MoonPay
 * raw-body pattern (`bodyParser: false`) because
 * `stripe.webhooks.constructEvent` must verify the signature over the
 * EXACT raw bytes Stripe signed — the Coinbase JSON.stringify(req.body)
 * reconstruction is not safe here.
 *
 * Idempotency: durable claim via src/lib/webhook-dedupe.ts
 * (provider = 'stripe', keyed by the Stripe event id). The claim is taken
 * BEFORE side effects to suppress concurrent duplicate deliveries, and
 * rolled back on failure so Stripe's retry re-runs the work instead of
 * being swallowed.
 *
 * All side effects are awaited before the 200 — on serverless the
 * instance freezes once the response is sent, so fire-and-forget work may
 * never run while the dedupe row suppresses the retry.
 *
 * Handled events:
 *   checkout.session.completed            → provision subscription row
 *   customer.subscription.created/updated → sync status/period/price
 *   customer.subscription.deleted         → drop to free plan
 *   invoice.payment_failed                → past_due grace window
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import type Stripe from 'stripe';
import { createOnrampRequestLogger } from '../../../lib/onramp-logging';
import { registerWebhookEvent, unregisterWebhookEvent } from '../../../lib/webhook-dedupe';
import {
  constructStripeWebhookEvent,
  recordCheckoutSessionCompleted,
  recordInvoicePaymentFailed,
  recordSubscriptionDeleted,
  recordSubscriptionUpdated,
} from '../../../services/stripe-service';

export const config = {
  api: {
    bodyParser: false,
  },
};

const DEDUPE_PROVIDER = 'stripe';

async function readRawBody(req: NextApiRequest): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function dispatchEvent(event: Stripe.Event): Promise<boolean> {
  switch (event.type) {
    case 'checkout.session.completed':
      await recordCheckoutSessionCompleted(
        event.data.object as Stripe.Checkout.Session,
      );
      return true;
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
      await recordSubscriptionUpdated(event.data.object as Stripe.Subscription);
      return true;
    case 'customer.subscription.deleted':
      await recordSubscriptionDeleted(event.data.object as Stripe.Subscription);
      return true;
    case 'invoice.payment_failed':
      await recordInvoicePaymentFailed(event.data.object as Stripe.Invoice);
      return true;
    default:
      return false; // unhandled event type — acknowledge without side effects
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const logger = createOnrampRequestLogger(req, res, '/api/billing/webhook');

  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let rawBody: Buffer;
  try {
    rawBody = await readRawBody(req);
  } catch (err) {
    logger.error('stripe_webhook_body_read_failed', { error: err });
    return res.status(400).json({ error: 'INVALID_BODY' });
  }

  const signature = req.headers['stripe-signature'];
  if (typeof signature !== 'string' || signature.length === 0) {
    logger.warn('stripe_webhook_missing_signature');
    return res.status(400).json({ error: 'MISSING_SIGNATURE' });
  }

  let event: Stripe.Event;
  try {
    event = constructStripeWebhookEvent(rawBody, signature);
  } catch (err) {
    // Misconfiguration (missing secret) is our fault → 500 so Stripe
    // retries after the operator fixes it; anything else is a bad
    // signature → 400, no retry value.
    if (err instanceof Error && err.name === 'StripeBillingConfigError') {
      logger.error('stripe_webhook_not_configured', { error: err });
      return res.status(500).json({ error: 'WEBHOOK_NOT_CONFIGURED' });
    }
    logger.warn('stripe_webhook_invalid_signature', { error: err });
    return res.status(400).json({ error: 'INVALID_SIGNATURE' });
  }

  // Durable idempotency claim — Stripe retries deliveries for days, and a
  // serverless deployment may see the same event on multiple instances.
  const duplicate = await registerWebhookEvent(DEDUPE_PROVIDER, event.id);
  if (duplicate) {
    logger.info('stripe_webhook_duplicate_delivery', {
      eventId: event.id,
      type: event.type,
    });
    return res.status(200).json({ received: true, duplicate: true });
  }

  try {
    const handled = await dispatchEvent(event);
    logger.info(
      handled ? 'stripe_webhook_processed' : 'stripe_webhook_ignored_event_type',
      { eventId: event.id, type: event.type },
    );
    return res.status(200).json({ received: true });
  } catch (err) {
    logger.error('stripe_webhook_processing_failed', {
      eventId: event.id,
      type: event.type,
      error: err,
    });
    // Release the claim and return non-2xx so Stripe redelivers; the row
    // upserts are idempotent on retry.
    await unregisterWebhookEvent(DEDUPE_PROVIDER, event.id);
    return res.status(500).json({ error: 'WEBHOOK_PROCESSING_FAILED' });
  }
}
