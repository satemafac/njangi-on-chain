// gas-sponsorship-eligibility.ts — composes the pure sponsorship policy
// (gas-sponsorship.ts) with the two I/O lookups it needs: the circle's
// on-chain admin and that admin's billing entitlement.
//
// Kept separate from gas-sponsorship.ts so the policy/metering core stays
// dependency-light and unit-testable; this module is the "wire it to the
// chain + Stripe" layer used by the API broker.
//
// The benefit model: a circle's MEMBERS transact gas-free when the circle's
// ADMIN (the on-chain `admin` field, i.e. the person who signed up and pays)
// holds a Premium entitlement. The contributing member need not be premium —
// the admin's subscription funds the whole circle's gas.

import { shouldSponsor, type SponsorshipDecision } from './gas-sponsorship';
import { getEntitlements } from './entitlement-gate';
import { fetchCircleAdminAddress } from './circle-admin-verification';
import { getPooledSuiClient } from '../services/sui-rpc-failover';
import { getNetworkConfig } from '../services/network-config';
import type { NetworkType } from '../services/whatsapp-registry-service';

/**
 * Reads the `circle_id` recorded on a CycleEscrow object so we can find its
 * circle (and thus its admin). Returns null on any miss; callers treat null
 * as "cannot confirm admin -> do not sponsor".
 */
export async function circleIdForEscrow(
  escrowId: string,
  network: NetworkType,
): Promise<string | null> {
  try {
    const networkConfig = getNetworkConfig(network);
    const suiClient = getPooledSuiClient({ network, rpcUrl: networkConfig.rpcUrl });
    const obj = await suiClient.getObject({ id: escrowId, options: { showContent: true } });
    const content = obj.data?.content;
    if (!content || content.dataType !== 'moveObject') return null;
    const fields = (content as { fields: { circle_id?: string } }).fields;
    return fields?.circle_id ?? null;
  } catch (err) {
    console.error('[gas-sponsorship] circleIdForEscrow failed', err);
    return null;
  }
}

/** True when the given address holds a premium entitlement. Fails safe (false). */
export async function isAdminPremium(adminAddress: string | null): Promise<boolean> {
  if (!adminAddress) return false;
  try {
    const entitlements = await getEntitlements({ userAddress: adminAddress });
    return entitlements.plan === 'premium';
  } catch (err) {
    // Billing-infra trouble must never *enable* a spend we can't justify:
    // fail closed to self-paid gas.
    console.error('[gas-sponsorship] entitlement lookup failed; not sponsoring', err);
    return false;
  }
}

export interface EscrowSponsorshipInput {
  sub: string;
  escrowId: string;
  circleId?: string | null;
  coinType: string;
  packageId: string | null | undefined;
  network: NetworkType;
  /**
   * Whether the transaction draws its value from `txb.gas`. For the broker's
   * escrow handlers this is always false (an explicit payment coin object is
   * passed), but the flag is threaded through so future gas-split callers
   * cannot accidentally get sponsored. Defaults to false.
   */
  usesGasCoinForValue?: boolean;
}

/**
 * Full go/no-go for sponsoring an escrow-related action. Resolves the circle
 * admin (via the escrow's circle_id when circleId isn't supplied), checks the
 * admin's premium status, then applies the pure policy + fair-use caps.
 */
export async function resolveEscrowSponsorship(
  input: EscrowSponsorshipInput,
): Promise<SponsorshipDecision> {
  const circleId =
    input.circleId ?? (await circleIdForEscrow(input.escrowId, input.network));
  if (!circleId) {
    return { sponsor: false, reason: 'no_circle_id' };
  }

  let adminAddress: string | null = null;
  try {
    adminAddress = await fetchCircleAdminAddress(circleId, input.network);
  } catch (err) {
    console.error('[gas-sponsorship] admin lookup failed; not sponsoring', err);
    return { sponsor: false, reason: 'admin_lookup_failed' };
  }

  const adminIsPremium = await isAdminPremium(adminAddress);

  return shouldSponsor({
    sub: input.sub,
    adminIsPremium,
    usesGasCoinForValue: input.usesGasCoinForValue ?? false,
    packageId: input.packageId,
  });
}
