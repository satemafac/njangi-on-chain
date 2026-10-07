// circle-recovery-state.ts — Whether a circle's member-voted recovery has
// executed, read for the round panel's cancel.
//
// `cancel_unfinalized_escrow_for_recovery<T>` waives the 7-day grace once the
// circle's `recovery_state` is STOPPED (2) or REFUNDED (3) — the recovery vote
// is the member-initiated authorization — and aborts 227
// `E_CIRCLE_NOT_IN_RECOVERY` otherwise. The state lives on the circle's
// CircleConfig dynamic field (circle-config.ts), the same read
// `parseRecoveryStatus` makes on the circle pages; the contribute page, which
// hosts the panel for members, does not read it, so the panel asks here.
//
// Doctrine (shared with cycle-escrow-discovery.ts): a read that FAILED is
// unknown, never "not stopped". Null leaves the panel on the time rule, which
// still offers the cancel once the grace has elapsed, and never widens the
// window on a guess.

import type { SuiClient } from '@mysten/sui/client';
import type { NetworkType } from '@/config/public-env';
import { getNetworkConfig } from '@/services/network-config';
import { getPooledSuiClient } from '@/services/sui-rpc-failover';
import { getCircleConfigFields } from './circle-config';

/** `njangi_config::recovery_state_stopped` / `recovery_state_refunded`. */
export const RECOVERY_STATE_STOPPED = 2;
export const RECOVERY_STATE_REFUNDED = 3;

/**
 * The `recovery_state` field as read from a CircleConfig, or null when the
 * fields hold no readable one.
 */
export function parseRecoveryStateValue(
  configFields: Record<string, unknown> | null | undefined,
): number | null {
  const raw = configFields?.recovery_state;
  const value =
    typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : typeof raw === 'number' ? raw : NaN;
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** True exactly for the two states the recovery cancel accepts. */
export function isRecoveryStopped(recoveryState: number | null): boolean | null {
  if (recoveryState === null) return null;
  return recoveryState === RECOVERY_STATE_STOPPED || recoveryState === RECOVERY_STATE_REFUNDED;
}

/**
 * Whether `circleId`'s recovery has executed (STOPPED or REFUNDED). Null when
 * the config could not be found or read: unknown, never false.
 */
export async function readCircleRecoveryStopped(
  circleId: string,
  network: NetworkType,
  client?: SuiClient,
): Promise<boolean | null> {
  const rpcClient =
    client ??
    getPooledSuiClient({
      network,
      rpcUrl: getNetworkConfig(network).rpcUrl,
    });
  try {
    const fields = await getCircleConfigFields(rpcClient, circleId);
    return isRecoveryStopped(parseRecoveryStateValue(fields));
  } catch (err) {
    console.warn('[circle-recovery-state] could not read recovery_state for', circleId, err);
    return null;
  }
}
