// wait-for-tx-indexed.ts — refresh after a transaction, not before it lands.
//
// A page that signs a transaction and immediately re-reads the chain can hit
// a fullnode that has not indexed it yet, and then shows the state from
// before the transaction: the vote count unchanged, "Resume Cycle" still
// offered, "Execute emergency stop" still there after it ran. Waiting until
// the node the page reads from has the transaction makes the refresh show
// its effects.

import type { SuiClient } from '@mysten/sui/client';

/**
 * Resolves once `client`'s node has indexed `digest`, or after `timeoutMs`.
 * Never throws: a timeout or a failed poll just lets the caller refresh
 * anyway (the page's own polling catches up later). True when indexed.
 */
export async function waitForTxIndexed(
  client: Pick<SuiClient, 'waitForTransaction'>,
  digest: string | null | undefined,
  timeoutMs = 15_000,
): Promise<boolean> {
  if (!digest) return false;
  try {
    await client.waitForTransaction({ digest, timeout: timeoutMs, pollInterval: 1_000 });
    return true;
  } catch (error) {
    console.warn('[wait-for-tx-indexed] refreshing before the transaction was indexed', { digest, error });
    return false;
  }
}
