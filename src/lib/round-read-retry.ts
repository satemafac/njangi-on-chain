// round-read-retry.ts — when the round panel re-reads a round it failed to load.
//
// A failed read is usually an RPC cooldown, not an outage: the failover pool
// benches an endpoint for 10s after a transient failure and for 30s after a
// 429 (src/services/sui-rpc-failover.ts), and while every endpoint sits out,
// each read fails without leaving the browser. The panel used to stop there,
// on "We couldn't reach the network", until someone pressed Refresh status;
// after a Resume Cycle on production (2026-10-06) only a page reload brought
// the round back. So it retries by itself: once soon, then past a 10s and a
// 30s cooldown, then stops. The Refresh status button stays for anything
// longer.

/** The waits before each automatic re-read, in order. */
export const ROUND_READ_RETRY_DELAYS_MS: readonly number[] = [4_000, 10_000, 25_000, 45_000];

/**
 * How long to wait before re-reading a round after `consecutiveFailures`
 * failed reads in a row, or null when the panel should not retry: no read
 * has failed, or every automatic retry is spent.
 */
export function roundReadRetryDelayMs(consecutiveFailures: number): number | null {
  if (!Number.isSafeInteger(consecutiveFailures) || consecutiveFailures < 1) return null;
  return ROUND_READ_RETRY_DELAYS_MS[consecutiveFailures - 1] ?? null;
}
