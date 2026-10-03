// walrus-renewal.test.ts — Pure-function coverage for the Walrus PII blob
// renewal cron's selection + drain logic. The June 2026 GTM audit (HIGH)
// flagged that PII blobs expire on a WALRUS_STORAGE_EPOCHS timer while the
// on-chain anchors referencing them live forever. These tests pin the
// fixed contract: a blob within RENEWAL_THRESHOLD_EPOCHS (or with unknown
// expiry) is renewed, a fresh blob is skipped, the index update is driven
// off the re-store result, and overlapping runs cannot double-renew a row.
//
// October 2026: the run compared end epochs with the Sui epoch, so every
// lease looked expired. It now takes the Walrus epoch, refuses one that isn't
// a whole number, renews the most urgent leases first (so a capped or timed-
// out run never starves a row), and flags renewals whose new lease is too
// short to have been measured against the same clock.

import {
  decideRenewal,
  runWalrusRenewal,
  DEFAULT_RENEWAL_THRESHOLD_EPOCHS,
  type RenewableLink,
  type RenewalDeps,
  type RestoreResult,
} from '../walrus-renewal';
import { PiiKeyErasedError, PiiKeyReadError } from '../pii-key-errors';

function link(overrides: Partial<RenewableLink> = {}): RenewableLink {
  return {
    id: overrides.id ?? 1,
    circleId: overrides.circleId ?? '0xcircle',
    walrusBlobId: overrides.walrusBlobId ?? 'blob-old',
    // Not `??`: an explicit null (expiry unknown) must stay null.
    walrusEndEpoch: overrides.walrusEndEpoch === undefined ? 100 : overrides.walrusEndEpoch,
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

  it('marks a blob already past expiry (negative remaining) as lapsed, still to renew', () => {
    expect(decideRenewal({ walrusEndEpoch: 95 }, 100, 2)).toEqual({
      action: 'renew',
      reason: 'lapsed',
    });
  });

  it('treats a lease ending at the current epoch as lapsed (end epochs are exclusive)', () => {
    expect(decideRenewal({ walrusEndEpoch: 100 }, 100, 2)).toEqual({
      action: 'renew',
      reason: 'lapsed',
    });
    expect(decideRenewal({ walrusEndEpoch: 101 }, 100, 2)).toEqual({
      action: 'renew',
      reason: 'within_threshold',
    });
  });

  it('skips a lease stored for 5 epochs at the current Walrus epoch', () => {
    // Testnet 2026-10-02: Walrus epoch 538, so a fresh 5-epoch lease ends at
    // 543. Against the Sui epoch (1240) the same lease looked long lapsed.
    expect(decideRenewal({ walrusEndEpoch: 543 }, 538, 2)).toEqual({
      action: 'skip',
      reason: 'fresh',
    });
    expect(decideRenewal({ walrusEndEpoch: 543 }, 1240, 2).action).toBe('renew');
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
    getCurrentWalrusEpoch: async () => currentEpoch,
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
    expect(result.deferred).toBe(1);
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

describe('runWalrusRenewal epoch handling', () => {
  it('reads the Walrus epoch before listing any link, and reports it', async () => {
    const calls: string[] = [];
    const result = await runWalrusRenewal({
      getCurrentWalrusEpoch: async () => {
        calls.push('epoch');
        return 538;
      },
      listActiveLinks: async () => {
        calls.push('list');
        return [];
      },
      restoreBlob: async () => {
        throw new Error('no link to restore');
      },
      applyRenewal: async () => true,
    });

    expect(calls).toEqual(['epoch', 'list']);
    expect(result).toMatchObject({ walrusEpoch: 538, considered: 0, renewed: 0 });
  });

  it('fails without listing or renewing anything when the epoch read fails', async () => {
    const list = jest.fn(async () => [link({ walrusEndEpoch: 100 })]);
    const restore = jest.fn();

    await expect(
      runWalrusRenewal({
        getCurrentWalrusEpoch: async () => {
          throw new Error('Walrus System object unreadable');
        },
        listActiveLinks: list,
        restoreBlob: restore,
        applyRenewal: async () => true,
      }),
    ).rejects.toThrow('Walrus System object unreadable');
    expect(list).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
  });

  it.each([NaN, Infinity, -1, 538.5])(
    'refuses an epoch that is not a whole number (%p) and renews nothing',
    async (epoch) => {
      const list = jest.fn(async () => [link({ walrusEndEpoch: 100 })]);
      const restore = jest.fn();

      await expect(
        runWalrusRenewal({
          getCurrentWalrusEpoch: async () => epoch,
          listActiveLinks: list,
          restoreBlob: restore,
          applyRenewal: async () => true,
        }),
      ).rejects.toThrow(/must be a whole number.*Nothing was renewed/);
      expect(list).not.toHaveBeenCalled();
      expect(restore).not.toHaveBeenCalled();
    },
  );
});

describe('runWalrusRenewal selection order', () => {
  // Walrus epoch 100, threshold 2. Listed out of id order on purpose.
  const mixed = () => [
    link({ id: 1, walrusBlobId: 'lapsed-long-ago', walrusEndEpoch: 90 }),
    link({ id: 2, walrusBlobId: 'unknown', walrusEndEpoch: null }),
    link({ id: 3, walrusBlobId: 'two-left', walrusEndEpoch: 102 }),
    link({ id: 4, walrusBlobId: 'fresh', walrusEndEpoch: 200 }),
    link({ id: 5, walrusBlobId: 'just-lapsed', walrusEndEpoch: 99 }),
    link({ id: 7, walrusBlobId: 'one-left-b', walrusEndEpoch: 101 }),
    link({ id: 6, walrusBlobId: 'one-left-a', walrusEndEpoch: 101 }),
  ];

  it('renews live leases soonest-first, then unknown expiries, then lapsed leases latest-first', async () => {
    const h = harness(mixed(), 100, { thresholdEpochs: 2 });

    const result = await runWalrusRenewal(h.deps);

    expect(h.restoreCalls).toEqual([
      'one-left-a', // ties on end epoch go to the lower row id
      'one-left-b',
      'two-left',
      'unknown',
      'just-lapsed',
      'lapsed-long-ago',
    ]);
    expect(result).toMatchObject({
      considered: 7,
      skipped: 1,
      renewed: 6,
      deferred: 0,
      capped: false,
    });
  });

  it('spends a capped run on the leases closest to running out', async () => {
    const h = harness(mixed(), 100, { thresholdEpochs: 2, maxRenewalsPerRun: 3 });

    const result = await runWalrusRenewal(h.deps);

    expect(h.restoreCalls).toEqual(['one-left-a', 'one-left-b', 'two-left']);
    expect(result).toMatchObject({ renewed: 3, capped: true, deferred: 3 });
  });

  it('does not let blobs that fail every run use up the cap before a live one', async () => {
    // Ordered by id, the two lapsed rows would take the whole cap of 2 on
    // every run and the live lease (highest id) would never be renewed.
    const links = [
      link({ id: 1, walrusBlobId: 'gone-1', walrusEndEpoch: 90 }),
      link({ id: 2, walrusBlobId: 'gone-2', walrusEndEpoch: 95 }),
      link({ id: 3, walrusBlobId: 'legacy', walrusEndEpoch: null }),
      link({ id: 4, walrusBlobId: 'live', walrusEndEpoch: 101 }),
    ];
    const h = harness(links, 100, {
      thresholdEpochs: 2,
      maxRenewalsPerRun: 2,
      restore: async (blobId) => {
        if (blobId !== 'live') throw new Error('aggregator 404');
        return { newBlobId: 'live-renewed', newEndEpoch: 105 };
      },
    });

    const result = await runWalrusRenewal(h.deps);

    expect(h.restoreCalls).toEqual(['live', 'legacy']);
    expect(result).toMatchObject({ renewed: 1, failed: 1, capped: true, deferred: 2 });
  });

  it('rotates a backlog through capped runs until every due row is renewed', async () => {
    const epoch = 100;
    const index = new Map<number, RenewableLink>(
      [
        link({ id: 1, walrusBlobId: 'b1', walrusEndEpoch: 102 }),
        link({ id: 2, walrusBlobId: 'b2', walrusEndEpoch: 101 }),
        link({ id: 3, walrusBlobId: 'b3', walrusEndEpoch: 102 }),
        link({ id: 4, walrusBlobId: 'b4', walrusEndEpoch: 101 }),
        link({ id: 5, walrusBlobId: 'b5', walrusEndEpoch: 102 }),
      ].map((row) => [row.id, row]),
    );
    const renewedPerRun: number[][] = [];

    for (let run = 0; run < 4; run += 1) {
      const renewedThisRun: number[] = [];
      renewedPerRun.push(renewedThisRun);
      await runWalrusRenewal({
        thresholdEpochs: 2,
        maxRenewalsPerRun: 2,
        getCurrentWalrusEpoch: async () => epoch,
        listActiveLinks: async () => [...index.values()].sort((a, b) => a.id - b.id),
        restoreBlob: async (blobId) => ({ newBlobId: `${blobId}+`, newEndEpoch: epoch + 5 }),
        applyRenewal: async ({ id, expectedBlobId, newBlobId, newEndEpoch }) => {
          const row = index.get(id);
          if (!row || row.walrusBlobId !== expectedBlobId) return false;
          index.set(id, { ...row, walrusBlobId: newBlobId, walrusEndEpoch: newEndEpoch });
          renewedThisRun.push(id);
          return true;
        },
      });
    }

    expect(renewedPerRun).toEqual([[2, 4], [1, 3], [5], []]);
    expect([...index.values()].map((row) => row.walrusEndEpoch)).toEqual([105, 105, 105, 105, 105]);
  });

  it('starts no renewal after the deadline and reports what it left', async () => {
    let clock = 1_000;
    const links = [
      link({ id: 1, walrusBlobId: 'a', walrusEndEpoch: 101 }),
      link({ id: 2, walrusBlobId: 'b', walrusEndEpoch: 101 }),
      link({ id: 3, walrusBlobId: 'c', walrusEndEpoch: 102 }),
    ];
    const h = harness(links, 100, {
      thresholdEpochs: 2,
      restore: async (blobId) => {
        clock += 30_000; // a slow upload
        return { newBlobId: `${blobId}-renewed`, newEndEpoch: 105 };
      },
    });

    const result = await runWalrusRenewal({
      ...h.deps,
      deadlineMs: 1_000 + 45_000,
      now: () => clock,
    });

    // 'a' starts at t=1s and 'b' at t=31s; at t=61s the deadline has passed.
    expect(h.restoreCalls).toEqual(['a', 'b']);
    expect(result).toMatchObject({ renewed: 2, capped: true, deferred: 1 });
  });
});

describe('runWalrusRenewal lease mismatches', () => {
  it('counts a renewal whose new lease ends within the threshold, and still applies it', async () => {
    const links = [link({ id: 1, walrusBlobId: 'blob', walrusEndEpoch: 539 })];
    const h = harness(links, 538, {
      thresholdEpochs: 2,
      restore: async () => ({ newBlobId: 'blob-2', newEndEpoch: 540 }),
    });

    const result = await runWalrusRenewal(h.deps);

    expect(result).toMatchObject({ renewed: 1, leaseMismatches: 1 });
    expect(h.applyCalls).toEqual([
      { id: 1, expectedBlobId: 'blob', newBlobId: 'blob-2', newEndEpoch: 540 },
    ]);
  });

  it('flags a Sui epoch passed off as the Walrus epoch on its first renewal', async () => {
    // Against Sui epoch 1240 a lease ending at Walrus epoch 543 looks lapsed,
    // and its renewal (stored at Walrus 538 for 5 epochs) ends at 543 again.
    const links = [link({ id: 1, walrusBlobId: 'blob', walrusEndEpoch: 543 })];
    const h = harness(links, 1240, {
      thresholdEpochs: 2,
      restore: async () => ({ newBlobId: 'blob-2', newEndEpoch: 543 }),
    });

    const result = await runWalrusRenewal(h.deps);

    expect(result).toMatchObject({ renewed: 1, leaseMismatches: 1 });
  });

  it('does not flag normal renewals, including one stored after an epoch change', async () => {
    const links = [
      link({ id: 1, walrusBlobId: 'a', walrusEndEpoch: 539 }),
      link({ id: 2, walrusBlobId: 'b', walrusEndEpoch: 540 }),
    ];
    const newEnds = [543, 544]; // the second upload landed in epoch 539
    const h = harness(links, 538, {
      thresholdEpochs: 2,
      restore: async (blobId) => ({ newBlobId: `${blobId}-2`, newEndEpoch: newEnds.shift() ?? 0 }),
    });

    const result = await runWalrusRenewal(h.deps);

    expect(result).toMatchObject({ renewed: 2, leaseMismatches: 0 });
  });
});

describe('runWalrusRenewal and erased links (per-link data keys)', () => {
  const erasedKid = 'ef'.repeat(16);

  it('counts a link whose data key was deleted as erased, renews nothing for it, and drops its row', async () => {
    const links = [
      link({ id: 1, walrusBlobId: 'erased', walrusEndEpoch: 100 }),
      link({ id: 2, walrusBlobId: 'live', walrusEndEpoch: 100 }),
    ];
    const dropped: Array<{ id: number; expectedBlobId: string }> = [];
    const h = harness(links, 100, {
      thresholdEpochs: 2,
      restore: async (blobId) => {
        if (blobId === 'erased') throw new PiiKeyErasedError(erasedKid);
        return { newBlobId: `${blobId}-renewed`, newEndEpoch: 150 };
      },
    });
    h.deps.dropErasedLink = async (params) => {
      dropped.push(params);
      return true;
    };

    const result = await runWalrusRenewal(h.deps);

    expect(result).toMatchObject({ renewed: 1, erased: 1, failed: 0 });
    expect(h.applyCalls.map((c) => c.expectedBlobId)).toEqual(['live']);
    expect(dropped).toEqual([{ id: 1, expectedBlobId: 'erased' }]);
  });

  it('still counts a failed key-store read as a failure, never as erased', async () => {
    const links = [link({ id: 1, walrusBlobId: 'blob', walrusEndEpoch: 100 })];
    const drop = jest.fn(async () => true);
    const h = harness(links, 100, {
      thresholdEpochs: 2,
      restore: async () => {
        throw new PiiKeyReadError('Could not read the data key: Connection terminated unexpectedly');
      },
    });
    h.deps.dropErasedLink = drop;

    const result = await runWalrusRenewal(h.deps);

    expect(result).toMatchObject({ erased: 0, failed: 1 });
    expect(drop).not.toHaveBeenCalled();
  });

  it('keeps going when dropping an erased row fails', async () => {
    const links = [
      link({ id: 1, walrusBlobId: 'erased', walrusEndEpoch: 100 }),
      link({ id: 2, walrusBlobId: 'live', walrusEndEpoch: 100 }),
    ];
    const h = harness(links, 100, {
      thresholdEpochs: 2,
      restore: async (blobId) => {
        if (blobId === 'erased') throw new PiiKeyErasedError(erasedKid);
        return { newBlobId: `${blobId}-renewed`, newEndEpoch: 150 };
      },
    });
    h.deps.dropErasedLink = async () => {
      throw new Error('db down');
    };

    const result = await runWalrusRenewal(h.deps);

    expect(result).toMatchObject({ renewed: 1, erased: 1, failed: 0 });
  });

  it('counts erased links against the per-run cap', async () => {
    const links = [
      link({ id: 1, walrusBlobId: 'erased', walrusEndEpoch: 100 }),
      link({ id: 2, walrusBlobId: 'live', walrusEndEpoch: 100 }),
    ];
    const h = harness(links, 100, {
      thresholdEpochs: 2,
      maxRenewalsPerRun: 1,
      restore: async (blobId) => {
        if (blobId === 'erased') throw new PiiKeyErasedError(erasedKid);
        return { newBlobId: `${blobId}-renewed`, newEndEpoch: 150 };
      },
    });

    const result = await runWalrusRenewal(h.deps);

    expect(result).toMatchObject({ erased: 1, renewed: 0, capped: true, deferred: 1 });
  });
});
