// /api/sponsor/prepare — server half of the sponsored-transaction protocol.
//
// Takes a gas-less transaction kind built in the user's browser, applies the
// sponsorship policy, and asks Enoki to attach a sponsor-funded gas coin. It
// returns bytes for the CLIENT to sign. It never signs anything itself, and
// after the Phase 1 key relocation it holds no key that could.
//
// The caller is resolved from the session cookie only. Nothing in the request
// body identifies the user — otherwise sponsorship could be billed to, and
// attributed to, someone else's quota by simply claiming their address.

import type { NextApiRequest, NextApiResponse } from 'next';
import { EnokiClient } from '@mysten/enoki';
import { Transaction } from '@mysten/sui/transactions';
import { fromBase64 } from '@mysten/sui/utils';
import { getZkLoginSessionAccount } from '@/lib/zklogin-session-registry';
import {
  allowedMoveCallTargets,
  reservePendingSponsorship,
  purgeExpiredSponsorships,
} from '@/lib/gas-sponsorship';
import { resolveEscrowSponsorship } from '@/lib/gas-sponsorship-eligibility';
import { getCurrentNetwork, getNetworkConfig } from '@/services/network-config';

interface PrepareBody {
  action?: string;
  kindBytes?: string;
  context?: {
    escrowId?: string;
    circleId?: string;
    coinType?: string;
    usesGasCoinForValue?: boolean;
  };
}

/**
 * Reject any kind whose move calls fall outside the sponsorable allowlist.
 *
 * Enoki enforces `allowedMoveCallTargets` too, so this is not the only guard —
 * but doing it here is what makes the decision auditable on our side, and it
 * fails a disallowed target before we have spent an Enoki call on it.
 */
function assertKindIsSponsorable(kindBytes: Uint8Array, allowed: string[]): void {
  const allowedSet = new Set(allowed);
  const commands = Transaction.fromKind(kindBytes).getData().commands;

  for (const command of commands) {
    if (!('MoveCall' in command) || !command.MoveCall) continue;
    const { package: pkg, module, function: fn } = command.MoveCall;
    const target = `${pkg}::${module}::${fn}`;
    if (!allowedSet.has(target)) {
      throw new Error(`Move call target is not sponsorable: ${target}`);
    }
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { action, kindBytes, context = {} } = (req.body ?? {}) as PrepareBody;
  if (!action || typeof kindBytes !== 'string' || !kindBytes) {
    return res.status(400).json({ error: 'action and kindBytes are required' });
  }

  const sessionId = req.cookies['session-id'];
  const account = sessionId ? await getZkLoginSessionAccount(sessionId) : null;
  if (!account) {
    return res.status(401).json({ error: 'No active session', requireRelogin: true });
  }

  // Declining is always a valid, non-fatal answer: the client pays its own gas.
  // Only genuine faults should surface as non-200.
  const decline = (reason: string) => res.status(200).json({ sponsored: false, reason });

  try {
    const network = getCurrentNetwork();
    const networkConfig = getNetworkConfig(network);
    const apiKey = networkConfig.enoki?.apiKey;
    if (!apiKey) return decline('enoki_not_configured');

    const allowedTargets = allowedMoveCallTargets(networkConfig.packageId);
    if (allowedTargets.length === 0) return decline('no_package_id');

    const decoded = fromBase64(kindBytes);
    try {
      assertKindIsSponsorable(decoded, allowedTargets);
    } catch (err) {
      console.warn('[sponsor/prepare] rejected non-sponsorable kind:', err);
      return decline('target_not_allowed');
    }

    const decision = await resolveEscrowSponsorship({
      sub: account.sub,
      escrowId: context.escrowId ?? context.circleId ?? '',
      coinType: context.coinType ?? '',
      packageId: networkConfig.packageId,
      network,
      usesGasCoinForValue: context.usesGasCoinForValue ?? false,
    });
    if (!decision.sponsor) return decline(decision.reason);

    const enoki = new EnokiClient({ apiKey });
    const sponsored = await enoki.createSponsoredTransaction({
      network,
      transactionKindBytes: kindBytes,
      sender: account.userAddr,
      allowedMoveCallTargets: allowedTargets,
      allowedAddresses: [account.userAddr],
    });

    // Hold a slot so an abandoned prepare cannot burn quota invisibly, and so
    // execute can attribute usage from server state rather than the request.
    await reservePendingSponsorship({
      digest: sponsored.digest,
      sub: account.sub,
      userAddress: account.userAddr,
      circleId: context.escrowId ?? context.circleId ?? null,
      action,
    });
    void purgeExpiredSponsorships();

    return res.status(200).json({
      sponsored: true,
      bytes: sponsored.bytes,
      digest: sponsored.digest,
    });
  } catch (err) {
    // Never fatal to the user's action — they simply pay their own gas.
    console.error('[sponsor/prepare] sponsorship unavailable:', err);
    return decline('sponsor_error');
  }
}
