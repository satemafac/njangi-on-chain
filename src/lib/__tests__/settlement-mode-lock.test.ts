/**
 * The SUI/USDC mode switch (`toggle_auto_swap`): the contract allows it while
 * the circle is inactive or paused between laps, and the app also waits for
 * any round that still holds members' money — that round keeps running in
 * its own coin. A read that could not tell is not "no round".
 */
import type { SuiClient } from '@mysten/sui/client';
import {
  readCircleStarted,
  readRoundOpen,
  settlementModeLock,
  settlementModeLockMessage,
} from '@/lib/settlement-mode-lock';

const mockHistory = jest.fn();
const mockFind = jest.fn();
jest.mock('@/lib/cycle-escrow-discovery', () => ({
  // Moved into discovery (round discovery uses it too); the real one, which
  // reads the circle through the test client.
  readCircleStarted: jest.requireActual('@/lib/cycle-escrow-discovery').readCircleStarted,
  readCircleEscrowHistory: (...args: unknown[]) => mockHistory(...args),
  findCurrentCycleEscrow: (...args: unknown[]) => mockFind(...args),
}));

const CIRCLE = '0xcircle';
const ESCROW = '0xescrow';

type Fields = Record<string, unknown> | 'throw';

function clientWith(objects: Record<string, Fields>): SuiClient {
  return {
    getObject: jest.fn(async ({ id }: { id: string }) => {
      const fields = objects[id];
      if (fields === 'throw') throw new Error('429');
      if (!fields) return { data: null };
      return { data: { content: { dataType: 'moveObject', fields } } };
    }),
  } as unknown as SuiClient;
}

const escrowFields = (overrides: Record<string, unknown>) => ({
  claimed: false,
  refunded: false,
  finalized: false,
  contributors_count: '1',
  balance: '300000',
  ...overrides,
});

