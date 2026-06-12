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

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const enabled = (process.env.NEXT_PUBLIC_TRANSAK_ENABLED || 'false').toLowerCase() === 'true';
  if (!enabled) {
    return res.status(503).json({
      provider: 'transak',
      error: 'TRANSAK_DISABLED',
      message: 'Transak onramp is not enabled in this environment.',
    });
  }

  const body = (req.body || {}) as RequestBody;
  if (!body.walletAddress || !body.preferredAssetIntent) {
    return res.status(400).json({
      provider: 'transak',
      error: 'INVALID_REQUEST',
      message: 'walletAddress and preferredAssetIntent are required.',
    });
  }

  try {
    const input: CreateTransakSessionInput = {
      walletAddress: body.walletAddress,
      preferredAssetIntent: body.preferredAssetIntent,
      fiatCurrency: body.fiatCurrency,
      fiatAmount: body.fiatAmount,
      countryCode: body.countryCode,
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
