// walrus-read-error.ts — The error a failed Walrus blob read throws, and the
// one question its callers ask of it: would a retry help?
//
// TRANSIENT: the failure says nothing about the blob, so the same read may
// succeed later. The aggregator was unreachable (network error, or the
// connection dropped mid-body), answered 5xx, or rate-limited us (429);
// those clear by themselves. Or it refused this server (401, 403): a
// misconfigured WALRUS_AGGREGATOR_URL, or an aggregator that will not serve
// us. A refusal fails every read alike and clears only once the
// configuration is fixed, so the phone lookups log it as an error, not a
// warning. A caller turning the read into a decision ("is this circle
// linked to WhatsApp?") must not answer "no" on any of these: the phone
// lookups rethrow them, and their crons halt without advancing and retry.
//
// PERMANENT, for that blob: a 404 or 410 (the blob is gone — the on-chain
// anchor keeps a blob's ORIGINAL id, and /api/cron/walrus-renewal records
// each renewed id only in whatsapp_phone_index, so the anchor 404s once its
// first lease lapses), any other 4xx (the aggregator rejects the request
// for this blob id), or a body that is not an envelope. Callers keep these
// as per-blob warnings, so one bad envelope cannot wedge a stream.
// Decryption failures (an AES-GCM auth failure from a corrupt envelope or
// the wrong key) are plain Errors from walrus-pii.ts and count as permanent
// too.
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

/**
 * Aggregator statuses that refuse this server instead of answering for the
 * blob: 401 and 403, a configuration problem (see the header).
 */
export function isRefusedWalrusStatus(status: number): boolean {
  return status === 401 || status === 403;
}

/**
 * Aggregator statuses a retry can fix: rate limiting and server errors, and
 * a refusal once the configuration is fixed.
 */
export function isTransientWalrusStatus(status: number): boolean {
  return status === 429 || status >= 500 || isRefusedWalrusStatus(status);
}

/**
 * True for a Walrus read that failed in a way a retry may fix. Any other
 * error, including every non-Walrus one, is permanent for its blob.
 */
export function isTransientWalrusReadError(err: unknown): err is WalrusReadError {
  return err instanceof WalrusReadError && err.transient;
}

/**
 * True for a Walrus read the aggregator refused (401, 403). Transient too,
 * but it will not clear until someone fixes the configuration.
 */
export function isRefusedWalrusReadError(err: unknown): err is WalrusReadError {
  return err instanceof WalrusReadError && err.status !== null && isRefusedWalrusStatus(err.status);
}