describe('readRoundOpen', () => {
  beforeEach(() => {
    mockHistory.mockReset();
    mockFind.mockReset();
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  describe('a circle with an escrow history', () => {
    beforeEach(() => {
      mockHistory.mockResolvedValue({ kind: 'found', escrowIds: [ESCROW] });
      mockFind.mockResolvedValue({ escrowId: ESCROW });
    });

    it('is open while the round holds money: collecting, or finalized and uncollected', async () => {
      for (const fields of [
        escrowFields({}),
        escrowFields({ finalized: true, contributors_count: '2', balance: '600000' }),
      ]) {
        const client = clientWith({ [ESCROW]: fields });
        await expect(readRoundOpen('testnet', CIRCLE, client)).resolves.toBe('open');
      }
    });

    it('is none once the round paid out or sent everything back', async () => {
      for (const fields of [
        escrowFields({ finalized: true, claimed: true, balance: '0' }),
        escrowFields({ refunded: true, contributors_count: '0', balance: '0' }),
      ]) {
        await expect(readRoundOpen('testnet', CIRCLE, clientWith({ [ESCROW]: fields }))).resolves.toBe('none');
      }
    });

    it('is none for an open round nobody has paid into', async () => {
      const empty = escrowFields({ contributors_count: '0', balance: '0' });
      await expect(readRoundOpen('testnet', CIRCLE, clientWith({ [ESCROW]: empty }))).resolves.toBe('none');
      // The nested Balance form and numeric counts read the same.
      const nested = escrowFields({ contributors_count: 0, balance: { fields: { value: '0' } } });
      await expect(readRoundOpen('testnet', CIRCLE, clientWith({ [ESCROW]: nested }))).resolves.toBe('none');
    });

    it('is none when the circle has no round', async () => {
      mockFind.mockResolvedValue(null);
      await expect(readRoundOpen('testnet', CIRCLE, clientWith({}))).resolves.toBe('none');
    });

    it('is unknown, never none, when a field does not read', async () => {
      for (const fields of [
        escrowFields({ balance: undefined }),
        escrowFields({ contributors_count: 'many' }),
        escrowFields({ finalized: 'no' }),
      ]) {
        await expect(readRoundOpen('testnet', CIRCLE, clientWith({ [ESCROW]: fields }))).resolves.toBe('unknown');
      }
      await expect(readRoundOpen('testnet', CIRCLE, clientWith({ [ESCROW]: 'throw' }))).resolves.toBe('unknown');
      await expect(readRoundOpen('testnet', CIRCLE, clientWith({}))).resolves.toBe('unknown');
    });

    it('is unknown when discovery fails', async () => {
      mockFind.mockRejectedValueOnce(new Error('429'));
      await expect(readRoundOpen('testnet', CIRCLE, clientWith({}))).resolves.toBe('unknown');
    });
  });

  describe('a circle without an escrow history', () => {
    beforeEach(() => {
      mockHistory.mockResolvedValue({ kind: 'absent' });
    });

    it('is none for a circle that never started, without the event scan', async () => {
      const client = clientWith({ [CIRCLE]: { current_cycle: '0', is_active: false } });
      await expect(readRoundOpen('testnet', CIRCLE, client)).resolves.toBe('none');
      expect(mockFind).not.toHaveBeenCalled();
    });

    it('still runs discovery, event scan included, for a circle that has started', async () => {
      mockFind.mockResolvedValue({ escrowId: ESCROW });
      const client = clientWith({
        [CIRCLE]: { current_cycle: '3', is_active: false },
        [ESCROW]: escrowFields({}),
      });
      await expect(readRoundOpen('testnet', CIRCLE, client)).resolves.toBe('open');
      expect(mockFind).toHaveBeenCalledTimes(1);
    });

    it('is unknown when the circle itself does not read', async () => {
      await expect(readRoundOpen('testnet', CIRCLE, clientWith({ [CIRCLE]: 'throw' }))).resolves.toBe('unknown');
      expect(mockFind).not.toHaveBeenCalled();
    });
  });

  it('is unknown when the escrow history does not read', async () => {
    mockHistory.mockResolvedValue({ kind: 'unknown' });
    await expect(readRoundOpen('testnet', CIRCLE, clientWith({}))).resolves.toBe('unknown');
    expect(mockFind).not.toHaveBeenCalled();
  });
});

describe('readCircleStarted', () => {
  it('reads a circle that is not active at cycle 0 as never started', async () => {
    const client = clientWith({ [CIRCLE]: { current_cycle: '0', is_active: false } });
    await expect(readCircleStarted(client, CIRCLE)).resolves.toBe('never-started');
  });

  it('reads any circle past cycle 0, or active, as started', async () => {
    for (const fields of [
      { current_cycle: '1', is_active: false },
      { current_cycle: 4, is_active: true },
      { current_cycle: '0', is_active: true },
    ]) {
      await expect(readCircleStarted(clientWith({ [CIRCLE]: fields }), CIRCLE)).resolves.toBe('started');
    }
  });

  it('is unknown when the fields do not read', async () => {
    for (const fields of [{ current_cycle: '0' }, { is_active: false }, { current_cycle: 'x', is_active: false }]) {
      await expect(readCircleStarted(clientWith({ [CIRCLE]: fields }), CIRCLE)).resolves.toBe('unknown');
    }
  });
});

describe('settlementModeLock', () => {
  it('stays available between laps and before the circle starts, with no open round', () => {
    expect(settlementModeLock({ isActive: true, paused: true, round: 'none' })).toBeNull();
    expect(settlementModeLock({ isActive: false, paused: false, round: 'none' })).toBeNull();
  });

  it('locks while a lap runs, whatever the round read says', () => {
    for (const round of ['none', 'open', 'unknown', null] as const) {
      expect(settlementModeLock({ isActive: true, paused: false, round })).toBe('lap-running');
    }
  });

  it('locks while a round is open, and says so', () => {
    expect(settlementModeLock({ isActive: true, paused: true, round: 'open' })).toBe('round-open');
    expect(settlementModeLock({ isActive: false, paused: false, round: 'open' })).toBe('round-open');
    expect(settlementModeLockMessage('round-open')).toMatch(/round is still open/);
  });

  it('does not switch on a check that failed or has not answered', () => {
    expect(settlementModeLock({ isActive: true, paused: true, round: 'unknown' })).toBe('round-unknown');
    expect(settlementModeLock({ isActive: true, paused: true, round: null })).toBe('round-checking');
    expect(settlementModeLockMessage('round-unknown')).toMatch(/couldn't check/);
  });
});
