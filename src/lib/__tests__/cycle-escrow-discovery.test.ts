/**
 * A failed read must not look like a fact — and event history must be fetched
 * from an endpoint that actually has it.
 *
 * `findCurrentCycleEscrow` used to catch its own RPC errors and return null,
 * which is the same value it returns for a circle whose round genuinely has
 * not been opened. It also inherited the caller's client, which is pinned to
 * the configured primary — and the primary (publicnode) refuses event history
 * by design, so the query failed 100% of the time. Together those rendered
 * "This round hasn't been opened yet" on a circle whose round WAS open.
 *
 * It now picks its own endpoint via failover and propagates failures, so these
 * mock the failover layer rather than passing a client.
 */
import { findCurrentCycleEscrow } from '@/lib/cycle-escrow-discovery';
import { withSuiRpcFailover } from '@/services/sui-rpc-failover';

jest.mock('@/services/sui-rpc-failover', () => ({
  ...jest.requireActual('@/services/sui-rpc-failover'),
  withSuiRpcFailover: jest.fn(),
}));

const failover = withSuiRpcFailover as jest.MockedFunction<typeof withSuiRpcFailover>;

const CIRCLE = '0x83bd939b76c636aaf0f1608b702ff2de4b3824c57c26c928c7b31c0bddb8a1f0';
const ESCROW = '0xb60f81e04bdfdeb8707f1dbd385ad883216acb6a2b19cf076bcda48fe30d8b07';

const openedEvent = (circleId = CIRCLE, cycleNo = 2) => ({
  parsedJson: {
    circle_id: circleId,
    escrow_id: ESCROW,
    cycle_no: String(cycleNo),
    recipient: '0xdf98684462fb5b3e85dffcc34fda108b7c34e7da37ab88f0ae3a530ef804a97d',
    contribution_amount: '300000',
    required_contributors: 2,
    asset_type: [],
    opened_at_ms: '1787239768154',
  },
});

/** Stands in for whichever endpoint failover settles on. */
const resolvingTo = (data: unknown[]) =>
  failover.mockImplementation(async () => ({ data }) as never);

beforeEach(() => failover.mockReset());

describe('findCurrentCycleEscrow', () => {
  it('returns the escrow for the requested circle', async () => {
    resolvingTo([openedEvent()]);

    const found = await findCurrentCycleEscrow('testnet', CIRCLE);

    expect(found?.escrowId).toBe(ESCROW);
    expect(found?.cycleNo).toBe(2);
  });

  it('returns null when no event matches the circle — genuinely not open', async () => {
    resolvingTo([openedEvent('0x1111111111111111111111111111111111111111111111111111111111111111')]);

    await expect(findCurrentCycleEscrow('testnet', CIRCLE)).resolves.toBeNull();
  });

  // The regression: a failed read must not be reported as "no round".
  it('propagates a read failure instead of reporting no escrow', async () => {
    failover.mockRejectedValue(new Error('Your request is too frequent'));

    await expect(findCurrentCycleEscrow('testnet', CIRCLE)).rejects.toThrow(/too frequent/);
  });

  // The routing bug: the query must go through failover, never a caller's
  // client, because the configured primary cannot serve event history.
  it('fetches event history through the failover chain', async () => {
    resolvingTo([openedEvent()]);

    await findCurrentCycleEscrow('testnet', CIRCLE);

    expect(failover).toHaveBeenCalledWith('testnet', 'findCurrentCycleEscrow', expect.any(Function));
  });
});
