// walrus-renewal.ts — Core logic for the /api/cron/walrus-renewal Vercel
// cron (daily). Keeps WhatsApp PII blobs alive past their Walrus storage
// lease so the on-chain anchors (which live forever) never point at an
// expired blob.
//
// THE PROBLEM (June 2026 GTM audit, HIGH): walrus-pii.ts stores each
// encrypted PII envelope for WALRUS_STORAGE_EPOCHS (default 5) epochs.
// Walrus blobs are immutable AND expiring — once the lease lapses the blob
// is garbage-collected, but the on-chain `whatsapp_integration` anchor and
// the `whatsapp_phone_index` row both still reference it. The WhatsApp
// webhook then fails to decrypt the routing target and the circle's link
// silently dies on a timer.
//
// THE FIX: a daily cron re-stores (re-uploads) any blob within
// RENEWAL_THRESHOLD_EPOCHS of expiry. Re-storing fetches + decrypts the
// envelope with the CURRENT master key and re-encrypts before upload, so a
// renewal doubles as key-rotation-by-renewal: blobs naturally migrate onto
// the active key as they cycle. The new (blob id, end epoch) is written
// back to the authoritative Postgres index row.
//
// WHY THE INDEX IS AUTHORITATIVE: the webhook resolves a circle via the
// `whatsapp_phone_index` table FIRST (O(1) HMAC lookup), only falling back
// to the on-chain registry scan when the index misses. So updating the
// index row's walrus_blob_id is sufficient to keep routing alive — the
// on-chain anchor keeps the OLD (now-expired) blob id. Re-anchoring on
// chain is a future admin-signed step (it needs the circle admin's
// signature; the cron has no signing authority and must stay non-custodial).
//
// EXPIRY TRACKING: the index gained a nullable `walrus_end_epoch` column
// (migrate-postgres.mjs). Rows linked before this column existed, or by an
// older publisher response, carry NULL — treated as "expiry unknown, renew
// once to learn it" (the re-store response carries the fresh end epoch).
//
// This module is deps-injected and pure so the selection + update logic is
// unit-tested without Postgres, Walrus, or an RPC (see
// __tests__/walrus-renewal.test.ts). The cron route wires the real deps.

import { appLogger } from '../utils/logger';

export const DEFAULT_RENEWAL_THRESHOLD_EPOCHS = 2;

/** One active link as seen by the renewal cron. */
export interface RenewableLink {
  /** Index row id — stable key for the UPDATE + audit row. */
  id: number;
  circleId: string;
  walrusBlobId: string;
  /** Walrus storage end epoch, or null when never recorded (legacy rows). */
  walrusEndEpoch: number | null;
}

export type RenewalDecision =
  | { action: 'skip'; reason: 'fresh' }
  | { action: 'renew'; reason: 'within_threshold' | 'expiry_unknown' };

/**
 * Decides whether a blob needs renewal. Pure — the only inputs are the
 * recorded end epoch, the current Sui epoch, and the threshold.
 *
 *   * end epoch unknown (null) → renew, so we learn + record the real
 *     expiry from the re-store response.
 *   * remaining = endEpoch - currentEpoch <= threshold → renew.
 *   * otherwise → skip (still fresh).
 *
 * `remaining <= threshold` (not `<`) so a blob with exactly `threshold`
 * epochs left is renewed this run rather than gambling on the next daily
 * tick landing before expiry.
 */
export function decideRenewal(
  link: Pick<RenewableLink, 'walrusEndEpoch'>,
  currentEpoch: number,
  thresholdEpochs: number,
): RenewalDecision {
  if (link.walrusEndEpoch === null || !Number.isFinite(link.walrusEndEpoch)) {
    return { action: 'renew', reason: 'expiry_unknown' };
  }
  const remaining = link.walrusEndEpoch - currentEpoch;
  if (remaining <= thresholdEpochs) {
    return { action: 'renew', reason: 'within_threshold' };
  }
  return { action: 'skip', reason: 'fresh' };
}

/** Outcome of re-storing one blob. */
export interface RestoreResult {
  /** The new content blob id returned by the publisher. */
  newBlobId: string;
  /** The new storage end epoch from the publisher response. */
  newEndEpoch: number;
}

