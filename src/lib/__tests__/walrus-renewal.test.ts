// walrus-renewal.test.ts — Pure-function coverage for the Walrus PII blob
// renewal cron's selection + drain logic. The June 2026 GTM audit (HIGH)
// flagged that PII blobs expire on a WALRUS_STORAGE_EPOCHS timer while the
// on-chain anchors referencing them live forever. These tests pin the
// fixed contract: a blob within RENEWAL_THRESHOLD_EPOCHS (or with unknown
// expiry) is renewed, a fresh blob is skipped, the index update is driven
// off the re-store result, and overlapping runs cannot double-renew a row.

import {
  decideRenewal,
  runWalrusRenewal,
  DEFAULT_RENEWAL_THRESHOLD_EPOCHS,
  type RenewableLink,
  type RenewalDeps,
  type RestoreResult,
} from '../walrus-renewal';

function link(overrides: Partial<RenewableLink> = {}): RenewableLink {
  return {
    id: overrides.id ?? 1,
    circleId: overrides.circleId ?? '0xcircle',
    walrusBlobId: overrides.walrusBlobId ?? 'blob-old',
    walrusEndEpoch: overrides.walrusEndEpoch ?? 100,
  };
}

describe('decideRenewal', () => {
  it('renews a blob within the threshold (remaining <= threshold)', () => {
    // endEpoch 102, currentEpoch 100, threshold 2 → remaining 2 → renew.
    expect(decideRenewal({ walrusEndEpoch: 102 }, 100, 2)).toEqual({
      action: 'renew',
      reason: 'within_threshold',
    });
  });

  it('renews a blob already past expiry (negative remaining)', () => {
    expect(decideRenewal({ walrusEndEpoch: 95 }, 100, 2)).toEqual({
      action: 'renew',
      reason: 'within_threshold',
    });
  });

  it('skips a fresh blob beyond the threshold', () => {
    // endEpoch 110, currentEpoch 100, threshold 2 → remaining 10 → skip.
    expect(decideRenewal({ walrusEndEpoch: 110 }, 100, 2)).toEqual({
      action: 'skip',
      reason: 'fresh',
    });
  });

  it('renews a blob whose expiry is unknown (null), to learn it', () => {
    expect(decideRenewal({ walrusEndEpoch: null }, 100, 2)).toEqual({
      action: 'renew',
      reason: 'expiry_unknown',
    });
  });

  it('treats a non-finite end epoch as unknown', () => {
    expect(decideRenewal({ walrusEndEpoch: NaN }, 100, 2)).toEqual({
      action: 'renew',
      reason: 'expiry_unknown',
    });
  });

  it('exports a sane default threshold', () => {
    expect(DEFAULT_RENEWAL_THRESHOLD_EPOCHS).toBe(2);
  });
});

interface Harness {
  deps: RenewalDeps;
  restoreCalls: string[];
  applyCalls: Array<{ id: number; expectedBlobId: string; newBlobId: string; newEndEpoch: number }>;
}

function harness(
  links: RenewableLink[],
  currentEpoch: number,
  opts: {
    restore?: (blobId: string) => Promise<RestoreResult>;
    apply?: (params: {
      id: number;
      expectedBlobId: string;
      newBlobId: string;
      newEndEpoch: number;
    }) => Promise<boolean>;
    thresholdEpochs?: number;
    maxRenewalsPerRun?: number;
  } = {},
): Harness {
  const restoreCalls: string[] = [];
  const applyCalls: Harness['applyCalls'] = [];
  const deps: RenewalDeps = {
    listActiveLinks: async () => links,
    getCurrentEpoch: async () => currentEpoch,
    restoreBlob:
      opts.restore ??
      (async (blobId) => {
        restoreCalls.push(blobId);
        return { newBlobId: `${blobId}-renewed`, newEndEpoch: currentEpoch + 5 };
      }),
    applyRenewal:
      opts.apply ??
      (async (params) => {
        applyCalls.push(params);
        return true;
      }),
    thresholdEpochs: opts.thresholdEpochs,
    maxRenewalsPerRun: opts.maxRenewalsPerRun,
  };
  // Wrap restore to always record even when a custom restore is supplied.
  if (opts.restore) {
    const inner = deps.restoreBlob;
    deps.restoreBlob = async (blobId) => {
      restoreCalls.push(blobId);
      return inner(blobId);
    };
  }
  if (opts.apply) {
    const inner = deps.applyRenewal;
    deps.applyRenewal = async (params) => {
      applyCalls.push(params);
      return inner(params);
    };
  }
  return { deps, restoreCalls, applyCalls };
}

