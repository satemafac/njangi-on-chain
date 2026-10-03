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
// RENEWAL_THRESHOLD_EPOCHS of expiry. Re-storing opens the envelope and
// re-seals it with a fresh IV before upload: a v2 envelope under the same
// per-link data key (so deleting that key still covers every copy), a
// legacy v1 envelope under the current master key (the previous one still
// opens it during a key rotation). The new (blob id, end epoch) is written
// back to the authoritative Postgres index row. A link whose data key was
// deleted (erased or unlinked) is not renewed: its row is dropped instead.
//
// EPOCHS: end epochs and the current epoch are WALRUS epochs (a day on
// testnet, two weeks on mainnet), read from the Walrus System object by
// walrus-epoch.ts. They are not Sui epochs: compared with the Sui epoch
// (testnet 2026-10-02: Sui 1240, Walrus 538) every lease looked expired and
// every blob was re-stored on every run.
//
// ORDER: a run renews the leases closest to running out first, and stops at
// the per-run cap or the time budget. A renewed row's end epoch moves ahead,
// so the rows a run didn't reach lead the next one. Rows with an unknown end
// epoch come next and lapsed rows last, so blobs that fail every day can't
// use up a run before the live ones get a turn.
//
// WHY THE INDEX IS AUTHORITATIVE: the webhook resolves a circle via the
// `whatsapp_phone_index` table FIRST (O(1) HMAC lookup), only falling back
// to the on-chain registry scan when the index misses. Outbound sends read
// it first too — circle-addressed ones in whatsapp-bot/circle-phone.ts,
// member-addressed ones in whatsapp-notifier.ts (resolveMemberPhone). So
// updating the index row's walrus_blob_id is sufficient to keep routing
// alive — the on-chain anchor keeps the OLD (now-expired) blob id. Any new
// reader of a link's blob must likewise prefer the index. Re-anchoring on
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
import { isErasedPiiKeyError } from './pii-key-errors';

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
  | { action: 'renew'; reason: 'within_threshold' | 'expiry_unknown' | 'lapsed' };

/**
 * Decides whether a blob needs renewal. Pure — the only inputs are the
 * recorded end epoch, the current Walrus epoch, and the threshold. Both
 * epochs must be Walrus epochs (see EPOCHS above).
 *
 *   * end epoch unknown (null) → renew, so we learn + record the real
 *     expiry from the re-store response.
 *   * remaining = endEpoch - currentEpoch <= 0 → renew ('lapsed'). The end
 *     epoch is exclusive, so the lease is already over and the blob is
 *     probably gone; the attempt is made anyway in case it is still served.
 *   * remaining <= threshold → renew.
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
  if (remaining <= 0) {
    return { action: 'renew', reason: 'lapsed' };
  }
  if (remaining <= thresholdEpochs) {
    return { action: 'renew', reason: 'within_threshold' };
  }
  return { action: 'skip', reason: 'fresh' };
}

type RenewDecision = Extract<RenewalDecision, { action: 'renew' }>;

interface DueLink {
  link: RenewableLink;
  decision: RenewDecision;
}

const RENEWAL_TIER: Record<RenewDecision['reason'], number> = {
  within_threshold: 0,
  expiry_unknown: 1,
  lapsed: 2,
};

/**
 * Renewal order for the due links (see ORDER above): live leases by end
 * epoch, soonest first; then unknown end epochs; then lapsed leases, most
 * recently lapsed first, since those are the likeliest to still be served.
 * Ties go to the lower row id, so the order never depends on list order.
 */
function compareDueLinks(a: DueLink, b: DueLink): number {
  const tier = RENEWAL_TIER[a.decision.reason] - RENEWAL_TIER[b.decision.reason];
  if (tier !== 0) return tier;
  // Only within_threshold and lapsed rows carry a finite end epoch.
  const aEnd = a.link.walrusEndEpoch ?? 0;
  const bEnd = b.link.walrusEndEpoch ?? 0;
  let byEnd = 0;
  if (a.decision.reason === 'within_threshold') byEnd = aEnd - bEnd;
  else if (a.decision.reason === 'lapsed') byEnd = bEnd - aEnd;
  return byEnd !== 0 ? byEnd : a.link.id - b.link.id;
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
  /**
   * Current epoch of the Walrus deployment the publisher stores on (a whole
   * number; walrus-epoch.ts). Never the Sui epoch. Throwing fails the run
   * before anything is listed or renewed.
   */
  getCurrentWalrusEpoch(): Promise<number>;
  /**
   * Fetches blob `blobId`, opens it, re-seals it (restorePiiBlob), uploads a
   * fresh copy, and returns the new blob id + end epoch. Throwing is treated
   * as a per-link failure (recorded, the run continues), except
   * PiiKeyErasedError, which counts the link as erased (see dropErasedLink).
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
  /**
   * Called when restoreBlob finds the link's data key deleted (the link was
   * erased or unlinked; PiiKeyErasedError): deletes index row `id`, but only
   * while it still references `expectedBlobId`. Nothing is renewed for that
   * link either way. Optional; a throw is logged and the run continues.
   */
  dropErasedLink?(params: { id: number; expectedBlobId: string }): Promise<boolean>;
  thresholdEpochs?: number;
  /** Safety cap on blobs re-stored per run (default 200). */
  maxRenewalsPerRun?: number;
  /**
   * Wall-clock time (ms since 1970) after which no new renewal starts. The
   * cron derives it from its function time limit, so a run with more work
   * than time ends cleanly (summary logged, lease released) instead of being
   * killed mid-renewal. Unset: no time limit.
   */
  deadlineMs?: number;
  /** Clock for deadlineMs (default Date.now); tests inject one. */
  now?: () => number;
}

