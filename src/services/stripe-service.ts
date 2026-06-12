// stripe-service.ts — Stripe subscription billing (server-only).
//
// Premium is a flat SaaS subscription for coordination conveniences
// (WhatsApp suite, larger/more circles, smart goals, analytics). It NEVER
// gates contribute/claim/payout/recovery — charging to access escrowed
// funds would undermine the non-custodial posture (see the GTM readiness
// review, "Risks"). Everything stays free until the operator flips
// NEXT_PUBLIC_BILLING_ENABLED=true.
//
// Identity model: zkLogin is address-centric with no users table. The
// durable root key is (sub, aud) — the same UNIQUE pair as the `salts`
// table — and the deterministic Sui address derived from it. Stripe
// customers carry all three in metadata ({sub, aud, suiAddress}) so the
// mapping survives even if only Stripe's records remain.
//
// Patterns followed:
//   * Lazy client — importing this module must never crash when
//     STRIPE_SECRET_KEY is unset (mirrors moonpay-service.ts; most
//     deployments run with billing off).
//   * Postgres persistence via the shared pool (src/lib/pg-pool.ts) with
//     lazy table creation + an in-memory dev fallback, mirroring
//     src/lib/zklogin-session-registry.ts. Production without
//     DATABASE_URL fails fast instead of silently losing entitlements.
//   * Webhook idempotency lives in src/lib/webhook-dedupe.ts
//     (provider = 'stripe'); this module only persists subscription state.

import Stripe from 'stripe';
import { getSharedPgPool, isPostgresConfigured } from '../lib/pg-pool';

export type SubscriptionPlan = 'free' | 'premium';

export interface SubscriptionIdentity {
  sub: string;
  aud: string;
  userAddress: string;
}

export interface SubscriptionRecord {
  sub: string;
  aud: string;
  userAddress: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string | null;
  priceId: string | null;
  plan: SubscriptionPlan;
  status: string;
  currentPeriodEnd: string | null; // ISO timestamp
  cancelAtPeriodEnd: boolean;
}

/** Thrown when a required STRIPE_* / billing env var is missing. */
export class StripeBillingConfigError extends Error {
  readonly code = 'STRIPE_BILLING_CONFIG';
  constructor(message: string) {
    super(message);
    this.name = 'StripeBillingConfigError';
  }
}

// ---------------------------------------------------------------------------
// Feature flag + config
// ---------------------------------------------------------------------------

/**
 * Public billing kill switch. While false (the default) every feature is
 * free; checkout refuses to start so no one can be charged for a tier
 * that is not being enforced.
 */
export function isBillingEnabled(): boolean {
  return (process.env.NEXT_PUBLIC_BILLING_ENABLED || 'false').toLowerCase() === 'true';
}

export function isStripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

function requirePremiumPriceId(): string {
  const priceId = process.env.STRIPE_PRICE_ID_PREMIUM;
  if (!priceId) {
    throw new StripeBillingConfigError(
      'STRIPE_PRICE_ID_PREMIUM is not configured; cannot build a checkout session.',
    );
  }
  return priceId;
}

function requireBaseUrl(): string {
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL;
  if (!baseUrl) {
    throw new StripeBillingConfigError(
      'NEXT_PUBLIC_BASE_URL is not configured; cannot build Stripe redirect URLs.',
    );
  }
  return baseUrl.replace(/\/+$/, '');
}

// ---------------------------------------------------------------------------
// Lazy Stripe client
// ---------------------------------------------------------------------------

let cachedClient: Stripe | null = null;
let cachedClientKey: string | null = null;

/**
 * Returns the shared Stripe client, creating it on first use. Throws a
 * typed config error when STRIPE_SECRET_KEY is unset — callers should gate
 * on `isStripeConfigured()` for a friendly 503 instead.
 */
export function getStripeClient(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new StripeBillingConfigError(
      'STRIPE_SECRET_KEY is not configured. Billing endpoints are unavailable until it is set.',
    );
  }
  if (!cachedClient || cachedClientKey !== key) {
    cachedClient = new Stripe(key);
    cachedClientKey = key;
  }
  return cachedClient;
}

/**
 * Verifies a webhook delivery against the EXACT raw bytes Stripe signed
 * (the caller must read the body with `bodyParser: false` — see
 * src/pages/api/onramp/moonpay/webhook.ts for the pattern; the Coinbase
 * JSON.stringify(req.body) reconstruction is NOT safe here).
 */
