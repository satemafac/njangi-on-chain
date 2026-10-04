/**
 * The SUI/USDC mode switch (`toggle_auto_swap`): the contract allows it while
 * the circle is inactive or paused between laps, and the app also waits for
 * any round that is still open — that round keeps running in its own coin.
 * A read that could not tell is not "no round".
 */
import type { SuiClient } from '@mysten/sui/client';
import {
  readRoundOpen,
  settlementModeLock,
  settlementModeLockMessage,
} from '@/lib/settlement-mode-lock';

const mockFind = jest.fn();
const mockState = jest.fn();
jest.mock('@/lib/cycle-escrow-discovery', () => ({
  findCurrentCycleEscrow: (...args: unknown[]) => mockFind(...args),
  readCycleEscrowState: (...args: unknown[]) => mockState(...args),
}));

const client = {} as SuiClient;
const ESCROW = { escrowId: '0xescrow' };
const liveState = (overrides: Record<string, unknown>) => ({
  claimed: false,
  refunded: false,
  finalized: false,
  ...overrides,
});

describe('readRoundOpen', () => {
  beforeEach(() => {
    mockFind.mockReset();
    mockState.mockReset();
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  it('is none when the circle has no round', async () => {
    mockFind.mockResolvedValue(null);
    await expect(readRoundOpen('testnet', '0xcircle', client)).resolves.toBe('none');
  });

  it('is open while the round holds money: collecting, finalized, or past its claim window', async () => {
    mockFind.mockResolvedValue(ESCROW);
    for (const state of [liveState({}), liveState({ finalized: true })]) {
      mockState.mockResolvedValueOnce(state);
      await expect(readRoundOpen('testnet', '0xcircle', client)).resolves.toBe('open');
    }
  });

  it('is none once the round paid out or sent everything back', async () => {
    mockFind.mockResolvedValue(ESCROW);
    mockState.mockResolvedValueOnce(liveState({ finalized: true, claimed: true }));
    await expect(readRoundOpen('testnet', '0xcircle', client)).resolves.toBe('none');
    mockState.mockResolvedValueOnce(liveState({ refunded: true }));
    await expect(readRoundOpen('testnet', '0xcircle', client)).resolves.toBe('none');
  });

  it('is unknown, never none, when a read fails', async () => {
    mockFind.mockRejectedValueOnce(new Error('429'));
    await expect(readRoundOpen('testnet', '0xcircle', client)).resolves.toBe('unknown');
    mockFind.mockResolvedValue(ESCROW);
    mockState.mockRejectedValueOnce(new Error('429'));
    await expect(readRoundOpen('testnet', '0xcircle', client)).resolves.toBe('unknown');
    mockState.mockResolvedValueOnce(null);
    await expect(readRoundOpen('testnet', '0xcircle', client)).resolves.toBe('unknown');
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
