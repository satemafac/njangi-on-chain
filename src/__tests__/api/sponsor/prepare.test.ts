/**
 * /api/sponsor/prepare — the broker that decides whether a member's gas is
 * paid by the circle admin's Premium subscription.
 *
 * Written because sponsorship for security deposits was deterministically
 * impossible and nothing noticed. The broker passed the Circle id as
 * `escrowId`, so the resolver looked for a `circle_id` field that only
 * CycleEscrow carries (njangi_cycle_escrow.move:101-103) and never Circle
 * (njangi_circles.move:110-129). Every deposit resolved `no_circle_id`,
 * prepare returned a 200 decline, and the client fell back to self-paid gas
 * in silence. The feature looked switched on and did nothing — and the
 * security deposit is exactly the case sponsorship exists for, since a
 * brand-new member may hold no SUI at all.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { Transaction } from '@mysten/sui/transactions';
import { toBase64 } from '@mysten/sui/utils';
import handler from '@/pages/api/sponsor/prepare';
import { getZkLoginSessionAccount } from '@/lib/zklogin-session-registry';
import { resolveEscrowSponsorship } from '@/lib/gas-sponsorship-eligibility';
import { reservePendingSponsorship } from '@/lib/gas-sponsorship';
import { isPostgresConfigured } from '@/lib/pg-pool';

const PKG = '0x' + '11'.repeat(32);
const CIRCLE_ID = '0x' + 'ce'.repeat(32);
const OTHER_CIRCLE_ID = '0x' + 'aa'.repeat(32);
const USER = '0x' + 'bb'.repeat(32);
const CLOCK = '0x0000000000000000000000000000000000000000000000000000000000000006';

jest.mock('@/lib/zklogin-session-registry', () => ({
  getZkLoginSessionAccount: jest.fn(),
}));
jest.mock('@/lib/gas-sponsorship-eligibility', () => ({
  resolveEscrowSponsorship: jest.fn(),
}));
jest.mock('@/lib/gas-sponsorship', () => ({
  allowedMoveCallTargets: jest.fn(() => [
    `${'0x' + '11'.repeat(32)}::njangi_circles::member_deposit_security_deposit`,
  ]),
  reservePendingSponsorship: jest.fn(),
  purgeExpiredSponsorships: jest.fn(),
}));
jest.mock('@/lib/pg-pool', () => ({ isPostgresConfigured: jest.fn() }));
jest.mock('@/services/network-config', () => ({
  getCurrentNetwork: jest.fn(() => 'testnet'),
  getNetworkConfig: jest.fn(() => ({
    packageId: '0x' + '11'.repeat(32),
    enoki: { apiKey: 'enoki_test_key' },
  })),
}));

const createSponsoredTransaction = jest.fn();
jest.mock('@mysten/enoki', () => ({
  EnokiClient: jest.fn().mockImplementation(() => ({
    createSponsoredTransaction: (...args: unknown[]) => createSponsoredTransaction(...args),
  })),
}));

const mockedSession = getZkLoginSessionAccount as jest.MockedFunction<
  typeof getZkLoginSessionAccount
>;
const mockedResolve = resolveEscrowSponsorship as jest.MockedFunction<
  typeof resolveEscrowSponsorship
>;
const mockedReserve = reservePendingSponsorship as jest.MockedFunction<
  typeof reservePendingSponsorship
>;
const mockedPgConfigured = isPostgresConfigured as jest.MockedFunction<
  typeof isPostgresConfigured
>;

/** A deposit kind that genuinely touches the circle object, as the real one does. */
async function depositKindBytes(circleId: string): Promise<string> {
  const tx = new Transaction();
  // Explicit shared refs so the kind builds offline (no client to classify
  // objects). Shape matches the real deposit: circle + clock.
  tx.moveCall({
    target: `${PKG}::njangi_circles::member_deposit_security_deposit`,
    arguments: [
      tx.sharedObjectRef({ objectId: circleId, initialSharedVersion: 1, mutable: true }),
      tx.sharedObjectRef({ objectId: CLOCK, initialSharedVersion: 1, mutable: false }),
    ],
  });
  return toBase64(await tx.build({ onlyTransactionKind: true }));
}

type MockRes = NextApiResponse & { statusCode: number; body: Record<string, unknown> };

function createRes(): MockRes {
  const res = {
    statusCode: 0,
    body: {} as Record<string, unknown>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: Record<string, unknown>) {
      this.body = payload;
      return this;
    },
    setHeader() {
      return this;
    },
  };
  return res as unknown as MockRes;
}