export function constructStripeWebhookEvent(
  rawBody: string | Buffer,
  signatureHeader: string,
): Stripe.Event {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    throw new StripeBillingConfigError(
      'STRIPE_WEBHOOK_SECRET is not configured; refusing to accept webhook deliveries.',
    );
  }
  return getStripeClient().webhooks.constructEvent(rawBody, signatureHeader, secret);
}

// ---------------------------------------------------------------------------
// Persistence — subscriptions table
// ---------------------------------------------------------------------------

interface SubscriptionRow {
  sub: string;
  aud: string;
  user_address: string;
  stripe_customer_id: string;
  stripe_subscription_id: string | null;
  price_id: string | null;
  plan: string;
  status: string;
  current_period_end: string | Date | null;
  cancel_at_period_end: boolean | null;
}

// Dev fallback (no DATABASE_URL): keyed by `${sub}\u0000${aud}`.
const memoryStore = new Map<string, SubscriptionRow>();

function memoryKey(sub: string, aud: string): string {
  return `${sub}\u0000${aud}`;
}

function durableStoreEnabled(): boolean {
  if (isPostgresConfigured()) {
    return true;
  }
  if (process.env.NODE_ENV === 'production') {
    // Entitlements must be durable: an in-memory subscriptions table on a
    // serverless deployment would randomly "unsubscribe" paying users.
    throw new Error(
      '[stripe-service] DATABASE_URL is required in production; ' +
        'refusing to keep subscription state in per-instance memory.',
    );
  }
  return false;
}

let setupPromise: Promise<void> | null = null;

function ensureTable(): Promise<void> {
  if (!setupPromise) {
    setupPromise = getSharedPgPool()
      .query(
        `CREATE TABLE IF NOT EXISTS subscriptions (
           id SERIAL PRIMARY KEY,
           sub TEXT NOT NULL,
           aud TEXT NOT NULL,
           user_address TEXT NOT NULL,
           stripe_customer_id TEXT NOT NULL UNIQUE,
           stripe_subscription_id TEXT UNIQUE,
           price_id TEXT,
           plan TEXT NOT NULL DEFAULT 'free',
           status TEXT NOT NULL,
           current_period_end TIMESTAMPTZ,
           cancel_at_period_end BOOLEAN DEFAULT FALSE,
           created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           UNIQUE (sub, aud)
         );
         CREATE INDEX IF NOT EXISTS subscriptions_user_address_idx
           ON subscriptions (user_address);
         CREATE INDEX IF NOT EXISTS subscriptions_status_idx
           ON subscriptions (status);`,
      )
      .then(() => undefined)
      .catch((err) => {
        setupPromise = null;
        throw err;
      });
  }
  return setupPromise;
}

function rowToRecord(row: SubscriptionRow): SubscriptionRecord {
  return {
    sub: row.sub,
    aud: row.aud,
    userAddress: row.user_address,
    stripeCustomerId: row.stripe_customer_id,
    stripeSubscriptionId: row.stripe_subscription_id ?? null,
    priceId: row.price_id ?? null,
    plan: row.plan === 'premium' ? 'premium' : 'free',
    status: row.status,
    currentPeriodEnd: row.current_period_end
      ? new Date(row.current_period_end).toISOString()
      : null,
    cancelAtPeriodEnd: Boolean(row.cancel_at_period_end),
  };
}

/**
 * Plan derivation from a Stripe subscription status. `past_due` keeps the
 * premium plan (dunning grace window — features degrade only after Stripe
 * gives up and the subscription transitions to canceled/unpaid).
 */
export function planForStatus(status: string): SubscriptionPlan {
  return status === 'active' || status === 'trialing' || status === 'past_due'
    ? 'premium'
    : 'free';
}

/**
 * Looks up the billing row for a zkLogin identity. Matches on the root
 * (sub, aud) key first, then on the derived address (covers rows written
 * before a provider switch — see the GTM review's identity-fragility note).
 */
export async function getSubscriptionForUser(
  identity: SubscriptionIdentity,
): Promise<SubscriptionRecord | null> {
  if (!durableStoreEnabled()) {
    const direct = memoryStore.get(memoryKey(identity.sub, identity.aud));
    if (direct) return rowToRecord(direct);
    for (const row of memoryStore.values()) {
      if (row.user_address === identity.userAddress) return rowToRecord(row);
    }
    return null;
  }
  await ensureTable();
  const result = await getSharedPgPool().query<SubscriptionRow>(
    `SELECT sub, aud, user_address, stripe_customer_id, stripe_subscription_id,
            price_id, plan, status, current_period_end, cancel_at_period_end
       FROM subscriptions
      WHERE (sub = $1 AND aud = $2) OR user_address = $3
      ORDER BY (sub = $1 AND aud = $2) DESC, updated_at DESC
      LIMIT 1`,
    [identity.sub, identity.aud, identity.userAddress],
  );
  const row = result.rows[0];
  return row ? rowToRecord(row) : null;
}

