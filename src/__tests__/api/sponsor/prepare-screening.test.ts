/**
 * /api/sponsor/prepare — region and wallet screen before Enoki (NJA-2833).
 *
 * Sponsoring gas is a server-side favour to a wallet, so it is a choke
 * point like join-requests/create: the request's country header is checked
 * against the embargo list and the session's wallet is screened, failing
 * closed, BEFORE Enoki is asked for a sponsor-funded gas coin. A request
 * without a country header counts as blocked: an unreadable region is not
 * an allowed one.
 *
 * Every case below is otherwise fully eligible (valid session, metering
 * on, premium circle, sponsorable kind), so only the screen can refuse it.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { Transaction } from '@mysten/sui/transactions';
import { toBase64 } from '@mysten/sui/utils';
import handler from '../../../pages/api/sponsor/prepare';
import { getZkLoginSessionAccount } from '@/lib/zklogin-session-registry';
import { resolveEscrowSponsorship } from '@/lib/gas-sponsorship-eligibility';
import { reservePendingSponsorship } from '@/lib/gas-sponsorship';
import { isPostgresConfigured } from '@/lib/pg-pool';
import { screenAddress } from '@/lib/sanctions';

const PKG = '0x' + '11'.repeat(32);
const CIRCLE_ID = '0x' + 'ce'.repeat(32);
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
// The wallet screen reads Postgres; each case sets its verdict. The embargo
// helper (src/lib/embargo.ts) is pure and runs for real.
jest.mock('@/lib/sanctions', () => ({
  screenAddress: jest.fn(),
  sanctionsErrorBody: jest.fn(() => ({
    success: false,
    error: 'SANCTIONS_BLOCKED',
    code: 'SANCTIONS_BLOCKED',
    message: 'blocked',
  })),
}));

const mockCreateSponsoredTransaction = jest.fn();
jest.mock('@mysten/enoki', () => ({
  EnokiClient: jest.fn().mockImplementation(() => ({
    createSponsoredTransaction: (...args: unknown[]) =>
      mockCreateSponsoredTransaction(...args),
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
const mockedScreen = screenAddress as jest.MockedFunction<typeof screenAddress>;

/** A deposit kind that genuinely touches the circle object, as the real one does. */
async function depositKindBytes(circleId: string): Promise<string> {
  const tx = new Transaction();
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

/** Unlike the sibling prepare.test.ts, requests here carry edge headers. */
const createReq = (headers: Record<string, string>, body: unknown): NextApiRequest =>
  ({ method: 'POST', headers, body, cookies: { 'session-id': 'sess' } }) as unknown as NextApiRequest;

async function eligibleBody() {
  return {
    action: 'paySecurityDeposit',
    kindBytes: await depositKindBytes(CIRCLE_ID),
    context: { circleId: CIRCLE_ID, coinType: 'usdc', usesGasCoinForValue: false },
  };
}

const ALLOWED = { 'x-vercel-ip-country': 'US' };

describe('/api/sponsor/prepare — region and wallet screen before Enoki', () => {
  const savedGeoFlag = process.env.SANCTIONS_GEO_BLOCK_ENABLED;
  let errorSpy: jest.SpyInstance;
  let infoSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeAll(() => {
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterAll(() => {
    errorSpy.mockRestore();
    infoSpy.mockRestore();
    warnSpy.mockRestore();
    if (savedGeoFlag === undefined) delete process.env.SANCTIONS_GEO_BLOCK_ENABLED;
    else process.env.SANCTIONS_GEO_BLOCK_ENABLED = savedGeoFlag;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // Default-ON, as in production: an unset flag means the block runs.
    delete process.env.SANCTIONS_GEO_BLOCK_ENABLED;
    mockedSession.mockResolvedValue({ sub: 'sub-1', userAddr: USER } as never);
    mockedPgConfigured.mockReturnValue(true);
    mockedReserve.mockResolvedValue(true);
    mockCreateSponsoredTransaction.mockResolvedValue({ bytes: 'AAAA', digest: 'dig-1' });
    mockedResolve.mockResolvedValue({
      sponsor: true,
      reason: 'eligible',
      circleId: CIRCLE_ID,
    } as never);
    mockedScreen.mockResolvedValue({ blocked: false, listVersion: '2026-11-01' });
  });

  it('refuses an embargoed region (IR) with 403 EMBARGOED_REGION and never asks Enoki', async () => {
    const res = createRes();
    await handler(createReq({ 'x-vercel-ip-country': 'IR' }, await eligibleBody()), res);

    expect(mockCreateSponsoredTransaction).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ error: 'EMBARGOED_REGION', code: 'EMBARGOED_REGION' });
  });

  it('treats a missing country header as blocked, not as an allowed region', async () => {
    // House rule: a value that cannot be read is not a default. No header
    // means the region is unknown, and an unknown region is refused.
    const res = createRes();
    await handler(createReq({}, await eligibleBody()), res);

    expect(mockCreateSponsoredTransaction).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ error: 'EMBARGOED_REGION', code: 'EMBARGOED_REGION' });
  });

  it('refuses a listed session wallet with 403 SANCTIONS_BLOCKED and never asks Enoki', async () => {
    mockedScreen.mockResolvedValue({ blocked: true, listVersion: '2026-11-01', reason: 'hit' });
    const res = createRes();
    await handler(createReq(ALLOWED, await eligibleBody()), res);

    expect(mockCreateSponsoredTransaction).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ error: 'SANCTIONS_BLOCKED', code: 'SANCTIONS_BLOCKED' });
  });

  it('fails CLOSED with a retryable 503 when the screen cannot run', async () => {
    // Not a match: screening could not be performed. Sponsored claims and
    // refunds pause rather than go out unscreened; the member retries.
    mockedScreen.mockResolvedValue({ blocked: true, listVersion: null, reason: 'unavailable' });
    const res = createRes();
    await handler(createReq(ALLOWED, await eligibleBody()), res);

    expect(mockCreateSponsoredTransaction).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({ error: 'SCREENING_UNAVAILABLE', code: 'SCREENING_UNAVAILABLE' });
  });

  it('screens the session address with failClosed before Enoki, then sponsors', async () => {
    const res = createRes();
    await handler(createReq(ALLOWED, await eligibleBody()), res);

    expect(mockedScreen).toHaveBeenCalledWith(
      USER,
      expect.any(String),
      expect.objectContaining({ failClosed: true }),
    );
    expect(mockCreateSponsoredTransaction).toHaveBeenCalledTimes(1);
    expect(mockedScreen.mock.invocationCallOrder[0]).toBeLessThan(
      mockCreateSponsoredTransaction.mock.invocationCallOrder[0],
    );
    expect(res.body).toMatchObject({ sponsored: true, digest: 'dig-1' });
  });

  it('refuses Ukraine when the subdivision header is missing', async () => {
    // Only the subdivision tells Crimea, Sevastopol, Donetsk and Luhansk
    // apart from the rest of Ukraine, so without it the region is unknown.
    const res = createRes();
    await handler(createReq({ 'x-vercel-ip-country': 'UA' }, await eligibleBody()), res);

    expect(mockCreateSponsoredTransaction).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ error: 'EMBARGOED_REGION', code: 'EMBARGOED_REGION' });
  });

  it('refuses an embargoed Ukrainian subdivision (Crimea)', async () => {
    const res = createRes();
    await handler(
      createReq(
        { 'x-vercel-ip-country': 'UA', 'x-vercel-ip-country-region': '43' },
        await eligibleBody(),
      ),
      res,
    );

    expect(mockCreateSponsoredTransaction).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ error: 'EMBARGOED_REGION', code: 'EMBARGOED_REGION' });
  });

  it('sponsors Ukraine outside the embargoed subdivisions', async () => {
    const res = createRes();
    await handler(
      createReq(
        { 'x-vercel-ip-country': 'UA', 'x-vercel-ip-country-region': '30' },
        await eligibleBody(),
      ),
      res,
    );

    expect(mockCreateSponsoredTransaction).toHaveBeenCalledTimes(1);
    expect(res.body).toMatchObject({ sponsored: true, digest: 'dig-1' });
  });

  it('refuses a country header it cannot parse instead of reading it as allowed', async () => {
    // A repeated header reaches Node joined, e.g. "US, IR", which is not a country.
    const res = createRes();
    await handler(createReq({ 'x-vercel-ip-country': 'US, IR' }, await eligibleBody()), res);

    expect(mockCreateSponsoredTransaction).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ error: 'EMBARGOED_REGION', code: 'EMBARGOED_REGION' });
  });

  it('fails CLOSED with a retryable 503 when the screen throws', async () => {
    mockedScreen.mockRejectedValue(new Error('pg down'));
    const res = createRes();
    await handler(createReq(ALLOWED, await eligibleBody()), res);

    expect(mockCreateSponsoredTransaction).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({ error: 'SCREENING_UNAVAILABLE', code: 'SCREENING_UNAVAILABLE' });
  });

  it('treats a block that carries no reason as a block, not a pass', async () => {
    mockedScreen.mockResolvedValue({ blocked: true, listVersion: null });
    const res = createRes();
    await handler(createReq(ALLOWED, await eligibleBody()), res);

    expect(mockCreateSponsoredTransaction).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ error: 'SANCTIONS_BLOCKED', code: 'SANCTIONS_BLOCKED' });
  });

  it('leaves a policy decline a 200 decline without screening anything', async () => {
    // A decline spends nothing, so it keeps its documented non-fatal answer.
    mockedResolve.mockResolvedValue({
      sponsor: false,
      reason: 'admin_not_premium',
      circleId: CIRCLE_ID,
    } as never);
    const res = createRes();
    await handler(createReq(ALLOWED, await eligibleBody()), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ sponsored: false, reason: 'admin_not_premium' });
    expect(mockedScreen).not.toHaveBeenCalled();
    expect(mockCreateSponsoredTransaction).not.toHaveBeenCalled();
  });
});
