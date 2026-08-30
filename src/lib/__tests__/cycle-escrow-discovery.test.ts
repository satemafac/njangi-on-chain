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
import {
  findCurrentCycleEscrow,
  readCircleRotationPointer,
} from '@/lib/cycle-escrow-discovery';
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

/**
 * The rotation pointer is what tells a settled round whether the circle
 * moved on. It is deliberately NOT the cycle number: every round in one lap
 * of the rotation shares `current_cycle`, so only `rotation_order`
 * [`current_position`] separates "round 1 is done" from "the claim never
 * rotated the circle". Reading it wrong either strands the circle on round 1
 * or offers a control that pays the same member twice.
 */
describe('readCircleRotationPointer', () => {
  const ROTATION = [
    '0xe833deaa9c038ac2edd397323ed5dbde1e622aadfd0d526332a214a31f9de17d',
    '0xdf98684462fb5b3e85dffcc34fda108b7c34e7da37ab88f0ae3a530ef804a97d',
    '0x1f8d4bdfa384503b0901c73c9925c5b29dad510766542a30dc3b6904ddba897b',
  ];

  /** Stands in for a pooled SuiClient; only getObject is exercised. */
  const clientReturning = (fields: Record<string, unknown> | null) =>
    ({
      getObject: jest.fn().mockResolvedValue(
        fields
          ? { data: { content: { dataType: 'moveObject', fields } } }
          : { data: { content: { dataType: 'package' } } },
      ),
    }) as never;

  const circleFields = (over: Record<string, unknown> = {}) => ({
    current_cycle: '1',
    current_position: '1',
    rotation_order: ROTATION,
    paused_after_cycle: false,
    ...over,
  });

  // Exact production state of 0xa3fada…675ed after round 1 was claimed.
  it('reads the pointer of a circle whose claim rotated it', async () => {
    const pointer = await readCircleRotationPointer(CIRCLE, 'testnet', clientReturning(circleFields()));

    expect(pointer).toEqual({
      currentCycle: 1,
      currentPosition: 1,
      nextRecipient: ROTATION[1],
      pausedAfterCycle: false,
    });
  });

  it('reads a paused circle whose lap is complete', async () => {
    const pointer = await readCircleRotationPointer(
      CIRCLE,
      'testnet',
      clientReturning(circleFields({ current_position: '2', paused_after_cycle: true })),
    );

    // The contract leaves the position on the member who just collected.
    expect(pointer?.nextRecipient).toBe(ROTATION[2]);
    expect(pointer?.pausedAfterCycle).toBe(true);
  });

  it('reports no recipient when the position runs past the rotation', async () => {
    const pointer = await readCircleRotationPointer(
      CIRCLE,
      'testnet',
      clientReturning(circleFields({ current_position: '3' })),
    );

    expect(pointer?.nextRecipient).toBeNull();
  });

  // Mirrors get_next_payout_recipient, which treats @0x0 as "none".
  it('treats the 0x0 placeholder as no recipient', async () => {
    const pointer = await readCircleRotationPointer(
      CIRCLE,
      'testnet',
      clientReturning(
        circleFields({
          current_position: '0',
          rotation_order: [`0x${'0'.repeat(64)}`, ...ROTATION.slice(1)],
        }),
      ),
    );

    expect(pointer?.nextRecipient).toBeNull();
  });

  // A failed read must not look like a rotation state — the caller renders
  // "unknown" and offers no control, rather than guessing.
  it('propagates an RPC failure instead of inventing a pointer', async () => {
    const client = {
      getObject: jest.fn().mockRejectedValue(new Error('Your request is too frequent')),
    } as never;

    await expect(readCircleRotationPointer(CIRCLE, 'testnet', client)).rejects.toThrow(
      /too frequent/,
    );
  });
});