/**
 * Inserts (or refreshes) the identity ↔ Stripe-customer binding. Called
 * before checkout so the webhook always finds a row to update; new rows
 * start as plan 'free' / status 'incomplete' and never grant entitlement.
 */
export async function upsertSubscriptionIdentity(
  identity: SubscriptionIdentity,
  stripeCustomerId: string,
): Promise<void> {
  if (!durableStoreEnabled()) {
    const key = memoryKey(identity.sub, identity.aud);
    const existing = memoryStore.get(key);
    memoryStore.set(key, {
      sub: identity.sub,
      aud: identity.aud,
      user_address: identity.userAddress,
      stripe_customer_id: stripeCustomerId,
      stripe_subscription_id: existing?.stripe_subscription_id ?? null,
      price_id: existing?.price_id ?? null,
      plan: existing?.plan ?? 'free',
      status: existing?.status ?? 'incomplete',
      current_period_end: existing?.current_period_end ?? null,
      cancel_at_period_end: existing?.cancel_at_period_end ?? false,
    });
    return;
  }
  await ensureTable();
  await getSharedPgPool().query(
    `INSERT INTO subscriptions (sub, aud, user_address, stripe_customer_id, plan, status)
     VALUES ($1, $2, $3, $4, 'free', 'incomplete')
     ON CONFLICT (sub, aud) DO UPDATE SET
       user_address = EXCLUDED.user_address,
       stripe_customer_id = EXCLUDED.stripe_customer_id,
       updated_at = NOW()`,
    [identity.sub, identity.aud, identity.userAddress, stripeCustomerId],
  );
}

export interface SubscriptionStateUpdate {
  stripeCustomerId: string;
  stripeSubscriptionId: string | null;
  priceId: string | null;
  status: string;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  /** Identity from Stripe metadata, used to create the row if missing. */
  identity?: Partial<SubscriptionIdentity>;
}

/**
 * Applies a webhook-derived subscription state to the billing row, keyed
 * by the Stripe customer id. When no row exists (webhook raced ahead of —
 * or outlived — the checkout upsert) it is recreated from the identity
 * metadata; with no identity either, this throws so the webhook returns
 * non-2xx and Stripe redelivers.
 */
export async function applySubscriptionState(
  update: SubscriptionStateUpdate,
): Promise<void> {
  const plan = planForStatus(update.status);

  if (!durableStoreEnabled()) {
    let target: SubscriptionRow | undefined;
    for (const row of memoryStore.values()) {
      if (row.stripe_customer_id === update.stripeCustomerId) {
        target = row;
        break;
      }
    }
    if (!target) {
      const { sub, aud, userAddress } = update.identity ?? {};
      if (!sub || !aud || !userAddress) {
        throw new Error(
          `[stripe-service] No subscription row for customer ${update.stripeCustomerId} and no identity metadata to create one.`,
        );
      }
      target = {
        sub,
        aud,
        user_address: userAddress,
        stripe_customer_id: update.stripeCustomerId,
        stripe_subscription_id: null,
        price_id: null,
        plan: 'free',
        status: 'incomplete',
        current_period_end: null,
        cancel_at_period_end: false,
      };
      memoryStore.set(memoryKey(sub, aud), target);
    }
    target.stripe_subscription_id = update.stripeSubscriptionId;
    target.price_id = update.priceId;
    target.plan = plan;
    target.status = update.status;
    target.current_period_end = update.currentPeriodEnd
      ? update.currentPeriodEnd.toISOString()
      : null;
    target.cancel_at_period_end = update.cancelAtPeriodEnd;
    return;
  }

  await ensureTable();
  const pool = getSharedPgPool();
  const periodEnd = update.currentPeriodEnd ? update.currentPeriodEnd.toISOString() : null;
  const result = await pool.query(
    `UPDATE subscriptions SET
       stripe_subscription_id = $2,
       price_id = $3,
       plan = $4,
       status = $5,
       current_period_end = $6,
       cancel_at_period_end = $7,
       updated_at = NOW()
     WHERE stripe_customer_id = $1`,
    [
      update.stripeCustomerId,
      update.stripeSubscriptionId,
      update.priceId,
      plan,
      update.status,
      periodEnd,
      update.cancelAtPeriodEnd,
    ],
  );
  if ((result.rowCount ?? 0) > 0) {
    return;
  }

  const { sub, aud, userAddress } = update.identity ?? {};
  if (!sub || !aud || !userAddress) {
    throw new Error(
      `[stripe-service] No subscription row for customer ${update.stripeCustomerId} and no identity metadata to create one.`,
    );
  }
  await pool.query(
    `INSERT INTO subscriptions
       (sub, aud, user_address, stripe_customer_id, stripe_subscription_id,
        price_id, plan, status, current_period_end, cancel_at_period_end)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (sub, aud) DO UPDATE SET
       user_address = EXCLUDED.user_address,
       stripe_customer_id = EXCLUDED.stripe_customer_id,
       stripe_subscription_id = EXCLUDED.stripe_subscription_id,
       price_id = EXCLUDED.price_id,
       plan = EXCLUDED.plan,
       status = EXCLUDED.status,
       current_period_end = EXCLUDED.current_period_end,
       cancel_at_period_end = EXCLUDED.cancel_at_period_end,
       updated_at = NOW()`,
    [
      sub,
      aud,
      userAddress,
      update.stripeCustomerId,
      update.stripeSubscriptionId,
      update.priceId,
      plan,
      update.status,
      periodEnd,
      update.cancelAtPeriodEnd,
    ],
  );
}

