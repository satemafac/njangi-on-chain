// moonpay-service.ts — Signed-URL builder for the MoonPay hosted widget.
//
// MoonPay's widget URL must be signed with the partner's secret key when
// any of the optional parameters are set. The signing scheme is documented
// at https://dev.moonpay.com/docs/sign-the-url and uses HMAC-SHA256 over
// the query-string portion of the URL.
//
// Phase 1 ships only the on-ramp launch flow. Webhook ingestion mirrors
// the Coinbase webhook layout and lives in pages/api/onramp/moonpay/webhook.ts.

import { createHmac, timingSafeEqual } from 'crypto';

export type MoonPayBaseCurrency =
  | 'usd'
  | 'eur'
  | 'gbp'
  | 'aud'
  | 'cad'
  | 'xaf'
  | 'ngn'
  | 'kes'
  | 'zar';

export type MoonPayAssetIntent = 'SUI' | 'USDC_ON_SUI';

export interface CreateMoonPaySessionInput {
  walletAddress: string;
  preferredAssetIntent: MoonPayAssetIntent;
  baseCurrency?: MoonPayBaseCurrency;
  baseCurrencyAmount?: number;
  email?: string;
  externalCustomerId?: string;
  redirectURL?: string;
  failureRedirectURL?: string;
}

export interface MoonPaySessionResult {
  provider: 'moonpay';
  url: string;
  assetIntent: MoonPayAssetIntent;
}

const TESTNET_BASE = 'https://buy-sandbox.moonpay.com';
const MAINNET_BASE = 'https://buy.moonpay.com';

function isMainnet(): boolean {
  return (process.env.NEXT_PUBLIC_SUI_NETWORK || 'testnet').toLowerCase() === 'mainnet';
}

function publicKey(): string {
  const key = process.env.NEXT_PUBLIC_MOONPAY_API_KEY;
  if (!key) throw new Error('NEXT_PUBLIC_MOONPAY_API_KEY is not set');
  return key;
}

function secretKey(): string {
  const key = process.env.MOONPAY_SECRET_KEY;
  if (!key) throw new Error('MOONPAY_SECRET_KEY is not set');
  return key;
}

function intentToCurrency(intent: MoonPayAssetIntent): string {
  // MoonPay uses lowercase symbol+chain prefixes; on Sui USDC is `usdc_sui`
  // and SUI itself is the native `sui` symbol.
  return intent === 'SUI' ? 'sui' : 'usdc_sui';
}

export function createMoonPaySession(input: CreateMoonPaySessionInput): MoonPaySessionResult {
  const params = new URLSearchParams();
  params.set('apiKey', publicKey());
  params.set('currencyCode', intentToCurrency(input.preferredAssetIntent));
  params.set('walletAddress', input.walletAddress);
  if (input.baseCurrency) params.set('baseCurrencyCode', input.baseCurrency);
  if (typeof input.baseCurrencyAmount === 'number') {
    params.set('baseCurrencyAmount', String(input.baseCurrencyAmount));
  }
  if (input.email) params.set('email', input.email);
  if (input.externalCustomerId) params.set('externalCustomerId', input.externalCustomerId);
  if (input.redirectURL) params.set('redirectURL', input.redirectURL);
  if (input.failureRedirectURL) params.set('failureRedirectURL', input.failureRedirectURL);

  const queryString = params.toString();
  const baseUrl = `${isMainnet() ? MAINNET_BASE : TESTNET_BASE}/?${queryString}`;

  // MoonPay signature is base64-encoded HMAC-SHA256 of everything after the
  // base URL (including the leading `?`).
  const signature = createHmac('sha256', secretKey())
    .update(`?${queryString}`)
    .digest('base64');

  const url = `${baseUrl}&signature=${encodeURIComponent(signature)}`;

  return {
    provider: 'moonpay',
    url,
    assetIntent: input.preferredAssetIntent,
  };
}

/**
 * Replay-protection window for webhook deliveries. MoonPay's docs suggest
 * validating the header timestamp against the current time; we allow five
 * minutes of skew in either direction and reject anything older — a
 * captured (body, signature) pair therefore cannot be replayed later.
 */
export const MOONPAY_WEBHOOK_REPLAY_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * Verifies a MoonPay webhook signature (`Moonpay-Signature-V2` header).
 *
 * Scheme per MoonPay's request-signing reference
 * (https://dev.moonpay.com/reference/reference-webhooks-signature):
 * the header carries `t=<unix-seconds>,s=<hex hmac>` and the signed payload
 * is the timestamp, a `.` separator, then the exact raw request body —
 * HMAC-SHA256 with the webhook key, hex-encoded. The previous
 * implementation HMAC'd the raw body alone (omitting the timestamp prefix),
 * which does not match the documented scheme and provided no replay
 * protection; the 2026-06 GTM audit flagged both.
 */
export function verifyMoonPayWebhookSignature(
  rawBody: string,
  signature: string | null,
  nowMs: number = Date.now(),
): boolean {
  if (!signature) return false;
  const webhookKey = process.env.MOONPAY_WEBHOOK_KEY;
  if (!webhookKey) throw new Error('MOONPAY_WEBHOOK_KEY is not set');

  const parts = signature.split(',').reduce<Record<string, string>>((acc, part) => {
    const [k, v] = part.split('=');
    if (k && v) acc[k.trim()] = v.trim();
    return acc;
  }, {});
  const timestamp = parts.t;
  const provided = parts.s;
  if (!timestamp || !provided) return false;

  // Reject stale (or far-future) deliveries before any HMAC work. MoonPay
  // documents seconds-since-epoch; tolerate milliseconds defensively.
  const timestampNumber = Number(timestamp);
  if (!Number.isFinite(timestampNumber) || timestampNumber <= 0) return false;
  const timestampMs =
    timestampNumber > 1e12 ? timestampNumber : timestampNumber * 1000;
  if (Math.abs(nowMs - timestampMs) > MOONPAY_WEBHOOK_REPLAY_TOLERANCE_MS) {
    return false;
  }

  const expected = createHmac('sha256', webhookKey)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(
    Buffer.from(provided, 'utf8'),
    Buffer.from(expected, 'utf8'),
  );
}
