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
  if (!body.walletAddress || !body.preferredAssetIntent) {
    return res.status(400).json({
      provider: 'moonpay',
      error: 'INVALID_REQUEST',
      message: 'walletAddress and preferredAssetIntent are required.',
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
