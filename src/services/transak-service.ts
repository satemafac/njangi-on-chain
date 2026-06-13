// transak-service.ts — Hosted-widget URL builder for Transak.
//
// Transak's `global` widget accepts a long set of partner-controlled query
// parameters and is the most XAF/CEMAC-friendly on-ramp option for
// Njangi's Cameroon-focused launch geography. Phase 1 ships URL launching
// only; Phase 2 wires the partner JWT path for richer prefill + hosted
// KYC handoff.

import { createHmac, timingSafeEqual } from 'crypto';

export type TransakAssetIntent = 'SUI' | 'USDC_ON_SUI';

export interface CreateTransakSessionInput {
  walletAddress: string;
  preferredAssetIntent: TransakAssetIntent;
  fiatCurrency?: string;
  fiatAmount?: number;
  countryCode?: string;
  email?: string;
  partnerOrderId?: string;
  redirectURL?: string;
  productsAvailed?: 'BUY' | 'SELL' | 'BUY,SELL';
}

export interface TransakSessionResult {
  provider: 'transak';
  url: string;
  assetIntent: TransakAssetIntent;
}

const STAGING_BASE = 'https://global-stg.transak.com';
const PRODUCTION_BASE = 'https://global.transak.com';

function isMainnet(): boolean {
  return (process.env.NEXT_PUBLIC_SUI_NETWORK || 'testnet').toLowerCase() === 'mainnet';
}

/**
 * Resolves the Transak widget environment. `TRANSAK_ENVIRONMENT`
 * (STAGING | PRODUCTION) wins when set — Transak issues separate partner
 * API keys per environment, so ops must be able to pin the widget host
 * independently of the Sui network (e.g. production rehearsals against
 * Transak STAGING). Without the flag it follows the Sui network: mainnet →
 * production widget, anything else → staging.
 */
export function transakWidgetBaseUrl(): string {
  const flag = (process.env.TRANSAK_ENVIRONMENT || '').trim().toUpperCase();
  if (flag === 'PRODUCTION') return PRODUCTION_BASE;
  if (flag === 'STAGING') return STAGING_BASE;
  if (flag) {
    console.warn(
      `[transak] Unrecognized TRANSAK_ENVIRONMENT="${flag}" — ` +
        'expected STAGING or PRODUCTION; falling back to network default.',
    );
  }
  return isMainnet() ? PRODUCTION_BASE : STAGING_BASE;
}

function publicApiKey(): string {
  const key = process.env.NEXT_PUBLIC_TRANSAK_API_KEY;
  if (!key) throw new Error('NEXT_PUBLIC_TRANSAK_API_KEY is not set');
  return key;
}

function intentToCryptoCurrency(intent: TransakAssetIntent): string {
  return intent === 'SUI' ? 'SUI' : 'USDC';
}

/**
 * Server-side enablement gate for the Transak provider.
 *
 * Transak is only considered enabled when BOTH the public flag is on AND
 * the partner webhook secret is configured. Without TRANSAK_API_SECRET the
 * webhook verifier cannot authenticate order events, so flipping the
 * public flag alone must not light the provider up (2026-06 GTM audit:
 * fail-open hardening). Server-side only — TRANSAK_API_SECRET is never
 * exposed to the browser; client components keep using the public flag and
 * rely on /api/onramp/transak/session enforcing this gate.
 */
export function isTransakEnabled(): boolean {
  const flagged =
    (process.env.NEXT_PUBLIC_TRANSAK_ENABLED || 'false').toLowerCase() === 'true';
  if (!flagged) return false;
  if (!process.env.TRANSAK_API_SECRET) {
    console.error(
      '[transak] NEXT_PUBLIC_TRANSAK_ENABLED=true but TRANSAK_API_SECRET is unset — ' +
        'Transak stays disabled (fail closed). Set the partner secret to enable the provider.',
    );
    return false;
  }
  return true;
}

export function createTransakSession(input: CreateTransakSessionInput): TransakSessionResult {
  const params = new URLSearchParams();
  params.set('apiKey', publicApiKey());
  params.set('network', 'sui');
  params.set('cryptoCurrencyCode', intentToCryptoCurrency(input.preferredAssetIntent));
  params.set('walletAddress', input.walletAddress);
  if (input.fiatCurrency) params.set('fiatCurrency', input.fiatCurrency);
  if (typeof input.fiatAmount === 'number') params.set('fiatAmount', String(input.fiatAmount));
  if (input.countryCode) params.set('countryCode', input.countryCode);
  if (input.email) params.set('email', input.email);
  if (input.partnerOrderId) params.set('partnerOrderId', input.partnerOrderId);
  if (input.redirectURL) params.set('redirectURL', input.redirectURL);
  params.set('productsAvailed', input.productsAvailed ?? 'BUY');
  params.set('disableWalletAddressForm', 'true');

  const url = `${transakWidgetBaseUrl()}/?${params.toString()}`;
  return { provider: 'transak', url, assetIntent: input.preferredAssetIntent };
}

