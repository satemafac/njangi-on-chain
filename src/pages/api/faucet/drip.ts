// POST /api/faucet/drip — testnet-only gas drip for new users.
//
// zkLogin users pay their own gas, and a brand-new account has 0 SUI, so every
// first action (create circle, contribute) fails with "Insufficient gas" and
// the external faucet (captcha + rate limits) is a hard drop-off. This drips a
// small amount of TESTNET SUI to the *session's own* address from the public
// Sui testnet faucet so onboarding can proceed in-app.
//
// Guards:
//   * Testnet ONLY. On mainnet it 404s — there is no free mainnet gas, and this
//     route MUST stay dead at the mainnet cutover (gated on the active network,
//     so the cutover disables it automatically).
//   * Drips to the verified zkLogin session address only (never a body-supplied
//     address), so it can't be used to farm the faucet for arbitrary wallets.
//   * Rate-limited per address and per IP.

import type { NextApiRequest, NextApiResponse } from 'next';
import { getZkLoginSessionAccount } from '../../../lib/zklogin-session-registry';
import { consumeRateLimit } from '../../../lib/rate-limit';
import { getClientIp } from '../../../lib/client-ip';
import { getCurrentNetwork } from '../../../services/network-config';
import { createHash } from 'node:crypto';
import { appLogger } from '../../../utils/logger';

const FAUCET_URL =
  process.env.SUI_TESTNET_FAUCET_URL || 'https://faucet.testnet.sui.io/v2/gas';

function keyFor(parts: string[]): string {
  return createHash('sha256').update(parts.join(':')).digest('hex');
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  // Testnet only — fail closed on any other network (incl. the mainnet cutover).
  if (getCurrentNetwork() !== 'testnet') {
    return res.status(404).json({ success: false, error: 'Faucet is testnet-only' });
  }

  // Verified session address only — never trust a body-supplied address.
  const account = await getZkLoginSessionAccount(req.cookies?.['session-id']);
  if (!account?.userAddr) {
    return res.status(401).json({
      success: false,
      error: 'Sign in to request test SUI.',
    });
  }
  const address = account.userAddr;

  // Rate limit: 1 drip per address per 12h, and a coarser per-IP cap to blunt
  // multi-account abuse from one machine.
  const perAddress = await consumeRateLimit({
    key: keyFor(['faucet', 'addr', address]),
    limit: 1,
    windowMs: 12 * 60 * 60 * 1000,
  });
  if (!perAddress.allowed) {
    return res.status(429).json({
      success: false,
      error: 'You already received test SUI recently. Try again later or use faucet.sui.io.',
      resetMs: perAddress.resetMs,
    });
  }
  const perIp = await consumeRateLimit({
    key: keyFor(['faucet', 'ip', getClientIp(req)]),
    limit: 5,
    windowMs: 12 * 60 * 60 * 1000,
  });
  if (!perIp.allowed) {
    return res.status(429).json({
      success: false,
      error: 'Too many faucet requests from this network. Try again later.',
      resetMs: perIp.resetMs,
    });
  }

  try {
    const r = await fetch(FAUCET_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ FixedAmountRequest: { recipient: address } }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      appLogger.warn('[faucet] upstream non-200', { status: r.status, address });
      // 429 from the public faucet → surface as retryable.
      const status = r.status === 429 ? 429 : 502;
      return res.status(status).json({
        success: false,
        error:
          r.status === 429
            ? 'The public testnet faucet is rate-limiting right now. Try again shortly.'
            : 'Could not reach the testnet faucet. Try faucet.sui.io directly.',
        detail: body.slice(0, 200),
      });
    }
    appLogger.info('[faucet] dripped testnet SUI', { address });
    return res.status(200).json({ success: true, address });
  } catch (err) {
    appLogger.warn('[faucet] request failed', {
      address,
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(502).json({
      success: false,
      error: 'Could not reach the testnet faucet. Try faucet.sui.io directly.',
    });
  }
}
