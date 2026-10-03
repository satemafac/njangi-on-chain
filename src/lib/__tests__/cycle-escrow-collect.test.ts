/**
 * Collect on a round someone else already finalized.
 *
 * `finalize_to_recipient<T>` is permissionless: anyone can settle a full
 * pot, which mints a `Claim<T>` to the recipient and sets `finalized` while
 * `claimed` stays false. Collect used to build `finalize_and_redeem*`
 * regardless, which re-mints the claim and aborts 205 E_ALREADY_FINALIZED
 * (confirmed by devInspect against testnet v9, 2026-10-02), so the recipient
 * faced a Collect button that could not work until the 30-day claim window
 * returned the pot to the contributors.
 *
 * These pin the three decisions the fix rests on: which stage such an
 * escrow renders, which transaction Collect builds for it, and how the
 * recipient's Claim is found — with a failed read kept apart from "no claim".
 */
import type { SuiClient } from '@mysten/sui/client';
import {
  claimStructType,
  findRecipientClaim,
  MAX_CLAIM_PAGES,
  resolveCollectRoute,
  resolveEscrowStage,
  type CollectRouteState,
  type EscrowStageState,
} from '@/lib/cycle-escrow-collect';

// Testnet lineage as published: `Claim` is defined by the ORIGINAL package
// (the live package's type origin table names it), calls go to v9.
const ORIGINAL_PKG = '0x89cddf4dfe654e7c7b16333096d9e750cf04bb96f7de934403a512d460594f02';
const PUBLISHED_AT = '0xf8afd3dfcf94f152ec9d1f8cb870b77525353a20564bb0224bcad5520d621614';
const USDC =
  '0x26b3bc67befc214058ca78ea9a2690298d731a2d4309485ec3d40198063c4abc::usdc::USDC';
const CLAIM_TYPE = `${ORIGINAL_PKG}::njangi_cycle_escrow::Claim<${USDC}>`;

// Production circle 0xa3fada…675ed's lap-5 escrow and its recipient.
const ESCROW = '0xe30c91fee48d74587d6dc549b301f8c7424031116e7c8d8cefaf410c3894fbe0';
const OTHER_ESCROW = '0x970d794d' + 'ab'.repeat(28);
const RECIPIENT = '0x1f8d4bdfa384503b0901c73c9925c5b29dad510766542a30dc3b6904ddba897b';
const STRANGER = '0x' + '57'.repeat(32);
const CYCLE = 5;

// ---------------------------------------------------------------------------
// Stage
// ---------------------------------------------------------------------------

describe('resolveEscrowStage', () => {
  const state = (over: Partial<EscrowStageState> = {}): EscrowStageState => ({
    finalized: false,
    claimed: false,
    refunded: false,
    ...over,
  });

  it('shows the third-party-finalized escrow as waiting for its recipient', () => {
    // The flag alone decides: a finalized escrow is full by definition.
    expect(
      resolveEscrowStage({
        loading: false,
        state: state({ finalized: true }),
        paidSoFar: 0,
        totalRequired: 2,
      }),
    ).toBe('full-waiting-for-claim');
  });

  it('shows a full, unfinalized pot as waiting for its recipient', () => {
    expect(
      resolveEscrowStage({ loading: false, state: state(), paidSoFar: 2, totalRequired: 2 }),
    ).toBe('full-waiting-for-claim');
  });

  it('keeps a partly paid pot in progress, and never calls a zero-requirement pot full', () => {
    expect(
      resolveEscrowStage({ loading: false, state: state(), paidSoFar: 1, totalRequired: 2 }),
    ).toBe('in-progress');
    expect(
      resolveEscrowStage({ loading: false, state: state(), paidSoFar: 0, totalRequired: 0 }),
    ).toBe('in-progress');
  });

  it('puts terminal states first: refunded, then claimed', () => {
    expect(
      resolveEscrowStage({
        loading: false,
        state: state({ finalized: true, refunded: true }),
        paidSoFar: 2,
        totalRequired: 2,
      }),
    ).toBe('refunded');
    expect(
      resolveEscrowStage({
        loading: false,
        state: state({ finalized: true, claimed: true }),
        paidSoFar: 2,
        totalRequired: 2,
      }),
    ).toBe('completed');
  });

  it('says loading while loading, and no-round-open without an escrow', () => {
    expect(
      resolveEscrowStage({ loading: true, state: state(), paidSoFar: 2, totalRequired: 2 }),
    ).toBe('loading');
    expect(
      resolveEscrowStage({ loading: false, state: null, paidSoFar: 0, totalRequired: 0 }),
    ).toBe('no-round-open');
  });
});

// ---------------------------------------------------------------------------
// Collect route
// ---------------------------------------------------------------------------

