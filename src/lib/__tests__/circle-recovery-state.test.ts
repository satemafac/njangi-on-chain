/**
 * Whether a circle's recovery vote has executed, as the round panel reads it
 * to pick `cancel_unfinalized_escrow_for_recovery` (no grace wait) over the
 * grace-gated `cancel_unfinalized_escrow`. The contract accepts the recovery
 * cancel for recovery_state STOPPED (2) and REFUNDED (3) only, and aborts
 * 227 otherwise. A read that failed is unknown, never "not stopped": the
 * panel then stays on the time rule rather than widen the window on a guess.
 */
import type { SuiClient } from '@mysten/sui/client';
import {
  isRecoveryStopped,
  parseRecoveryStateValue,
  readCircleRecoveryStopped,
  RECOVERY_STATE_REFUNDED,
  RECOVERY_STATE_STOPPED,
} from '@/lib/circle-recovery-state';

const CIRCLE = '0x' + 'd'.repeat(64);
const CONFIG = '0x' + 'c0'.repeat(32);

function clientWith(recoveryState: string | number | undefined, opts: { fail?: 'fields' | 'object' } = {}) {
  const getDynamicFields = jest.fn(async () => {
    if (opts.fail === 'fields') throw new Error('429');
    return {
      data: [{ objectId: CONFIG, objectType: '0x1::njangi_circles::CircleConfig', name: { type: 'x', value: 'circle_config' } }],
      hasNextPage: false,
      nextCursor: null,
    };
  });
  const getObject = jest.fn(async () => {
    if (opts.fail === 'object') throw new Error('timeout');
    return {
      data: {
        objectId: CONFIG,
        content: {
          dataType: 'moveObject',
          fields: {
            value: {
              type: '0x1::njangi_circles::CircleConfig',
              fields: recoveryState === undefined ? {} : { recovery_state: recoveryState },
            },
          },
        },
      },
    };
  });
  return { client: { getDynamicFields, getObject } as unknown as SuiClient, getDynamicFields, getObject };
}

describe('parseRecoveryStateValue', () => {
  it('reads the u64 as JSON-RPC renders it (a string) or as a number', () => {
    expect(parseRecoveryStateValue({ recovery_state: '2' })).toBe(2);
    expect(parseRecoveryStateValue({ recovery_state: 3 })).toBe(3);
    expect(parseRecoveryStateValue({ recovery_state: '0' })).toBe(0);
  });

  it('is null for a missing or unreadable field', () => {
    expect(parseRecoveryStateValue({})).toBeNull();
    expect(parseRecoveryStateValue(null)).toBeNull();
    expect(parseRecoveryStateValue({ recovery_state: 'stopped' })).toBeNull();
    expect(parseRecoveryStateValue({ recovery_state: -1 })).toBeNull();
  });
});

describe('isRecoveryStopped', () => {
  it('is true exactly for the two states the recovery cancel accepts', () => {
    expect(RECOVERY_STATE_STOPPED).toBe(2);
    expect(RECOVERY_STATE_REFUNDED).toBe(3);
    expect(isRecoveryStopped(2)).toBe(true);
    expect(isRecoveryStopped(3)).toBe(true);
  });

  it('is false for an active circle or a pending proposal (the vote has not executed)', () => {
    expect(isRecoveryStopped(0)).toBe(false);
    expect(isRecoveryStopped(1)).toBe(false);
  });

  it('is unknown for an unread state', () => {
    expect(isRecoveryStopped(null)).toBeNull();
  });
});

describe('readCircleRecoveryStopped', () => {
  it('reads the state off the CircleConfig dynamic field', async () => {
    const { client, getDynamicFields } = clientWith('2');
    expect(await readCircleRecoveryStopped(CIRCLE, 'testnet', client)).toBe(true);
    expect(getDynamicFields).toHaveBeenCalledWith({ parentId: CIRCLE });
    expect(await readCircleRecoveryStopped(CIRCLE, 'testnet', clientWith('0').client)).toBe(false);
  });

  it('answers unknown, never false, when a read fails', async () => {
    expect(await readCircleRecoveryStopped(CIRCLE, 'testnet', clientWith('2', { fail: 'fields' }).client)).toBeNull();
    expect(await readCircleRecoveryStopped(CIRCLE, 'testnet', clientWith('2', { fail: 'object' }).client)).toBeNull();
  });

  it('answers unknown when the config carries no recovery state', async () => {
    expect(await readCircleRecoveryStopped(CIRCLE, 'testnet', clientWith(undefined).client)).toBeNull();
  });
});
