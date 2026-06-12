// transak-service.ts — Hosted-widget URL builder for Transak.
//
// Transak's `global` widget accepts a long set of partner-controlled query
// parameters and is the most XAF/CEMAC-friendly on-ramp option for
// Njangi's Cameroon-focused launch geography. Phase 1 ships URL launching
// only; Phase 2 wires the partner JWT path for richer prefill + hosted
// KYC handoff.

import { createHmac } from 'crypto';

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

function publicApiKey(): string {
  const key = process.env.NEXT_PUBLIC_TRANSAK_API_KEY;
  if (!key) throw new Error('NEXT_PUBLIC_TRANSAK_API_KEY is not set');
  return key;
}

function intentToCryptoCurrency(intent: TransakAssetIntent): string {
  return intent === 'SUI' ? 'SUI' : 'USDC';
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

  const url = `${isMainnet() ? PRODUCTION_BASE : STAGING_BASE}/?${params.toString()}`;
  return { provider: 'transak', url, assetIntent: input.preferredAssetIntent };
}

/**
 * Verifies a Transak webhook by checking the JWT in the body. Transak signs
 * order events with the partner secret; the hosted widget docs cover the
 * exact algorithm. Phase 1 returns true when the secret is missing so dev
 * environments can iterate without a partner secret; production deploys
 * MUST configure TRANSAK_API_SECRET.
 */
export function verifyTransakWebhookJwt(token: string | null): boolean {
  if (!token) return false;
  const secret = process.env.TRANSAK_API_SECRET;
  if (!secret) {
    console.warn('[transak] TRANSAK_API_SECRET not set — accepting webhook without verification (dev mode only)');
    return true;
  }
  // Lightweight HS256 verify so we don't pull in another crypto dep.
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const data = `${parts[0]}.${parts[1]}`;
  const expected = createHmac('sha256', secret)
    .update(data)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  if (expected.length !== parts[2].length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i += 1) {
    mismatch |= expected.charCodeAt(i) ^ parts[2].charCodeAt(i);
  }
  return mismatch === 0;
}
