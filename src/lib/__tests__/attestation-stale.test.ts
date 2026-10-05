/**
 * The stale-attestation sweep (src/lib/attestation-stale.ts) backs both the
 * daily /api/cron/attestation-expiry cron and the /admin/compliance console.
 *
 * Regression guarded here: only the round lookup sat inside the per-circle
 * try/catch, so one failed escrow-state or contributor read aborted the whole
 * sweep (both callers answered 500), and a failed attestation read silently
 * dropped the member being checked. Every read now fails soft per circle, and
 * the circles that could not be read come back in `unchecked` instead of
 * disappearing into an empty "nothing stale" list.
 */

jest.mock('../cycle-escrow-discovery', () => ({
  findCurrentCycleEscrow: jest.fn(),
  readCycleEscrowState: jest.fn(),
  listContributors: jest.fn(),
  eventTypePackageIdFor: jest.fn(() => '0xoriginal'),
}));
jest.mock('../compliance-gate', () => ({
  fetchValidAttestations: jest.fn(),
}));
jest.mock('../whatsapp-notifier', () => ({
  sendMemberNotification: jest.fn(),
}));
jest.mock('../../services/network-config', () => ({
  getNetworkConfig: jest.fn(() => ({ rpcUrl: 'http://localhost:9000' })),
}));
const mockQueryEvents = jest.fn();
jest.mock('../../services/sui-rpc-failover', () => ({
  getPooledSuiClient: jest.fn(() => ({ queryEvents: mockQueryEvents })),
}));

import { buildStaleReport, discoverGatedCircleIds } from '../attestation-stale';
import {
  findCurrentCycleEscrow,
  readCycleEscrowState,
  listContributors,
} from '../cycle-escrow-discovery';
import { fetchValidAttestations } from '../compliance-gate';

const findMock = findCurrentCycleEscrow as jest.Mock;
const stateMock = readCycleEscrowState as jest.Mock;
const contributorsMock = listContributors as jest.Mock;
const attestationsMock = fetchValidAttestations as jest.Mock;

const CIRCLE_A = '0x' + 'a1'.repeat(32);
const CIRCLE_B = '0x' + 'b2'.repeat(32);
const RECIPIENT = '0x' + 'cc'.repeat(32);
const PAYER = '0x' + 'dd'.repeat(32);

const escrowFor = (circleId: string) => ({ escrowId: `${circleId}-escrow`, circleId });
const gatedState = {
  cycleNo: 3,
  recipient: RECIPIENT,
  members: [PAYER, RECIPIENT],
  requiresAttestation: true,
  claimed: false,
};

beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  findMock.mockImplementation(async (_network: string, circleId: string) => escrowFor(circleId));
  stateMock.mockResolvedValue(gatedState);
  contributorsMock.mockResolvedValue([PAYER]);
  // Nobody holds an attestation unless a test says otherwise.
  attestationsMock.mockResolvedValue([]);
});