/** Clock skew allowed when honouring a JWT `exp` claim. */
const JWT_EXP_SKEW_MS = 60 * 1000;

/**
 * The verified claims of a Transak webhook JWT.
 *
 * Per Transak's documented webhook format the ENTIRE event payload lives
 * inside the signed JWT: the decoded claims are
 * `{ eventID, createdAt, webhookData }` where `webhookData` carries the
 * order/KYC record (id, status, walletAddress, ...). There are no
 * signature-covered plaintext siblings in the HTTP body — anything outside
 * the JWT is attacker-writable and MUST be ignored by consumers.
 */
export interface TransakWebhookClaims {
  /** Transak event type constant, e.g. `ORDER_COMPLETED`, `KYC_APPROVED`. */
  eventID?: string;
  /** ISO timestamp set by Transak when the event was emitted. */
  createdAt?: string;
  /** The order/KYC payload (id, status, walletAddress, ...). */
  webhookData?: Record<string, unknown>;
  /** Standard JWT expiry. Transak webhook tokens do not normally carry one. */
  exp?: number;
  [claim: string]: unknown;
}

/**
 * Verifies a Transak webhook JWT and returns its DECODED, SIGNATURE-COVERED
 * claims — or `null` when verification fails. Transak signs webhook events
 * (HS256) with the partner API secret and ships the whole payload inside
 * the token, so these claims are the only trustworthy event source
 * (2026-06 GTM audit: the previous handler verified the JWT but then read
 * unsigned plaintext fields, letting any holder of one valid token attach a
 * forged event).
 *
 * FAIL CLOSED: when TRANSAK_API_SECRET is unset every event is rejected —
 * there is no dev-mode bypass. The 2026-06 GTM audit found the previous
 * fail-open path let anyone forge KYC events (queue poisoning + WhatsApp
 * spam) on any deploy that enabled Transak without its secret.
 *
 * Replay hardening: when the token carries an `exp` claim, expired tokens
 * are rejected (with a small skew allowance). Real Transak webhook tokens
 * carry no `exp`, so replay of a captured token is contained downstream:
 * the payload is signature-bound (no field can be altered) and the webhook
 * handler dedupes on the (provider case id, outcome) transition, so a
 * replay is acknowledged without re-running any side effect.
 */
export function decodeTransakWebhook(
  token: string | null,
): TransakWebhookClaims | null {
  if (!token) return null;
  const secret = process.env.TRANSAK_API_SECRET;
  if (!secret) {
    console.error(
      '[transak] TRANSAK_API_SECRET is not set — rejecting webhook (fail closed). ' +
        'Configure the partner secret before enabling Transak.',
    );
    return null;
  }
  // Lightweight HS256 verify so we don't pull in another crypto dep.
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const data = `${parts[0]}.${parts[1]}`;
  const expected = createHmac('sha256', secret).update(data).digest('base64url');
  const provided = parts[2];
  if (expected.length !== provided.length) return null;
  if (
    !timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(provided, 'utf8'))
  ) {
    return null;
  }

  // Signature is valid — decode the claims and honour standard time claims.
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    // A genuine Transak JWT always carries a JSON claims segment; treat
    // anything else as malformed.
    return null;
  }
  if (typeof claims !== 'object' || claims === null || Array.isArray(claims)) {
    return null;
  }
  const decoded = claims as TransakWebhookClaims;
  if (
    typeof decoded.exp === 'number' &&
    decoded.exp * 1000 < Date.now() - JWT_EXP_SKEW_MS
  ) {
    console.warn('[transak] webhook JWT is expired — rejecting');
    return null;
  }

  return decoded;
}

/**
 * Boolean convenience wrapper around {@link decodeTransakWebhook}. Prefer
 * the decoder in handlers: consuming its returned claims is what guarantees
 * the processed payload is the signature-covered one.
 */
export function verifyTransakWebhookJwt(token: string | null): boolean {
  return decodeTransakWebhook(token) !== null;
}