/**
 * Flags the billing row past_due after a failed invoice payment. The plan
 * stays premium (grace window); a no-op when the customer is unknown —
 * failed invoices for never-provisioned customers must not 500-loop the
 * webhook.
 */
export async function markSubscriptionPastDue(stripeCustomerId: string): Promise<void> {
  if (!durableStoreEnabled()) {
    for (const row of memoryStore.values()) {
      if (row.stripe_customer_id === stripeCustomerId && row.stripe_subscription_id) {
        row.status = 'past_due';
        row.plan = planForStatus('past_due');
      }
    }
    return;
  }
  await ensureTable();
  await getSharedPgPool().query(
    `UPDATE subscriptions SET
       status = 'past_due',
       plan = 'premium',
       updated_at = NOW()
     WHERE stripe_customer_id = $1
       AND stripe_subscription_id IS NOT NULL`,
    [stripeCustomerId],
  );
}

// ---------------------------------------------------------------------------
// Stripe API helpers
// ---------------------------------------------------------------------------

/**
 * Returns the Stripe customer id bound to this zkLogin identity, creating
 * the customer (metadata {sub, aud, suiAddress}) and the local billing row
 * on first use. No PII beyond the identity triple is sent to Stripe —
 * names/emails are collected by Stripe's own hosted surfaces.
 */
export async function findOrCreateStripeCustomer(
  identity: SubscriptionIdentity,
): Promise<string> {
  const existing = await getSubscriptionForUser(identity);
  if (existing?.stripeCustomerId) {
    return existing.stripeCustomerId;
  }
  const customer = await getStripeClient().customers.create({
    metadata: {
      sub: identity.sub,
      aud: identity.aud,
      suiAddress: identity.userAddress,
    },
  });
  await upsertSubscriptionIdentity(identity, customer.id);
  return customer.id;
}

/**
 * Builds a hosted Checkout session for the premium subscription. Card data
 * never touches this app (same partner-hosted philosophy as the fiat
 * ramps). Identity metadata is propagated to the subscription object so
 * later webhook events can recreate the billing row if it is ever lost.
 */
export async function createCheckoutSession(
  identity: SubscriptionIdentity,
  stripeCustomerId: string,
): Promise<Stripe.Checkout.Session> {
  const baseUrl = requireBaseUrl();
  const metadata = {
    sub: identity.sub,
    aud: identity.aud,
    suiAddress: identity.userAddress,
  };
  return getStripeClient().checkout.sessions.create({
    mode: 'subscription',
    customer: stripeCustomerId,
    line_items: [{ price: requirePremiumPriceId(), quantity: 1 }],
    success_url: `${baseUrl}/dashboard?billing=success&checkout_session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/pricing?billing=cancelled`,
    client_reference_id: identity.userAddress,
    metadata,
    subscription_data: { metadata },
    allow_promotion_codes: true,
  });
}

/** Builds a hosted billing-portal session (manage/cancel/update card). */
export async function createBillingPortalSession(
  stripeCustomerId: string,
): Promise<Stripe.BillingPortal.Session> {
  const baseUrl = requireBaseUrl();
  return getStripeClient().billingPortal.sessions.create({
    customer: stripeCustomerId,
    return_url: `${baseUrl}/dashboard`,
  });
}

// ---------------------------------------------------------------------------
// Webhook event → row mapping
// ---------------------------------------------------------------------------

function customerIdFrom(
  customer: string | Stripe.Customer | Stripe.DeletedCustomer | null,
): string | null {
  if (typeof customer === 'string') return customer;
  return customer?.id ?? null;
}

