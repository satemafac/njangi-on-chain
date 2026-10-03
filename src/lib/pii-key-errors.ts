// pii-key-errors.ts — The two ways opening a WhatsApp PII envelope (v2,
// src/lib/walrus-pii.ts) can fail on its per-link data key
// (src/lib/whatsapp-pii-keys.ts), and how callers tell them apart.
//
// ERASED (PiiKeyErasedError): the key's row is gone because the link was
// erased or unlinked. The blob is unreadable for good, which is the point,
// so callers treat it like an expired blob: this blob holds no phone, skip
// it and send nothing. It is a fact, not a failure.
//
// UNREADABLE (PiiKeyReadError): the key store could not answer (Postgres
// down) or the row is wrapped under a master key this deployment doesn't
// hold (a rotation in progress without WALRUS_PII_PREVIOUS_MASTER_KEY). The
// link may well be alive. It extends WalrusReadError as a TRANSIENT failure,
// so every phone lookup already holds and rethrows it the way it does an
// unreachable aggregator: the crons halt without advancing and retry, and
// the webhook says it couldn't check instead of "No circles linked"
// (walrus-read-error.ts). Opening a v2 blob takes the blob and its key;
// failing to read either is failing to read the blob.
//
// Kept apart from walrus-pii.ts so test suites that mock walrus-pii
// wholesale still get the real classes.

import { WalrusReadError } from './walrus-read-error';

export class PiiKeyErasedError extends Error {
  /** The envelope's key id. */
  readonly kid: string;

  constructor(kid: string) {
    super(`The data key ${kid} was deleted (link erased or unlinked); its envelope no longer opens.`);
    this.name = 'PiiKeyErasedError';
    this.kid = kid;
  }
}

export class PiiKeyReadError extends WalrusReadError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, { status: null, transient: true, cause: options.cause });
    this.name = 'PiiKeyReadError';
  }
}

/** True when an envelope did not open because its link's key was deleted. */
export function isErasedPiiKeyError(err: unknown): err is PiiKeyErasedError {
  return err instanceof PiiKeyErasedError;
}
