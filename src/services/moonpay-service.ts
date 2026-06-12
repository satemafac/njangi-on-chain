// moonpay-service.ts — Signed-URL builder for the MoonPay hosted widget.
//
// MoonPay's widget URL must be signed with the partner's secret key when
// any of the optional parameters are set. The signing scheme is documented
// at https://dev.moonpay.com/docs/sign-the-url and uses HMAC-SHA256 over
// the query-string portion of the URL.
//
// Phase 1 ships only the on-ramp launch flow. Webhook ingestion mirrors
// the Coinbase webhook layout and lives in pages/api/onramp/moonpay/webhook.ts.

import { createHmac } from 'crypto';

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
 * Verifies a MoonPay webhook signature. MoonPay signs the raw request body
 * with HMAC-SHA256 and the configured webhook key, exposing the signature
 * in the `Moonpay-Signature-V2` header.
 */
export function verifyMoonPayWebhookSignature(rawBody: string, signature: string | null): boolean {
  if (!signature) return false;
  const webhookKey = process.env.MOONPAY_WEBHOOK_KEY;
  if (!webhookKey) throw new Error('MOONPAY_WEBHOOK_KEY is not set');
  const expected = createHmac('sha256', webhookKey).update(rawBody).digest('hex');
  // MoonPay sends signature as `t=<ts>,s=<hmac>`; split and compare in
  // constant time for the s component.
  const parts = signature.split(',').reduce<Record<string, string>>((acc, part) => {
    const [k, v] = part.split('=');
    if (k && v) acc[k.trim()] = v.trim();
    return acc;
  }, {});
  const provided = parts.s ?? signature;
  if (provided.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < provided.length; i += 1) {
    mismatch |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return mismatch === 0;
}
