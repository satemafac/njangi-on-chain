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
import { fromBase64, normalizeSuiObjectId } from '@mysten/sui/utils';
import { getZkLoginSessionAccount } from '@/lib/zklogin-session-registry';
import {
  allowedMoveCallTargets,
  reservePendingSponsorship,
  purgeExpiredSponsorships,
} from '@/lib/gas-sponsorship';
import { isPostgresConfigured } from '@/lib/pg-pool';
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
function assertKindIsSponsorable(kindBytes: Uint8Array, allowed: string[]): Set<string> {
  const allowedSet = new Set(allowed);
  const data = Transaction.fromKind(kindBytes).getData();

  for (const command of data.commands) {
    if (!('MoveCall' in command) || !command.MoveCall) continue;
    const { package: pkg, module, function: fn } = command.MoveCall;
    const target = `${pkg}::${module}::${fn}`;
    if (!allowedSet.has(target)) {
      throw new Error(`Move call target is not sponsorable: ${target}`);
    }
  }

  // Every object this kind actually touches, so the caller can prove the
  // circle it wants billed is one of them (see the binding check below).
  const objectIds = new Set<string>();
  for (const input of data.inputs) {
    if (input.$kind !== 'Object' || !input.Object) continue;
    const obj = input.Object as {
      SharedObject?: { objectId: string };
      ImmOrOwnedObject?: { objectId: string };
      Receiving?: { objectId: string };
    };
    const objectId =
      obj.SharedObject?.objectId ?? obj.ImmOrOwnedObject?.objectId ?? obj.Receiving?.objectId;
    if (objectId) objectIds.add(normalizeSuiObjectId(objectId));
  }
  return objectIds;
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
  // Only genuine faults should surface as non-200. Logged because a silent
  // decline is indistinguishable from "sponsorship is off" from the outside —
  // which is how a deterministic deposit failure went unnoticed. Action and
  // reason only; no sub, no address.
  const decline = (reason: string) => {
    console.info('[sponsor/prepare] declined', { action, reason });
    return res.status(200).json({ sponsored: false, reason });
  };

  try {
    const network = getCurrentNetwork();
    const networkConfig = getNetworkConfig(network);
    const apiKey = networkConfig.enoki?.apiKey;
    if (!apiKey) return decline('enoki_not_configured');

    // Metering is a precondition, not an afterthought. Without Postgres the
    // reservation below silently no-ops and execute then 409s forever, so
    // every attempt would burn an Enoki gas coin and still self-pay. Check
    // before spending the call rather than after.
    if (!isPostgresConfigured()) return decline('metering_unavailable');

    const allowedTargets = allowedMoveCallTargets(networkConfig.packageId);
    if (allowedTargets.length === 0) return decline('no_package_id');

    const decoded = fromBase64(kindBytes);
    let kindObjectIds: Set<string>;
    try {
      kindObjectIds = assertKindIsSponsorable(decoded, allowedTargets);
    } catch (err) {
      console.warn('[sponsor/prepare] rejected non-sponsorable kind:', err);
      return decline('target_not_allowed');
    }

    // Bind the circle being BILLED to the transaction being sponsored.
    //
    // The session cookie proves who the caller is, but the circle whose
    // admin's benefit gets consumed came from the request body and was never
    // checked against the transaction. Any caller could name a premium
    // circle's id and draw on that admin's sponsored gas for a transaction
    // touching a different circle. Requiring the id to appear among the
    // kind's object inputs closes that without needing to understand the
    // call's shape.
    const billedId = context.circleId ?? context.escrowId;
    if (!billedId) return decline('no_circle_id');
    if (!kindObjectIds.has(normalizeSuiObjectId(billedId))) {
      return decline('circle_not_in_transaction');
    }

    const decision = await resolveEscrowSponsorship({
      sub: account.sub,
      // Keep these distinct. Passing a Circle id as `escrowId` sent the
      // resolver looking for a `circle_id` field that only CycleEscrow has,
      // so every security deposit resolved `no_circle_id` and could never be
      // sponsored — the flag looked on and did nothing.
      escrowId: context.escrowId ?? '',
      circleId: context.circleId ?? null,
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
    // Attributed to the RESOLVED circle — the column is named circle_id and
    // previously received an escrow id on the contribute path.
    const reserved = await reservePendingSponsorship({
      digest: sponsored.digest,
      sub: account.sub,
      userAddress: account.userAddr,
      circleId: decision.circleId,
      action,
    });
    if (!reserved) {
      // One Enoki call is already spent here — the digest does not exist until
      // Enoki responds, so reserving first is not possible. Declining at least
      // stops the client signing against a slot nothing is holding, which
      // execute would reject with 409 anyway.
      return decline('reservation_failed');
    }
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
