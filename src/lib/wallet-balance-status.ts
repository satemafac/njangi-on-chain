// wallet-balance-status.ts — whether the dashboard's wallet figures are a real
// reading. A failed balance read used to leave the initial zeros in place, so a
// funded wallet showed "$0 · balances will appear after your wallet is funded"
// whenever the RPC was down (seen live 2026-10-15).

export type WalletBalanceStatus = 'loading' | 'ok' | 'stale' | 'unavailable';

/**
 * The status after a balance read. A failure keeps an earlier real reading
 * (marked stale); with no earlier reading, the balance is unavailable, never 0.
 */
export function afterBalanceRead(
  previous: WalletBalanceStatus,
  succeeded: boolean,
): WalletBalanceStatus {
  if (succeeded) return 'ok';
  return previous === 'ok' || previous === 'stale' ? 'stale' : 'unavailable';
}

/** True when the figures on screen come from an actual read. */
export function isWalletBalanceKnown(status: WalletBalanceStatus): boolean {
  return status === 'ok' || status === 'stale';
}
