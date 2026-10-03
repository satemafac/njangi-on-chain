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
import { readFileSync } from 'fs';
import { join } from 'path';
import type { SuiClient } from '@mysten/sui/client';
import {
  claimStructType,
  claimWindowClosed,
  findRecipientClaim,
  MAX_CLAIM_PAGES,
  resolveCollectRoute,
  resolveEscrowStage,
  resolveExpiredClaimRefundAccess,
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
    claimExpiresAtMs: 0,
    ...over,
  });

  describe('claim window', () => {
    // Finalized by someone else; the claim window ends at EXPIRES.
    const EXPIRES = 1_793_926_356_233;
    const settled = state({ finalized: true, claimExpiresAtMs: EXPIRES });
    const stageAt = (chainNowMs: number | null | undefined, s = settled) =>
      resolveEscrowStage({ loading: false, state: s, paidSoFar: 2, totalRequired: 2, chainNowMs });

    it('is claim-expired once the chain clock passes the expiry', () => {
      expect(stageAt(EXPIRES + 1)).toBe('claim-expired');
    });

    it('still waits for the recipient on the expiry ms itself (redeem pays through it)', () => {
      expect(stageAt(EXPIRES)).toBe('full-waiting-for-claim');
      expect(stageAt(EXPIRES - 86_400_000)).toBe('full-waiting-for-claim');
    });

    it('never calls the window closed without a chain clock reading', () => {
      // A device clock is never consulted, and an unread chain clock is unknown.
      expect(stageAt(null)).toBe('full-waiting-for-claim');
      expect(stageAt(undefined)).toBe('full-waiting-for-claim');
    });

    it('never calls it closed when the escrow records no expiry', () => {
      expect(stageAt(EXPIRES + 1, state({ finalized: true, claimExpiresAtMs: 0 }))).toBe(
        'full-waiting-for-claim',
      );
    });

    it('lets collected and refunded rounds keep their own stages', () => {
      expect(stageAt(EXPIRES + 1, { ...settled, claimed: true })).toBe('completed');
      expect(stageAt(EXPIRES + 1, { ...settled, refunded: true })).toBe('refunded');
    });
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

describe('claimWindowClosed', () => {
  const EXPIRES = 1_793_926_356_233;
  const running = { finalized: true, claimed: false, refunded: false, claimExpiresAtMs: EXPIRES };

  it('is true strictly after the expiry, false up to it', () => {
    expect(claimWindowClosed(running, EXPIRES + 1)).toBe(true);
    expect(claimWindowClosed(running, EXPIRES)).toBe(false);
  });

  it('is unknown (null) while a window runs but the chain clock is unread', () => {
    expect(claimWindowClosed(running, null)).toBeNull();
  });

  it('is unknown when a running window has no recorded expiry', () => {
    expect(claimWindowClosed({ ...running, claimExpiresAtMs: 0 }, EXPIRES + 1)).toBeNull();
  });

  it('is false when no window is running at all', () => {
    expect(claimWindowClosed({ ...running, finalized: false, claimExpiresAtMs: 0 }, null)).toBe(false);
    expect(claimWindowClosed({ ...running, claimed: true }, EXPIRES + 1)).toBe(false);
    expect(claimWindowClosed({ ...running, refunded: true }, EXPIRES + 1)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Expired claim — who is offered "Send the contributions back"
// ---------------------------------------------------------------------------

describe('resolveExpiredClaimRefundAccess', () => {
  // The production circle's rotation: the admin, MEMBER-1 and this round's
  // recipient. Only the admin has paid in so far.
  const ADMIN = '0xe833deaa9c038ac2edd397323ed5dbde1e622aadfd0d526332a214a31f9de17d';
  const MEMBER = '0xdf98684462fb5b3e85dffcc34fda108b7c34e7da37ab88f0ae3a530ef804a97d';
  const MEMBERS = [ADMIN, MEMBER, RECIPIENT];
  const access = (over: Partial<Parameters<typeof resolveExpiredClaimRefundAccess>[0]> = {}) =>
    resolveExpiredClaimRefundAccess({
      userAddress: MEMBER,
      isAdmin: false,
      members: MEMBERS,
      contributors: [ADMIN],
      ...over,
    });

  it('offers it to every member of the round, never only to the admin', () => {
    expect(access({ userAddress: MEMBER })).toBe('offer'); // has not paid in
    expect(access({ userAddress: RECIPIENT })).toBe('offer');
    expect(access({ userAddress: ADMIN })).toBe('offer'); // as a member, without the flag
  });

  it('offers it to the admin even when the member list did not come back', () => {
    expect(access({ userAddress: ADMIN, isAdmin: true, members: [], contributors: [] })).toBe(
      'offer',
    );
  });

  it('hides it from a signed-in viewer the member list does not name', () => {
    expect(access({ userAddress: STRANGER })).toBe('not-member');
  });

  it('neither offers nor hides it when the member list did not come back', () => {
    // A real round always names at least two members, so empty is unreadable.
    expect(access({ userAddress: STRANGER, members: [] })).toBe('unknown');
    expect(access({ userAddress: MEMBER, members: null })).toBe('unknown');
    expect(access({ userAddress: MEMBER, members: undefined })).toBe('unknown');
  });

  it('takes a recorded contributor as a member even without the list', () => {
    // `contribute` aborts 200 for anyone off the snapshot list.
    expect(access({ userAddress: ADMIN, members: [] })).toBe('offer');
  });

  it('matches addresses however they are padded or cased', () => {
    const padded = '0x0000' + 'ab'.repeat(30);
    const short = '0x' + 'AB'.repeat(30);
    expect(access({ userAddress: short, members: [ADMIN, padded] })).toBe('offer');
    expect(access({ userAddress: MEMBER.toUpperCase().replace('0X', '0x') })).toBe('offer');
  });

  it('has nobody to check while signed out', () => {
    expect(access({ userAddress: null })).toBe('signed-out');
  });
});

describe('CycleEscrowPanel offers "Send the contributions back" by that rule', () => {
  // Jest runs node-only `.test.ts` files (no jsdom), so the render rule is
  // pinned on the source, the same technique as copy-guards.test.ts.
  const panel = readFileSync(join(process.cwd(), 'src/components/CycleEscrowPanel.tsx'), 'utf8');

  it('renders the one send-back button only when the rule offers it', () => {
    expect(panel).toContain('resolveExpiredClaimRefundAccess(');
    expect(panel.match(/onClick=\{onSendContributionsBack\}/g)).toHaveLength(1);
    expect(panel).toMatch(
      /refundAccess === 'offer' \? \(\s*<button\s+type="button"\s+onClick=\{onSendContributionsBack\}/,
    );
  });

  it('says so when membership could not be checked, instead of hiding it silently', () => {
    expect(panel).toMatch(/refundAccess === 'unknown' \? \([\s\S]{0,200}escrow\.sendBack\.membershipUnknown/);
  });

  it('refuses the refund in the handler too, for anyone the rule does not offer it to', () => {
    expect(panel).toMatch(
      /const onSendContributionsBack = useCallback\(\(\) => \{\s*if \(!summary \|\| refundAccess !== 'offer'\) return;/,
    );
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
