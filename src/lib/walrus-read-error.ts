// walrus-read-error.ts — The error a failed Walrus blob read throws, and the
// one question its callers ask of it: would a retry help?
//
// TRANSIENT: the aggregator was unreachable (network error, or the
// connection dropped mid-body), answered 5xx, or rate-limited us (429). That
// says nothing about the blob, so a caller turning the read into a decision
// ("is this circle linked to WhatsApp?") must not answer "no": the phone
// lookups rethrow it, and their crons halt without advancing and retry.
//
// PERMANENT, for that blob: a 404 (the blob expired — the on-chain anchor
// keeps a blob's ORIGINAL id, and /api/cron/walrus-renewal records each
// renewed id only in whatsapp_phone_index, so the anchor 404s once its first
// lease lapses), any other 4xx, or a body that is not an envelope. Callers
// keep these as per-blob warnings, so one bad envelope cannot wedge a
// stream. Decryption failures (an AES-GCM auth failure from a corrupt
// envelope or the wrong key) are plain Errors from walrus-pii.ts and count
// as permanent too.
//
// Kept apart from walrus-pii.ts so a caller can classify an error without
// pulling in the crypto and key handling, and so test suites that mock
// walrus-pii wholesale still get the real class.

export class WalrusReadError extends Error {
  /** HTTP status the aggregator answered with; null when no answer came. */
  readonly status: number | null;
  /** True when the same read may succeed if retried. */
  readonly transient: boolean;

  constructor(
    message: string,
    options: { status: number | null; transient: boolean; cause?: unknown },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'WalrusReadError';
    this.status = options.status;
    this.transient = options.transient;
  }
}

/** Aggregator statuses a retry can fix: rate limiting and server errors. */
export function isTransientWalrusStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * True for a Walrus read that failed in a way a retry may fix. Any other
 * error, including every non-Walrus one, is permanent for its blob.
 */
export function isTransientWalrusReadError(err: unknown): err is WalrusReadError {
  return err instanceof WalrusReadError && err.transient;
}
