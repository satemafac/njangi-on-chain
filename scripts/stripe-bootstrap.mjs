#!/usr/bin/env node
// stripe-bootstrap.mjs — one-shot, idempotent provisioning of the Stripe
// objects the billing code needs, pushing the results straight to Vercel so
// the webhook signing secret never has to be copy-pasted anywhere.
//
// Creates / reuses:
//   1. Product "Njangi Premium" + a $9.99/mo recurring USD price
//      (idempotent via lookup_key `njangi_premium_monthly`).
//   2. A webhook endpoint at the billing URL subscribed to the four events
//      stripe-service.ts handles. The signing secret is only returned by
//      Stripe on creation, so this is create-once (re-runs reuse it).
//
// Then sets STRIPE_PRICE_ID_PREMIUM + STRIPE_WEBHOOK_SECRET on the Vercel
// project (production + preview) via the Vercel REST API. It does NOT flip
// NEXT_PUBLIC_BILLING_ENABLED — that stays a deliberate, verified step.
//
// Usage (from repo root, with the Vercel CLI already logged in):
//   STRIPE_SECRET_KEY=sk_test_xxx node scripts/stripe-bootstrap.mjs
//   # optional: BILLING_WEBHOOK_URL=https://your-domain/api/billing/webhook
//   # optional: ALLOW_LIVE=1  (required if the key is sk_live_)
//
// Safe to re-run: existing product/price/webhook are reused, not duplicated.

import Stripe from 'stripe';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const PRICE_LOOKUP_KEY = 'njangi_premium_monthly';
const PRICE_UNIT_AMOUNT = 999; // $9.99 in cents
const PRICE_CURRENCY = 'usd';
const WEBHOOK_EVENTS = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.payment_failed',
];
const DEFAULT_WEBHOOK_URL =
  process.env.BILLING_WEBHOOK_URL ||
  'https://njangi-on-chain.vercel.app/api/billing/webhook';

function die(msg) {
  console.error(`[stripe-bootstrap] ${msg}`);
  process.exit(1);
}

const KEY = process.env.STRIPE_SECRET_KEY;
if (!KEY) die('STRIPE_SECRET_KEY is required in the environment.');
if (KEY.startsWith('sk_live_') && process.env.ALLOW_LIVE !== '1') {
  die('Refusing a LIVE key without ALLOW_LIVE=1. Use a sk_test_ key for sandbox.');
}
const MODE = KEY.startsWith('sk_test_') ? 'TEST/sandbox' : 'LIVE';
const stripe = new Stripe(KEY);

async function ensureProductAndPrice() {
  // Idempotent on the price lookup_key.
  const existing = await stripe.prices.list({
    lookup_keys: [PRICE_LOOKUP_KEY],
    expand: ['data.product'],
    limit: 1,
  });
  if (existing.data.length) {
    const p = existing.data[0];
    console.log(`[stripe-bootstrap] reusing price ${p.id} ($${(p.unit_amount / 100).toFixed(2)}/${p.recurring?.interval})`);
    return p.id;
  }
  const product = await stripe.products.create({
    name: 'Njangi Premium',
    description:
      'Bigger circles (up to 20 members, 5 circles), WhatsApp notifications, smart goals, and analytics. Funds always stay self-custodied.',
    metadata: { njangi_plan: 'premium' },
  });
  const price = await stripe.prices.create({
    product: product.id,
    unit_amount: PRICE_UNIT_AMOUNT,
    currency: PRICE_CURRENCY,
    recurring: { interval: 'month' },
    lookup_key: PRICE_LOOKUP_KEY,
    metadata: { njangi_plan: 'premium' },
  });
  console.log(`[stripe-bootstrap] created product ${product.id} + price ${price.id}`);
  return price.id;
}

async function ensureWebhook(url) {
  const list = await stripe.webhookEndpoints.list({ limit: 100 });
  const match = list.data.find((w) => w.url === url);
  if (match) {
    console.log(`[stripe-bootstrap] webhook endpoint already exists for ${url} (${match.id}).`);
    console.log('[stripe-bootstrap] Stripe only returns the signing secret on creation.');
    console.log('[stripe-bootstrap] If STRIPE_WEBHOOK_SECRET is not yet set on Vercel, delete this endpoint in the Stripe dashboard and re-run, or roll its secret.');
    return { id: match.id, secret: null };
  }
  const ep = await stripe.webhookEndpoints.create({
    url,
    enabled_events: WEBHOOK_EVENTS,
    description: 'Njangi billing webhook',
    metadata: { njangi: 'billing' },
  });
  console.log(`[stripe-bootstrap] created webhook endpoint ${ep.id} → ${url}`);
  return { id: ep.id, secret: ep.secret };
}

// --- Vercel env push (REST API; reads the CLI's own auth + linked project) ---
function vercelAuth() {
  const tokenPath = path.join(
    os.homedir(),
    'Library/Application Support/com.vercel.cli/auth.json',
  );
  const projPath = path.join(process.cwd(), '.vercel', 'project.json');
  if (!fs.existsSync(tokenPath)) return null;
  if (!fs.existsSync(projPath)) return null;
  const token = JSON.parse(fs.readFileSync(tokenPath, 'utf8')).token;
  const { projectId, orgId } = JSON.parse(fs.readFileSync(projPath, 'utf8'));
  if (!token || !projectId) return null;
  return { token, projectId, orgId };
}

async function setVercelEnv(auth, key, value, { sensitive = false } = {}) {
  const url = `https://api.vercel.com/v10/projects/${auth.projectId}/env?upsert=true${auth.orgId ? `&teamId=${auth.orgId}` : ''}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${auth.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      key,
      value,
      type: sensitive ? 'sensitive' : 'encrypted',
      target: ['production', 'preview'],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Vercel env ${key} → HTTP ${res.status}: ${body}`);
  }
  console.log(`[stripe-bootstrap] Vercel env set: ${key} ✓`);
}

async function main() {
  console.log(`[stripe-bootstrap] mode: ${MODE}`);
  const priceId = await ensureProductAndPrice();
  const wh = await ensureWebhook(DEFAULT_WEBHOOK_URL);

  const auth = vercelAuth();
  if (!auth) {
    console.log('\n[stripe-bootstrap] Vercel CLI auth/project not found — printing values to set manually:');
    console.log(`  STRIPE_PRICE_ID_PREMIUM=${priceId}`);
    if (wh.secret) console.log(`  STRIPE_WEBHOOK_SECRET=${wh.secret}`);
    console.log('  NEXT_PUBLIC_BILLING_ENABLED=true   (flip when ready to verify)');
    return;
  }

  await setVercelEnv(auth, 'STRIPE_PRICE_ID_PREMIUM', priceId);
  if (wh.secret) {
    await setVercelEnv(auth, 'STRIPE_WEBHOOK_SECRET', wh.secret, { sensitive: true });
  } else {
    console.log('[stripe-bootstrap] NOTE: webhook secret not set (endpoint already existed). Ensure STRIPE_WEBHOOK_SECRET is present on Vercel.');
  }
  console.log('\n[stripe-bootstrap] Done. Stripe objects provisioned and pushed to Vercel.');
  console.log('[stripe-bootstrap] Next: flip NEXT_PUBLIC_BILLING_ENABLED=true, redeploy, and verify the checkout round-trip.');
}

main().catch((e) => die(e instanceof Error ? e.message : String(e)));