describe('buildStaleReport', () => {
  it('reports every member without an attestation, with nothing unchecked', async () => {
    const report = await buildStaleReport('testnet', [CIRCLE_A]);

    expect(report.unchecked).toEqual([]);
    expect(report.stale.map((entry) => entry.memberAddress).sort()).toEqual(
      [PAYER, RECIPIENT].sort(),
    );
    expect(report.stale[0]).toMatchObject({ circleId: CIRCLE_A, cycleNo: 3, reason: 'no_attestation' });
    // Lap 3, recipient in the second of two seats: round 6, not "round 3".
    expect(report.stale[0].roundNo).toBe(6);
  });

  it('keeps sweeping when one circle’s escrow state read throws, and lists that circle as unchecked', async () => {
    stateMock.mockImplementation(async (escrowId: string) => {
      if (escrowId === `${CIRCLE_A}-escrow`) throw new Error('429 Too Many Requests');
      return gatedState;
    });

    const report = await buildStaleReport('testnet', [CIRCLE_A, CIRCLE_B]);

    expect(report.unchecked).toEqual([CIRCLE_A]);
    expect(report.stale.every((entry) => entry.circleId === CIRCLE_B)).toBe(true);
    expect(report.stale).toHaveLength(2);
  });

  it('lists a circle as unchecked when its contributor read throws', async () => {
    contributorsMock.mockImplementation(async (escrowId: string) => {
      if (escrowId === `${CIRCLE_B}-escrow`) throw new Error('contributed table unreadable');
      return [PAYER];
    });

    const report = await buildStaleReport('testnet', [CIRCLE_A, CIRCLE_B]);

    expect(report.unchecked).toEqual([CIRCLE_B]);
    expect(report.stale.every((entry) => entry.circleId === CIRCLE_A)).toBe(true);
  });

  it('lists a circle as unchecked when its round lookup throws', async () => {
    findMock.mockImplementation(async (_network: string, circleId: string) => {
      if (circleId === CIRCLE_A) throw new Error('escrow_history unreadable');
      return escrowFor(circleId);
    });

    const report = await buildStaleReport('testnet', [CIRCLE_A, CIRCLE_B]);

    expect(report.unchecked).toEqual([CIRCLE_A]);
  });

  it('treats an unreadable state for a just-verified escrow as unchecked, not as no round', async () => {
    stateMock.mockResolvedValue(null);

    const report = await buildStaleReport('testnet', [CIRCLE_A]);

    expect(report).toEqual({ stale: [], unchecked: [CIRCLE_A] });
  });

  it('still reports the members it could read when one member’s attestation read fails', async () => {
    attestationsMock.mockImplementation(async (member: string) => {
      if (member === PAYER) throw new Error('getOwnedObjects failed');
      return [];
    });

    const report = await buildStaleReport('testnet', [CIRCLE_A]);

    expect(report.stale.map((entry) => entry.memberAddress)).toEqual([RECIPIENT]);
    expect(report.unchecked).toEqual([CIRCLE_A]);
  });

  it('answers nothing stale and nothing unchecked for a circle with no round open', async () => {
    findMock.mockResolvedValue(null);

    const report = await buildStaleReport('testnet', [CIRCLE_A]);

    expect(report).toEqual({ stale: [], unchecked: [] });
    expect(stateMock).not.toHaveBeenCalled();
  });

  it('skips ungated and already-claimed rounds without listing them as unchecked', async () => {
    stateMock.mockImplementation(async (escrowId: string) =>
      escrowId === `${CIRCLE_A}-escrow`
        ? { ...gatedState, requiresAttestation: false }
        : { ...gatedState, claimed: true },
    );

    const report = await buildStaleReport('testnet', [CIRCLE_A, CIRCLE_B]);

    expect(report).toEqual({ stale: [], unchecked: [] });
  });
});

describe('discoverGatedCircleIds', () => {
  const opened = (circleId: string, gated: boolean) => ({
    parsedJson: { circle_id: circleId, requires_attestation: gated },
  });

  it('returns the gated circles and complete: true when the scan finishes', async () => {
    mockQueryEvents.mockResolvedValueOnce({
      data: [opened(CIRCLE_A, true), opened(CIRCLE_B, false), opened(CIRCLE_A, true)],
      hasNextPage: false,
      nextCursor: null,
    });

    await expect(discoverGatedCircleIds('testnet')).resolves.toEqual({
      circleIds: [CIRCLE_A],
      complete: true,
    });
  });

  it('reports complete: false instead of "no gated circles" when the scan fails outright', async () => {
    mockQueryEvents.mockRejectedValueOnce(new Error('All configured Sui RPC endpoints are in rate limit cooldown'));

    await expect(discoverGatedCircleIds('testnet')).resolves.toEqual({
      circleIds: [],
      complete: false,
    });
  });

  it('keeps what an interrupted scan found and reports complete: false', async () => {
    mockQueryEvents
      .mockResolvedValueOnce({
        data: [opened(CIRCLE_A, true)],
        hasNextPage: true,
        nextCursor: { txDigest: 'd', eventSeq: '0' },
      })
      .mockRejectedValueOnce(new Error('429'));

    await expect(discoverGatedCircleIds('testnet')).resolves.toEqual({
      circleIds: [CIRCLE_A],
      complete: false,
    });
  });
});
