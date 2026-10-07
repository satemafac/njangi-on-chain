// tx-effects-status.ts — a transaction that EXECUTED is not a transaction
// that SUCCEEDED.
//
// Sui commits a transaction that fails during execution (a Move abort,
// running out of gas) and charges its gas. `executeTransactionBlock` resolves
// normally either way; the failure lives only in `effects.status`. A caller
// that reads just the digest turns every on-chain refusal into a success
// message: the round panel thanked a member for a payment the contract had
// refused, and its duplicate-open handling (abort 234) could never run,
// because nothing ever threw.

/** Thrown for a transaction that landed on chain but failed there. */
export class OnChainFailureError extends Error {
  readonly digest: string;

  constructor(digest: string, failure: string) {
    // The chain's own text stays in the message, so moveAbortUserMessage and
    // classifyOpenRoundError read it exactly as they read a refused dry run.
    super(`The transaction failed on chain: ${failure}`);
    this.name = 'OnChainFailureError';
    this.digest = digest;
  }
}

/**
 * True for an OnChainFailureError. Checked by name rather than instanceof,
 * which a down-levelled Error subclass does not always survive.
 */
export function isOnChainFailure(error: unknown): error is OnChainFailureError {
  return error instanceof Error && error.name === 'OnChainFailureError';
}

/** The failure text of executed effects; null when they succeeded or were not returned. */
export function onChainFailure(effects: unknown): string | null {
  const status = (effects as { status?: { status?: unknown; error?: unknown } } | null | undefined)
    ?.status;
  if (!status || status.status !== 'failure') return null;
  return typeof status.error === 'string' && status.error ? status.error : 'unknown error';
}

/**
 * Throws OnChainFailureError when the effects say the transaction failed.
 * Effects that were not returned prove nothing either way, so they pass, as
 * a digest alone always did.
 */
export function assertTransactionSucceeded(result: { digest: string; effects?: unknown }): void {
  const failure = onChainFailure(result.effects);
  if (failure) throw new OnChainFailureError(result.digest, failure);
}