describe('resolveCollectRoute', () => {
  const state = (over: Partial<CollectRouteState> = {}): CollectRouteState => ({
    finalized: false,
    claimed: false,
    refunded: false,
    requiresAttestation: false,
    ...over,
  });

  it('redeems the existing claim once someone else has finalized the escrow', () => {
    // finalize_and_redeem* here would abort 205 E_ALREADY_FINALIZED.
    expect(resolveCollectRoute(state({ finalized: true }))).toEqual({ kind: 'redeem-claim' });
  });

  it('finalizes and redeems in one PTB while the escrow is unfinalized, gated or not', () => {
    expect(resolveCollectRoute(state())).toEqual({ kind: 'finalize-and-redeem' });
    expect(resolveCollectRoute(state({ requiresAttestation: true }))).toEqual({
      kind: 'finalize-and-redeem',
    });
  });

  it('refuses a gated finalized escrow rather than redeem it without the attestation check', () => {
    // Unreachable on chain (both claim-leaving finalize paths abort 216 on a
    // gated escrow), and redeem_claim has no gated wrapper to fall back on.
    expect(resolveCollectRoute(state({ finalized: true, requiresAttestation: true }))).toEqual({
      kind: 'none',
      reason: 'gated-claim',
    });
  });

  it('offers nothing for a claimed or refunded escrow', () => {
    expect(resolveCollectRoute(state({ finalized: true, claimed: true }))).toEqual({
      kind: 'none',
      reason: 'claimed',
    });
    expect(resolveCollectRoute(state({ refunded: true }))).toEqual({
      kind: 'none',
      reason: 'refunded',
    });
    expect(resolveCollectRoute(state({ finalized: true, refunded: true }))).toEqual({
      kind: 'none',
      reason: 'refunded',
    });
  });

  describe('once the package that collects a finalized escrow is live (flag on)', () => {
    const on = { finalizedCollect: true };

    it('collects a third-party-finalized escrow with the one-step call, no Claim lookup', () => {
      expect(resolveCollectRoute(state({ finalized: true }), on)).toEqual({
        kind: 'finalize-and-redeem',
      });
    });

    it('sends a gated finalized escrow through the attested one-step call instead of refusing it', () => {
      expect(
        resolveCollectRoute(state({ finalized: true, requiresAttestation: true }), on),
      ).toEqual({ kind: 'finalize-and-redeem' });
    });

    it('leaves the unfinalized path as it was', () => {
      expect(resolveCollectRoute(state(), on)).toEqual({ kind: 'finalize-and-redeem' });
    });

    it('still offers nothing for a claimed or refunded escrow', () => {
      expect(resolveCollectRoute(state({ finalized: true, claimed: true }), on)).toEqual({
        kind: 'none',
        reason: 'claimed',
      });
      expect(resolveCollectRoute(state({ finalized: true, refunded: true }), on)).toEqual({
        kind: 'none',
        reason: 'refunded',
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Claim lookup
// ---------------------------------------------------------------------------

const claimObject = (opts: {
  id: string;
  escrowId?: string;
  cycleNo?: number;
  recipient?: string;
  type?: string;
}) => {
  const type = opts.type ?? CLAIM_TYPE;
  return {
    data: {
      objectId: opts.id,
      version: '1',
      digest: 'digest',
      type,
      content: {
        dataType: 'moveObject',
        type,
        hasPublicTransfer: true,
        fields: {
          id: { id: opts.id },
          escrow_id: opts.escrowId ?? ESCROW,
          cycle_no: String(opts.cycleNo ?? CYCLE),
          recipient: opts.recipient ?? RECIPIENT,
          amount: '200000',
          expires_at_ms: '1793926356233',
        },
      },
    },
  };
};

const page = (
  data: unknown[],
  opts: { hasNextPage?: boolean; nextCursor?: string | null } = {},
) => ({
  data,
  hasNextPage: opts.hasNextPage ?? false,
  nextCursor: opts.nextCursor ?? null,
});

function clientReturning(...pages: unknown[]) {
  const getOwnedObjects = jest.fn();
  for (const p of pages) {
    if (p instanceof Error) getOwnedObjects.mockRejectedValueOnce(p);
    else getOwnedObjects.mockResolvedValueOnce(p);
  }
  return { client: { getOwnedObjects } as unknown as SuiClient, getOwnedObjects };
}

const lookup = (client: SuiClient, over: Partial<Parameters<typeof findRecipientClaim>[0]> = {}) =>
  findRecipientClaim({
    client,
    network: 'testnet',
    owner: RECIPIENT,
    escrowId: ESCROW,
    cycleNo: CYCLE,
    coinType: USDC,
    ...over,
  });

describe('claimStructType', () => {
  it('anchors the filter to the original package, not the published-at calls go to', () => {
    const type = claimStructType('testnet', USDC);
    expect(type).toBe(CLAIM_TYPE);
    expect(type).not.toContain(PUBLISHED_AT);
  });
});

describe('findRecipientClaim', () => {
  beforeEach(() => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it("filters the owner's objects by the exact Claim<T> type", async () => {
    const { client, getOwnedObjects } = clientReturning(page([]));
    await lookup(client);
    expect(getOwnedObjects).toHaveBeenCalledWith({
      owner: RECIPIENT,
      filter: { StructType: CLAIM_TYPE },
      options: { showType: true, showContent: true },
      cursor: undefined,
    });
  });

  it("finds this escrow's claim among the owner's other claims", async () => {
    const { client } = clientReturning(
      page([
        claimObject({ id: '0xc1', escrowId: OTHER_ESCROW }),
        claimObject({ id: '0xc2' }),
      ]),
    );
    await expect(lookup(client)).resolves.toEqual({
      kind: 'found',
      claim: {
        claimId: '0xc2',
        escrowId: ESCROW,
        cycleNo: CYCLE,
        recipient: RECIPIENT,
        amount: '200000',
        expiresAtMs: 1793926356233,
      },
    });
  });

  it('matches ids however they are padded or cased', async () => {
    const unpadded = '0x' + ESCROW.slice(2).replace(/^0+/, '').toUpperCase();
    const { client } = clientReturning(page([claimObject({ id: '0xc2', escrowId: unpadded })]));
    await expect(lookup(client)).resolves.toMatchObject({ kind: 'found' });
  });

  it('follows the cursor to later pages', async () => {
    const { client, getOwnedObjects } = clientReturning(
      page([claimObject({ id: '0xc1', escrowId: OTHER_ESCROW })], {
        hasNextPage: true,
        nextCursor: 'cursor-1',
      }),
      page([claimObject({ id: '0xc2' })]),
    );
    await expect(lookup(client)).resolves.toMatchObject({
      kind: 'found',
      claim: { claimId: '0xc2' },
    });
    expect(getOwnedObjects).toHaveBeenCalledTimes(2);
    expect(getOwnedObjects.mock.calls[1][0]).toMatchObject({ cursor: 'cursor-1' });
  });

  it('reports absent only after reading the whole listing', async () => {
    const { client } = clientReturning(
      page([claimObject({ id: '0xc1', escrowId: OTHER_ESCROW })], {
        hasNextPage: true,
        nextCursor: 'cursor-1',
      }),
      page([]),
    );
    await expect(lookup(client)).resolves.toEqual({ kind: 'absent' });
  });

  it('reports a failed read as unknown, never as absent', async () => {
    const { client } = clientReturning(new Error('Unexpected status code: 429'));
    await expect(lookup(client)).resolves.toEqual({ kind: 'unknown' });
  });

  it('reports a failure on a later page as unknown', async () => {
    const { client } = clientReturning(
      page([claimObject({ id: '0xc1', escrowId: OTHER_ESCROW })], {
        hasNextPage: true,
        nextCursor: 'cursor-1',
      }),
      new Error('fetch failed'),
    );
    await expect(lookup(client)).resolves.toEqual({ kind: 'unknown' });
  });

  it('treats a listed object whose contents did not come back as unknown', async () => {
    const { client } = clientReturning(
      page([
        { error: { code: 'deleted', object_id: '0xc9' } },
        { data: { objectId: '0xc8', version: '1', digest: 'd', type: CLAIM_TYPE } },
      ]),
    );
    await expect(lookup(client)).resolves.toEqual({ kind: 'unknown' });
  });

  it('still returns the claim when an unrelated listed object was unreadable', async () => {
    const { client } = clientReturning(
      page([{ error: { code: 'deleted', object_id: '0xc9' } }, claimObject({ id: '0xc2' })]),
    );
    await expect(lookup(client)).resolves.toMatchObject({ kind: 'found' });
  });

  it('treats a listing that claims more pages but gives no cursor as unknown', async () => {
    const { client } = clientReturning(page([], { hasNextPage: true, nextCursor: null }));
    await expect(lookup(client)).resolves.toEqual({ kind: 'unknown' });
  });

  it(`stops after ${MAX_CLAIM_PAGES} pages and says unknown, not absent`, async () => {
    const pages = Array.from({ length: MAX_CLAIM_PAGES }, (_, i) =>
      page([claimObject({ id: `0xc${i}`, escrowId: OTHER_ESCROW })], {
        hasNextPage: true,
        nextCursor: `cursor-${i}`,
      }),
    );
    const { client, getOwnedObjects } = clientReturning(...pages);
    await expect(lookup(client)).resolves.toEqual({ kind: 'unknown' });
    expect(getOwnedObjects).toHaveBeenCalledTimes(MAX_CLAIM_PAGES);
  });

  it('never hands over a claim whose cycle differs from the escrow (redeem would abort 210)', async () => {
    const { client } = clientReturning(page([claimObject({ id: '0xc2', cycleNo: CYCLE + 1 })]));
    await expect(lookup(client)).resolves.toEqual({ kind: 'absent' });
    expect(console.error).toHaveBeenCalled();
  });

  it('never hands over a claim made out to someone else (redeem would abort 207)', async () => {
    const { client } = clientReturning(page([claimObject({ id: '0xc2', recipient: STRANGER })]));
    await expect(lookup(client)).resolves.toEqual({ kind: 'absent' });
  });

  it("ignores a look-alike Claim from another package if the endpoint ignored the filter", async () => {
    const imposter = `0x${'dd'.repeat(32)}::njangi_cycle_escrow::Claim<${USDC}>`;
    const { client } = clientReturning(page([claimObject({ id: '0xc2', type: imposter })]));
    await expect(lookup(client)).resolves.toEqual({ kind: 'absent' });
  });
});
