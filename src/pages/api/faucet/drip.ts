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
//   * Rate-limited per address and per IP — but a slot is spent ONLY when the
//     upstream faucet actually delivered. The public faucet throttles by
//     source IP with a short `retry-after` (seconds), and a serverless egress
//     IP is shared, so a first attempt often meets a 429. Spending the 12h
//     per-address slot before that call (as this route did until 2026-09)
//     turned one throttled attempt into "You already received test SUI" for
//     the rest of the window, with no SUI received. Now: peek both limits,
//     retry the upstream within a small time budget honoring `retry-after`,
//     and consume only after a 200.

import type { NextApiRequest, NextApiResponse } from 'next';
import { getZkLoginSessionAccount } from '../../../lib/zklogin-session-registry';
import { consumeRateLimit, peekRateLimit } from '../../../lib/rate-limit';
import { getClientIp } from '../../../lib/client-ip';
import { getCurrentNetwork } from '../../../services/network-config';
import { createHash } from 'node:crypto';
import { appLogger } from '../../../utils/logger';

const FAUCET_URL =
  process.env.SUI_TESTNET_FAUCET_URL || 'https://faucet.testnet.sui.io/v2/gas';

const ADDRESS_WINDOW_MS = 12 * 60 * 60 * 1000;
const IP_WINDOW_MS = 12 * 60 * 60 * 1000;
/** Per-attempt upstream timeout. */
const UPSTREAM_TIMEOUT_MS = 20_000;
/** Total wall-clock budget for upstream retries inside one request. */
const RETRY_BUDGET_MS = 25_000;
/** Longest single `retry-after` we are willing to honor in-request. */
const MAX_SINGLE_WAIT_MS = 15_000;
const MAX_ATTEMPTS = 3;

function keyFor(parts: string[]): string {
  return createHash('sha256').update(parts.join(':')).digest('hex');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (!Number.isFinite(seconds)) return null;
  return Math.max(0, seconds) * 1000;
}

interface UpstreamOutcome {
  ok: boolean;
  status: number;
  /** Set when the last attempt was a 429 and the upstream told us how long to wait. */
  retryAfterMs: number | null;
  detail: string;
}

/**
 * Calls the public faucet, honoring its `retry-after` for short throttles.
 * Returns the last attempt's outcome; never throws on HTTP errors.
 */
async function requestFromUpstream(address: string): Promise<UpstreamOutcome> {
  const deadline = Date.now() + RETRY_BUDGET_MS;
  let last: UpstreamOutcome = { ok: false, status: 0, retryAfterMs: null, detail: '' };

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const r = await fetch(FAUCET_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ FixedAmountRequest: { recipient: address } }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (r.ok) {
      return { ok: true, status: r.status, retryAfterMs: null, detail: '' };
    }
    const detail = (await r.text().catch(() => '')).slice(0, 200);
    const retryAfterMs = r.status === 429 ? parseRetryAfterMs(r.headers.get('retry-after')) : null;
    last = { ok: false, status: r.status, retryAfterMs, detail };
    appLogger.warn('[faucet] upstream non-200', { status: r.status, attempt, retryAfterMs, address });

    // Only a throttle with a known, short wait is worth retrying in-request.
    if (r.status !== 429 || retryAfterMs === null) break;
    const waitMs = Math.max(retryAfterMs, 250);
    if (waitMs > MAX_SINGLE_WAIT_MS || Date.now() + waitMs > deadline) break;
    await sleep(waitMs);
  }
  return last;
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

  // Rate limits: 1 successful drip per address per 12h, and a coarser per-IP
  // cap to blunt multi-account abuse from one machine. Checked here without
  // spending a slot; spent below only once the upstream delivered.
  const addressLimit = {
    key: keyFor(['faucet', 'addr', address]),
    limit: 1,
    windowMs: ADDRESS_WINDOW_MS,
  };
  const ipLimit = {
    key: keyFor(['faucet', 'ip', getClientIp(req)]),
    limit: 5,
    windowMs: IP_WINDOW_MS,
  };

  const perAddress = await peekRateLimit(addressLimit);
  if (!perAddress.allowed) {
    return res.status(429).json({
      success: false,
      error: 'You already received test SUI recently. Try again later or use faucet.sui.io.',
      resetMs: perAddress.resetMs,
    });
  }
  const perIp = await peekRateLimit(ipLimit);
  if (!perIp.allowed) {
    return res.status(429).json({
      success: false,
      error: 'Too many faucet requests from this network. Try again later.',
      resetMs: perIp.resetMs,
    });
  }

  let outcome: UpstreamOutcome;
  try {
    outcome = await requestFromUpstream(address);
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

  if (!outcome.ok) {
    if (outcome.status === 429) {
      const seconds = outcome.retryAfterMs === null ? null : Math.ceil(outcome.retryAfterMs / 1000);
      return res.status(429).json({
        success: false,
        error:
          seconds === null
            ? 'The public testnet faucet is rate-limiting right now. Try again shortly or use faucet.sui.io.'
            : `The public testnet faucet is busy. Try again in about ${seconds}s, or use faucet.sui.io.`,
        retryAfterMs: outcome.retryAfterMs,
        detail: outcome.detail,
      });
    }
    return res.status(502).json({
      success: false,
      error: 'Could not reach the testnet faucet. Try faucet.sui.io directly.',
      detail: outcome.detail,
    });
  }

  // Delivered — now spend the slots. A concurrent second request could have
  // passed the peek above; the upstream faucet's own per-recipient limit
  // bounds that, and consume() still records it for the next window check.
  await Promise.all([consumeRateLimit(addressLimit), consumeRateLimit(ipLimit)]);
  appLogger.info('[faucet] dripped testnet SUI', { address });
  return res.status(200).json({ success: true, address });
}
