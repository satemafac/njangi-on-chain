/**
 * POST /api/onramp/transak/session
 *
 * Returns a Transak hosted-widget URL the client can launch in a popup or
 * iframe. The URL embeds the public API key only; the partner secret stays
 * server-side and is used by the webhook handler to verify order events.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import {
  createTransakSession,
  isTransakEnabled,
  type CreateTransakSessionInput,
  type TransakAssetIntent,
} from '../../../../services/transak-service';

interface RequestBody {
  walletAddress?: string;
  preferredAssetIntent?: TransakAssetIntent;
  fiatCurrency?: string;
  fiatAmount?: number;
  countryCode?: string;
  email?: string;
  partnerOrderId?: string;
  redirectURL?: string;
}

const SUI_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{1,64}$/;
const FIAT_CURRENCY_PATTERN = /^[A-Za-z]{3}$/;
const COUNTRY_CODE_PATTERN = /^[A-Za-z]{2}$/;

function invalidRequest(res: NextApiResponse, message: string) {
  return res.status(400).json({
    provider: 'transak',
    error: 'INVALID_REQUEST',
    message,
  });
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // isTransakEnabled() requires BOTH the public flag and TRANSAK_API_SECRET:
  // without the partner secret the webhook verifier rejects every order
  // event, so the provider must not be enable-able (fail closed).
  if (!isTransakEnabled()) {
    return res.status(503).json({
      provider: 'transak',
      error: 'TRANSAK_DISABLED',
      message: 'Transak onramp is not enabled in this environment.',
    });
  }

  const body = (req.body || {}) as RequestBody;
  if (!body.walletAddress || !body.preferredAssetIntent) {
    return invalidRequest(
      res,
      'walletAddress and preferredAssetIntent are required.',
    );
  }
  if (
    typeof body.walletAddress !== 'string' ||
    !SUI_ADDRESS_PATTERN.test(body.walletAddress.trim())
  ) {
    return invalidRequest(res, 'walletAddress must be a 0x-prefixed Sui address.');
  }
  if (body.preferredAssetIntent !== 'SUI' && body.preferredAssetIntent !== 'USDC_ON_SUI') {
    return invalidRequest(res, 'preferredAssetIntent must be SUI or USDC_ON_SUI.');
  }
  if (
    body.fiatAmount !== undefined &&
    (typeof body.fiatAmount !== 'number' ||
      !Number.isFinite(body.fiatAmount) ||
      body.fiatAmount <= 0)
  ) {
    return invalidRequest(res, 'fiatAmount must be a positive number.');
  }
  if (
    body.fiatCurrency !== undefined &&
    (typeof body.fiatCurrency !== 'string' ||
      !FIAT_CURRENCY_PATTERN.test(body.fiatCurrency.trim()))
  ) {
    return invalidRequest(res, 'fiatCurrency must be a 3-letter ISO code.');
  }
  if (
    body.countryCode !== undefined &&
    (typeof body.countryCode !== 'string' ||
      !COUNTRY_CODE_PATTERN.test(body.countryCode.trim()))
  ) {
    return invalidRequest(res, 'countryCode must be a 2-letter ISO code.');
  }
  if (body.redirectURL !== undefined) {
    // The redirect lands the buyer back in the app after checkout; never
    // mint partner URLs that bounce through an attacker-chosen origin.
    let redirect: URL | null = null;
    try {
      redirect = new URL(String(body.redirectURL));
    } catch {
      redirect = null;
    }
    const isLocalhost =
      redirect !== null &&
      (redirect.hostname === 'localhost' || redirect.hostname === '127.0.0.1');
    if (
      !redirect ||
      (redirect.protocol !== 'https:' &&
        !(redirect.protocol === 'http:' && isLocalhost))
    ) {
      return invalidRequest(
        res,
        'redirectURL must be an https URL (http allowed for localhost only).',
      );
    }
  }

  try {
    const input: CreateTransakSessionInput = {
      walletAddress: body.walletAddress.trim(),
      preferredAssetIntent: body.preferredAssetIntent,
      fiatCurrency: body.fiatCurrency?.trim().toUpperCase(),
      fiatAmount: body.fiatAmount,
      countryCode: body.countryCode?.trim().toUpperCase(),
      email: body.email,
      partnerOrderId: body.partnerOrderId,
      redirectURL: body.redirectURL,
    };
    const session = createTransakSession(input);
    return res.status(200).json(session);
  } catch (error) {
    console.error('[transak/session] failed to mint URL', error);
    return res.status(500).json({
      provider: 'transak',
      error: 'TRANSAK_SESSION_FAILED',
      message: error instanceof Error ? error.message : 'Failed to create Transak session',
    });
  }
}