export interface RenewalDeps {
  /** Active links to consider, from the authoritative Postgres index. */
  listActiveLinks(): Promise<RenewableLink[]>;
  /** Current Sui epoch (whole number). */
  getCurrentEpoch(): Promise<number>;
  /**
   * Fetches blob `blobId`, decrypts with the current master key, re-encrypts,
   * uploads a fresh copy, and returns the new blob id + end epoch. Throwing
   * is treated as a per-link failure (recorded, the run continues).
   */
  restoreBlob(blobId: string): Promise<RestoreResult>;
  /**
   * Atomically points the index row at the new blob + end epoch AND writes
   * an audit row, but ONLY if the row still references `expectedBlobId`.
   * Returns false when the compare-and-set missed (another run already
   * renewed this row in an overlapping window) — the caller counts it as a
   * skipped duplicate, never a double-renew. Implementations record the
   * audit row in the same transaction as the UPDATE.
   */
  applyRenewal(params: {
    id: number;
    expectedBlobId: string;
    newBlobId: string;
    newEndEpoch: number;
  }): Promise<boolean>;
  thresholdEpochs?: number;
  /** Safety cap on blobs re-stored per run (default 200). */
  maxRenewalsPerRun?: number;
}

export interface RenewalRunResult {
  considered: number;
  skipped: number;
  renewed: number;
  failed: number;
  /** Renewals that lost the compare-and-set to an overlapping run. */
  raced: number;
  /** True when the per-run cap stopped the run before draining every link. */
  capped: boolean;
}

const DEFAULT_MAX_RENEWALS_PER_RUN = 200;

/**
 * Drains the active-link list, renewing every blob within the threshold.
 *
 * Idempotency under overlap: two daily ticks (or a retried tick) that both
 * decide to renew the same row each re-store independently — re-storing is
 * naturally idempotent on Walrus (content-addressed; the publisher returns
 * the same blob id and refreshes the lease) — but only one applyRenewal
 * compare-and-set wins. The loser is counted as `raced`, not `renewed`, and
 * does not regress the row. A per-link failure is recorded and the run
 * continues so one bad blob can never wedge the whole renewal pass.
 */
export async function runWalrusRenewal(
  deps: RenewalDeps,
): Promise<RenewalRunResult> {
  const threshold = deps.thresholdEpochs ?? DEFAULT_RENEWAL_THRESHOLD_EPOCHS;
  const maxRenewals = deps.maxRenewalsPerRun ?? DEFAULT_MAX_RENEWALS_PER_RUN;

  const links = await deps.listActiveLinks();
  const currentEpoch = await deps.getCurrentEpoch();

  const result: RenewalRunResult = {
    considered: links.length,
    skipped: 0,
    renewed: 0,
    failed: 0,
    raced: 0,
    capped: false,
  };

  for (const link of links) {
    const decision = decideRenewal(link, currentEpoch, threshold);
    if (decision.action === 'skip') {
      result.skipped += 1;
      continue;
    }

    if (result.renewed + result.failed + result.raced >= maxRenewals) {
      // Defer the rest to the next daily tick rather than blow the lease
      // TTL / function timeout re-storing thousands of blobs in one run.
      result.capped = true;
      break;
    }

    try {
      const restored = await deps.restoreBlob(link.walrusBlobId);
      const applied = await deps.applyRenewal({
        id: link.id,
        expectedBlobId: link.walrusBlobId,
        newBlobId: restored.newBlobId,
        newEndEpoch: restored.newEndEpoch,
      });
      if (applied) {
        result.renewed += 1;
      } else {
        // Overlapping run already advanced this row — not an error.
        result.raced += 1;
        appLogger.info('[walrus-renewal] renewal raced (row already updated)', {
          id: link.id,
          circleId: link.circleId,
        });
      }
    } catch (err) {
      result.failed += 1;
      appLogger.warn('[walrus-renewal] blob renewal failed (recorded, continuing)', {
        id: link.id,
        circleId: link.circleId,
        reason: decision.reason,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}
