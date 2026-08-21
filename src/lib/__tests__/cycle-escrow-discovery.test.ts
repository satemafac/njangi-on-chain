/**
 * A failed read must not look like a fact.
 *
 * `findCurrentCycleEscrow` used to catch its own RPC errors and return null,
 * which is the same value it returns for a circle whose round genuinely has
 * not been opened. On 2026-08-21 a rate-limited query rendered "This round
 * hasn't been opened yet" on a circle whose round WAS open — sending members
 * to chase an admin who had already opened it.
 */
import { findCurrentCycleEscrow } from '@/lib/cycle-escrow-discovery';
import type { SuiClient } from '@mysten/sui/client';

const CIRCLE = '0x83bd939b76c636aaf0f1608b702ff2de4b3824c57c26c928c7b31c0bddb8a1f0';

function clientReturning(data: unknown[]): SuiClient {
  return { queryEvents: jest.fn().mockResolvedValue({ data }) } as unknown as SuiClient;
}

const openedEvent = (circleId = CIRCLE, cycleNo = 2) => ({
  parsedJson: {
    circle_id: circleId,
    escrow_id: '0xb60f81e04bdfdeb8707f1dbd385ad883216acb6a2b19cf076bcda48fe30d8b07',
    cycle_no: String(cycleNo),
    recipient: '0xdf98684462fb5b3e85dffcc34fda108b7c34e7da37ab88f0ae3a530ef804a97d',
    contribution_amount: '300000',
    required_contributors: 2,
    asset_type: [],
    opened_at_ms: '1787239768154',
  },
});

describe('findCurrentCycleEscrow', () => {
  it('returns the escrow for the requested circle', async () => {
    const found = await findCurrentCycleEscrow(clientReturning([openedEvent()]), 'testnet', CIRCLE);

    expect(found?.escrowId).toBe(
      '0xb60f81e04bdfdeb8707f1dbd385ad883216acb6a2b19cf076bcda48fe30d8b07',
    );
    expect(found?.cycleNo).toBe(2);
  });

  it('returns null when no event matches the circle — genuinely not open', async () => {
    const other = openedEvent('0x1111111111111111111111111111111111111111111111111111111111111111');

    await expect(findCurrentCycleEscrow(clientReturning([other]), 'testnet', CIRCLE)).resolves.toBeNull();
  });

  // The regression: a rate limit must not be reported as "no round".
  it('propagates a read failure instead of reporting no escrow', async () => {
    const client = {
      queryEvents: jest.fn().mockRejectedValue(new Error('Your request is too frequent')),
    } as unknown as SuiClient;

    await expect(findCurrentCycleEscrow(client, 'testnet', CIRCLE)).rejects.toThrow(
      /too frequent/,
    );
  });
});