describe('runWalrusRenewal', () => {
  it('renews only the blobs within the threshold and skips the rest', async () => {
    const links = [
      link({ id: 1, walrusBlobId: 'fresh', walrusEndEpoch: 200 }), // skip
      link({ id: 2, walrusBlobId: 'expiring', walrusEndEpoch: 101 }), // renew
      link({ id: 3, walrusBlobId: 'unknown', walrusEndEpoch: null }), // renew
    ];
    const h = harness(links, 100, { thresholdEpochs: 2 });

    const result = await runWalrusRenewal(h.deps);

    expect(result).toMatchObject({
      considered: 3,
      skipped: 1,
      renewed: 2,
      failed: 0,
      raced: 0,
      capped: false,
    });
    expect(h.restoreCalls).toEqual(['expiring', 'unknown']);
    expect(h.applyCalls.map((c) => c.expectedBlobId)).toEqual(['expiring', 'unknown']);
  });

  it('passes the re-stored blob id + end epoch through to the index update', async () => {
    const links = [link({ id: 7, walrusBlobId: 'blob-7', walrusEndEpoch: 100 })];
    const h = harness(links, 100, {
      thresholdEpochs: 2,
      restore: async () => ({ newBlobId: 'blob-7-v2', newEndEpoch: 142 }),
    });

    await runWalrusRenewal(h.deps);

    expect(h.applyCalls).toEqual([
      { id: 7, expectedBlobId: 'blob-7', newBlobId: 'blob-7-v2', newEndEpoch: 142 },
    ]);
  });

  it('counts a lost compare-and-set as raced, not renewed (overlap idempotency)', async () => {
    const links = [link({ id: 1, walrusEndEpoch: 100 })];
    // applyRenewal returns false → another run already advanced this row.
    const h = harness(links, 100, { thresholdEpochs: 2, apply: async () => false });

    const result = await runWalrusRenewal(h.deps);

    expect(result).toMatchObject({ renewed: 0, raced: 1, failed: 0 });
  });

  it('records a per-blob restore failure and continues with the rest', async () => {
    const links = [
      link({ id: 1, walrusBlobId: 'bad', walrusEndEpoch: 100 }),
      link({ id: 2, walrusBlobId: 'good', walrusEndEpoch: 100 }),
    ];
    const h = harness(links, 100, {
      thresholdEpochs: 2,
      restore: async (blobId) => {
        if (blobId === 'bad') throw new Error('aggregator 404');
        return { newBlobId: `${blobId}-renewed`, newEndEpoch: 150 };
      },
    });

    const result = await runWalrusRenewal(h.deps);

    expect(result).toMatchObject({ renewed: 1, failed: 1, raced: 0 });
    // The good blob still got an index update despite the bad one failing.
    expect(h.applyCalls.map((c) => c.expectedBlobId)).toEqual(['good']);
  });

  it('honors the per-run cap and reports it stopped early', async () => {
    const links = [
      link({ id: 1, walrusBlobId: 'a', walrusEndEpoch: 100 }),
      link({ id: 2, walrusBlobId: 'b', walrusEndEpoch: 100 }),
      link({ id: 3, walrusBlobId: 'c', walrusEndEpoch: 100 }),
    ];
    const h = harness(links, 100, { thresholdEpochs: 2, maxRenewalsPerRun: 2 });

    const result = await runWalrusRenewal(h.deps);

    expect(result.renewed).toBe(2);
    expect(result.capped).toBe(true);
    expect(h.restoreCalls).toEqual(['a', 'b']);
  });

  it('defaults the threshold when none is supplied', async () => {
    // endEpoch 101, currentEpoch 100 → remaining 1 <= default 2 → renew.
    const links = [link({ id: 1, walrusEndEpoch: 101 })];
    const h = harness(links, 100); // no thresholdEpochs

    const result = await runWalrusRenewal(h.deps);

    expect(result.renewed).toBe(1);
  });
});