function identityFromMetadata(
  metadata: Stripe.Metadata | null | undefined,
): Partial<SubscriptionIdentity> {
  return {
    sub: metadata?.sub || undefined,
    aud: metadata?.aud || undefined,
    userAddress: metadata?.suiAddress || undefined,
  };
}

/**
 * Extracts the current period end. Older Stripe API versions carried
 * `current_period_end` on the subscription; basil (2025-03-31) and later
 * moved it to the subscription items. Check both.
 */
export function extractCurrentPeriodEnd(
  subscription: Stripe.Subscription,
): Date | null {
  const legacy = (subscription as unknown as { current_period_end?: unknown })
    .current_period_end;
  if (typeof legacy === 'number' && Number.isFinite(legacy)) {
    return new Date(legacy * 1000);
  }
  let max: number | null = null;
  for (const item of subscription.items?.data ?? []) {
    const end = (item as { current_period_end?: unknown }).current_period_end;
    if (typeof end === 'number' && Number.isFinite(end)) {
      max = max === null ? end : Math.max(max, end);
    }
  }
  return max === null ? null : new Date(max * 1000);
}

function stateFromSubscription(
  subscription: Stripe.Subscription,
  statusOverride?: string,
): SubscriptionStateUpdate {
  return {
    stripeCustomerId: customerIdFrom(subscription.customer) ?? '',
    stripeSubscriptionId: subscription.id ?? null,
    priceId: subscription.items?.data?.[0]?.price?.id ?? null,
    status: statusOverride ?? subscription.status,
    currentPeriodEnd: extractCurrentPeriodEnd(subscription),
    cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
    identity: identityFromMetadata(subscription.metadata),
  };
}

/**
 * checkout.session.completed — the canonical provisioning event. Retrieves
 * the subscription the session created so the row gets real status/period
 * data instead of assuming 'active'.
 */
export async function recordCheckoutSessionCompleted(
  session: Stripe.Checkout.Session,
): Promise<void> {
  if (session.mode !== 'subscription') {
    return; // not a subscription checkout; nothing to provision
  }
  const customerId = customerIdFrom(session.customer);
  if (!customerId) {
    throw new Error('[stripe-service] checkout.session.completed without a customer id.');
  }
  const sessionIdentity = identityFromMetadata(session.metadata);

  let subscription: Stripe.Subscription | null = null;
  if (typeof session.subscription === 'string') {
    subscription = await getStripeClient().subscriptions.retrieve(session.subscription);
  } else if (session.subscription) {
    subscription = session.subscription;
  }
  if (!subscription) {
    throw new Error(
      `[stripe-service] checkout.session.completed for customer ${customerId} carries no subscription.`,
    );
  }

  const state = stateFromSubscription(subscription);
  state.stripeCustomerId = state.stripeCustomerId || customerId;
  // Session metadata is authoritative for identity (set by our checkout
  // builder); subscription metadata is the fallback copy.
  state.identity = {
    sub: sessionIdentity.sub ?? state.identity?.sub,
    aud: sessionIdentity.aud ?? state.identity?.aud,
    userAddress: sessionIdentity.userAddress ?? state.identity?.userAddress,
  };
  await applySubscriptionState(state);
}

/** customer.subscription.created / customer.subscription.updated. */
export async function recordSubscriptionUpdated(
  subscription: Stripe.Subscription,
): Promise<void> {
  const state = stateFromSubscription(subscription);
  if (!state.stripeCustomerId) {
    throw new Error('[stripe-service] subscription event without a customer id.');
  }
  await applySubscriptionState(state);
}

/** customer.subscription.deleted — drop to the free plan. */
export async function recordSubscriptionDeleted(
  subscription: Stripe.Subscription,
): Promise<void> {
  const state = stateFromSubscription(subscription, 'canceled');
  if (!state.stripeCustomerId) {
    throw new Error('[stripe-service] subscription event without a customer id.');
  }
  await applySubscriptionState(state);
}

/** invoice.payment_failed — start the past_due grace window. */
export async function recordInvoicePaymentFailed(
  invoice: Stripe.Invoice,
): Promise<void> {
  const customerId = customerIdFrom(invoice.customer);
  if (!customerId) {
    return; // nothing to key on; ignore rather than 500-loop the webhook
  }
  await markSubscriptionPastDue(customerId);
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Test helper — clears the lazy client, table latch, and dev store. */
export function __resetStripeServiceForTests(): void {
  cachedClient = null;
  cachedClientKey = null;
  setupPromise = null;
  memoryStore.clear();
}
