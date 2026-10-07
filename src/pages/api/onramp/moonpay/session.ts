/**
 * POST /api/onramp/moonpay/session
 *
 * Returns a signed MoonPay widget URL the client can launch in a popup or
 * iframe. We never expose MOONPAY_SECRET_KEY to the browser; the client
 * always asks the server to mint the URL.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import {
  createMoonPaySession,
  type CreateMoonPaySessionInput,
  type MoonPayAssetIntent,
  type MoonPayBaseCurrency,
} from '../../../../services/moonpay-service';
import { isSanctionedCountry } from '../../../../lib/ramp-geo';
import { screenRampWallet } from '@/lib/ramp-wallet-screen';
import {
  getDriftStatusForAddress,
  addressDriftErrorBody,
} from '@/lib/zklogin-address-bindings';

interface RequestBody {
  walletAddress?: string;
  preferredAssetIntent?: MoonPayAssetIntent;
  baseCurrency?: MoonPayBaseCurrency;
  baseCurrencyAmount?: number;
  email?: string;
  externalCustomerId?: string;
  redirectURL?: string;
  failureRedirectURL?: string;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const enabled = (process.env.NEXT_PUBLIC_MOONPAY_ENABLED || 'false').toLowerCase() === 'true';
  if (!enabled) {
    return res.status(503).json({
      provider: 'moonpay',
      error: 'MOONPAY_DISABLED',
      message: 'MoonPay onramp is not enabled in this environment.',
    });
  }

  const body = (req.body || {}) as RequestBody;
  // A non-string walletAddress is "missing" here: the wallet screen below
  // normalizes the string and must never be handed something else.
  if (
    typeof body.walletAddress !== 'string' ||
    !body.walletAddress.trim() ||
    !body.preferredAssetIntent
  ) {
    return res.status(400).json({
      provider: 'moonpay',
      error: 'INVALID_REQUEST',
      message: 'walletAddress and preferredAssetIntent are required.',
    });
  }

  // Sanctions screen on the edge-detected IP country — and, for UA, the
  // region header, which is what makes the embargoed Ukrainian regions
  // matchable (embargo.ts). Refuse to mint ramp sessions for blocked
  // jurisdictions (coordinator-level block, ahead of the provider's own KYC).
  const ipCountry = (req.headers['x-vercel-ip-country'] as string | undefined)
    ?.trim()
    .toUpperCase();
  const ipRegion = (req.headers['x-vercel-ip-country-region'] as string | undefined)
    ?.trim()
    .toUpperCase();
  if (isSanctionedCountry(ipCountry, ipRegion)) {
    return res.status(403).json({
      provider: 'moonpay',
      error: 'BLOCKED_REGION',
      message: 'This service is not available in your region.',
    });
  }

  // Screen the DESTINATION WALLET, not just the country: a listed address
  // funding itself from a permitted jurisdiction is the case geo-blocking
  // misses. Fail CLOSED — a ramp session is a new commitment. Same
  // status/code/message as the Coinbase and Transak routes
  // (src/lib/ramp-wallet-screen.ts). Nothing is signed before this point.
  const walletScreen = await screenRampWallet(body.walletAddress);
  if (walletScreen.refused) {
    console.warn(`[moonpay/session] wallet screen refused (${walletScreen.reason})`);
    return res.status(walletScreen.status).json({
      provider: 'moonpay',
      error: walletScreen.error,
      message: walletScreen.message,
    });
  }

  // Address-drift gate: pause funding for either side of a drifted
  // identity (new address = commitment the buyer may not understand; old
  // address = unreachable). Fail-open on lookup errors — see
  // src/lib/zklogin-address-bindings.ts.
  const driftScreen = await getDriftStatusForAddress(body.walletAddress);
  if (driftScreen.drifted) {
    return res.status(409).json({
      provider: 'moonpay',
      ...addressDriftErrorBody(driftScreen.previousAddresses),
    });
  }

  try {
    const input: CreateMoonPaySessionInput = {
      walletAddress: body.walletAddress,
      preferredAssetIntent: body.preferredAssetIntent,
      baseCurrency: body.baseCurrency,
      baseCurrencyAmount: body.baseCurrencyAmount,
      email: body.email,
      externalCustomerId: body.externalCustomerId,
      redirectURL: body.redirectURL,
      failureRedirectURL: body.failureRedirectURL,
    };
    const session = createMoonPaySession(input);
    return res.status(200).json(session);
  } catch (error) {
    console.error('[moonpay/session] failed to mint URL', error);
    return res.status(500).json({
      provider: 'moonpay',
      error: 'MOONPAY_SESSION_FAILED',
      message: error instanceof Error ? error.message : 'Failed to create MoonPay session',
    });
  }
}