const createReq = (body: unknown): NextApiRequest =>
  ({ method: 'POST', body, cookies: { 'session-id': 'sess' } }) as unknown as NextApiRequest;

describe('/api/sponsor/prepare', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedSession.mockResolvedValue({ sub: 'sub-1', userAddr: USER } as never);
    mockedPgConfigured.mockReturnValue(true);
    mockedReserve.mockResolvedValue(true);
    createSponsoredTransaction.mockResolvedValue({ bytes: 'AAAA', digest: 'dig-1' });
    mockedResolve.mockResolvedValue({
      sponsor: true,
      reason: 'eligible',
      circleId: CIRCLE_ID,
    } as never);
  });

  it('sponsors a security deposit, resolving by circle id rather than escrow id', async () => {
    const res = createRes();
    await handler(
      createReq({
        action: 'paySecurityDeposit',
        kindBytes: await depositKindBytes(CIRCLE_ID),
        context: { circleId: CIRCLE_ID, coinType: 'usdc', usesGasCoinForValue: false },
      }),
      res,
    );

    expect(res.body.sponsored).toBe(true);
    // The bug in one assertion: circleId must reach the resolver, and the
    // Circle id must NOT be smuggled in as escrowId.
    expect(mockedResolve).toHaveBeenCalledWith(
      expect.objectContaining({ circleId: CIRCLE_ID, escrowId: '' }),
    );
  });

  it('attributes the reservation to the resolved circle', async () => {
    const res = createRes();
    await handler(
      createReq({
        action: 'paySecurityDeposit',
        kindBytes: await depositKindBytes(CIRCLE_ID),
        context: { circleId: CIRCLE_ID },
      }),
      res,
    );

    expect(mockedReserve).toHaveBeenCalledWith(
      expect.objectContaining({ circleId: CIRCLE_ID, action: 'paySecurityDeposit' }),
    );
  });

  it('refuses to bill a circle the transaction does not touch', async () => {
    // The session proves WHO is asking; nothing proved WHICH circle's benefit
    // was being spent. A caller could name any premium circle and draw on that
    // admin's sponsored gas for an unrelated transaction.
    const res = createRes();
    await handler(
      createReq({
        action: 'paySecurityDeposit',
        kindBytes: await depositKindBytes(CIRCLE_ID),
        context: { circleId: OTHER_CIRCLE_ID },
      }),
      res,
    );

    expect(res.body).toMatchObject({ sponsored: false, reason: 'circle_not_in_transaction' });
    expect(createSponsoredTransaction).not.toHaveBeenCalled();
  });

  it('declines before calling Enoki when metering is unavailable', async () => {
    // Without Postgres the reservation no-ops and execute 409s forever, so
    // every attempt would burn a gas coin and still self-pay.
    mockedPgConfigured.mockReturnValue(false);
    const res = createRes();
    await handler(
      createReq({
        action: 'paySecurityDeposit',
        kindBytes: await depositKindBytes(CIRCLE_ID),
        context: { circleId: CIRCLE_ID },
      }),
      res,
    );

    expect(res.body).toMatchObject({ sponsored: false, reason: 'metering_unavailable' });
    expect(createSponsoredTransaction).not.toHaveBeenCalled();
  });

  it('does not report success when the reservation could not be held', async () => {
    mockedReserve.mockResolvedValue(false);
    const res = createRes();
    await handler(
      createReq({
        action: 'paySecurityDeposit',
        kindBytes: await depositKindBytes(CIRCLE_ID),
        context: { circleId: CIRCLE_ID },
      }),
      res,
    );

    expect(res.body).toMatchObject({ sponsored: false, reason: 'reservation_failed' });
  });

  it('passes a non-sponsorable target through as a decline, not a failure', async () => {
    const tx = new Transaction();
    tx.moveCall({
      target: `${PKG}::njangi_circles::some_other_call`,
      arguments: [
        tx.sharedObjectRef({ objectId: CIRCLE_ID, initialSharedVersion: 1, mutable: true }),
      ],
    });
    const res = createRes();
    await handler(
      createReq({
        action: 'paySecurityDeposit',
        kindBytes: toBase64(await tx.build({ onlyTransactionKind: true })),
        context: { circleId: CIRCLE_ID },
      }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ sponsored: false, reason: 'target_not_allowed' });
  });
});