export interface RenewalRunResult {
  /** The Walrus epoch every end epoch was compared against. */
  walrusEpoch: number;
  considered: number;
  skipped: number;
  renewed: number;
  failed: number;
  /** Renewals that lost the compare-and-set to an overlapping run. */
  raced: number;
  /**
   * Due links whose data key was deleted (erased or unlinked): their blobs
   * no longer open, so nothing was renewed and their index rows were
   * dropped. Not failures.
   */
  erased: number;
  /** Due links this run left for a later one (cap or time budget). */
  deferred: number;
  /**
   * Renewals whose new end epoch is within the threshold of walrusEpoch, so
   * the row comes due again on the next run. The publisher stores
   * WALRUS_STORAGE_EPOCHS ahead of its own epoch, so this means the epoch
   * source and the publisher disagree (different Walrus deployments, or a
   * clock that isn't the Walrus epoch at all), or WALRUS_STORAGE_EPOCHS is
   * not above the threshold. The cron reports such a run as failed.
   */
  leaseMismatches: number;
  /** True when the per-run cap or the time budget stopped the run early. */
  capped: boolean;
}

const DEFAULT_MAX_RENEWALS_PER_RUN = 200;

/**
 * Renews every due blob, most urgent first, until the list, the per-run
 * cap or the time budget runs out.
 *
 * Idempotency under overlap: two runs that both decide to renew the same row
 * each upload their own copy (re-encryption uses a fresh IV, so every copy
 * is a new blob), but only one applyRenewal compare-and-set wins. The loser
 * is counted as `raced`, not `renewed`, does not regress the row, and its
 * copy is never referenced. A per-link failure is recorded and the run
 * continues so one bad blob can never wedge the whole renewal pass.
 */
export async function runWalrusRenewal(
  deps: RenewalDeps,
): Promise<RenewalRunResult> {
  const threshold = deps.thresholdEpochs ?? DEFAULT_RENEWAL_THRESHOLD_EPOCHS;
  const maxRenewals = deps.maxRenewalsPerRun ?? DEFAULT_MAX_RENEWALS_PER_RUN;
  const now = deps.now ?? Date.now;

  // The epoch decides which leases get renewed, so it is read first and a
  // value that isn't a whole epoch number stops the run. A failed read must
  // not become "every lease is fresh" (NaN compares false) or "every lease
  // lapsed".
  const walrusEpoch = await deps.getCurrentWalrusEpoch();
  if (!Number.isSafeInteger(walrusEpoch) || walrusEpoch < 0) {
    throw new Error(
      `The current Walrus epoch must be a whole number, got ${String(walrusEpoch)}. Nothing was renewed.`,
    );
  }

  const links = await deps.listActiveLinks();

  const result: RenewalRunResult = {
    walrusEpoch,
    considered: links.length,
    skipped: 0,
    renewed: 0,
    failed: 0,
    raced: 0,
    erased: 0,
    deferred: 0,
    leaseMismatches: 0,
    capped: false,
  };

  const due: DueLink[] = [];
  for (const link of links) {
    const decision = decideRenewal(link, walrusEpoch, threshold);
    if (decision.action === 'skip') {
      result.skipped += 1;
    } else {
      due.push({ link, decision });
    }
  }
  due.sort(compareDueLinks);

  for (let i = 0; i < due.length; i += 1) {
    const outOfTime = deps.deadlineMs !== undefined && now() >= deps.deadlineMs;
    const attempted = result.renewed + result.failed + result.raced + result.erased;
    if (outOfTime || attempted >= maxRenewals) {
      // Leave the rest for the next daily tick rather than run past the
      // function's time limit. They are still due tomorrow, and the rows
      // renewed today no longer are.
      result.capped = true;
      result.deferred = due.length - i;
      break;
    }

    const { link, decision } = due[i];
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
      if (restored.newEndEpoch - walrusEpoch <= threshold) {
        // The renewal stands, so the link stays alive, but the epochs don't
        // line up (see leaseMismatches).
        result.leaseMismatches += 1;
        appLogger.warn('[walrus-renewal] renewed lease ends within the renewal threshold', {
          id: link.id,
          circleId: link.circleId,
          walrusEpoch,
          newEndEpoch: restored.newEndEpoch,
          thresholdEpochs: threshold,
        });
      }
    } catch (err) {
      if (isErasedPiiKeyError(err)) {
        // The link was erased or unlinked: its key is gone, so no copy of
        // the blob opens and there is nothing to keep alive.
        result.erased += 1;
        appLogger.info('[walrus-renewal] data key deleted (link erased or unlinked); not renewing', {
          id: link.id,
          circleId: link.circleId,
        });
        if (deps.dropErasedLink) {
          try {
            await deps.dropErasedLink({ id: link.id, expectedBlobId: link.walrusBlobId });
          } catch (dropErr) {
            appLogger.warn('[walrus-renewal] could not drop the index row of an erased link', {
              id: link.id,
              circleId: link.circleId,
              error: dropErr instanceof Error ? dropErr.message : String(dropErr),
            });
          }
        }
        continue;
      }
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
