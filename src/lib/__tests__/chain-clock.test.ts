/**
 * The claim window is decided on the chain's clock, never the device's: a
 * phone running a day fast must not announce a closed window (and offer the
 * refund that ends it). A clock that cannot be read is unknown.
 */
import type { SuiClient } from '@mysten/sui/client';
import { readChainClockMs, SUI_CLOCK_OBJECT_ID } from '@/lib/chain-clock';
import { readCycleEscrowState } from '@/lib/cycle-escrow-discovery';

const clockObject = (timestampMs: unknown) => ({
  data: {
    objectId: '0x0000000000000000000000000000000000000000000000000000000000000006',
    type: '0x2::clock::Clock',
    content: {
      dataType: 'moveObject',
      type: '0x2::clock::Clock',
      // As testnet returns it on 2026-10-03: a decimal string.
      fields: { id: { id: '0x6' }, timestamp_ms: timestampMs },
    },
  },
});

const clientServing = (getObject: jest.Mock) => ({ getObject }) as unknown as SuiClient;

describe('readChainClockMs', () => {
  beforeEach(() => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  it('reads the shared Clock object', async () => {
    const getObject = jest.fn(async () => clockObject('1791033032530'));
    await expect(readChainClockMs(clientServing(getObject))).resolves.toBe(1791033032530);
    expect(getObject).toHaveBeenCalledWith({ id: SUI_CLOCK_OBJECT_ID, options: { showContent: true } });
  });

  it('is null, never a time, when the read fails', async () => {
    const getObject = jest.fn(async () => {
      throw new Error('Unexpected status code: 429');
    });
    await expect(readChainClockMs(clientServing(getObject))).resolves.toBeNull();
  });

  it('is null when the object or its timestamp does not read', async () => {
    await expect(
      readChainClockMs(clientServing(jest.fn(async () => ({ error: { code: 'notExists' } })))),
    ).resolves.toBeNull();
    await expect(
      readChainClockMs(clientServing(jest.fn(async () => clockObject('not-a-number')))),
    ).resolves.toBeNull();
    await expect(
      readChainClockMs(clientServing(jest.fn(async () => clockObject(undefined)))),
    ).resolves.toBeNull();
  });
});

describe('readCycleEscrowState: claim window', () => {
  const escrowWith = (fields: Record<string, unknown>) => ({
    data: {
      objectId: '0xe30c91fee48d74587d6dc549b301f8c7424031116e7c8d8cefaf410c3894fbe0',
      content: {
        dataType: 'moveObject',
        fields: {
          snapshot: { fields: { cycle_no: '5', members: [], required_contributors: '2' } },
          finalized: true,
          claimed: false,
          refunded: false,
          ...fields,
        },
      },
    },
  });

  it('exposes the claim expiry the contract mirrors on the escrow', async () => {
    const client = clientServing(
      jest.fn(async () => escrowWith({ claim_expires_at_ms: '1793926356233' })),
    );
    const state = await readCycleEscrowState('0xe30c91fe', 'testnet', client);
    expect(state?.claimExpiresAtMs).toBe(1793926356233);
  });

  it('reads 0 (no window) for an unfinalized escrow or a missing field', async () => {
    const client = clientServing(jest.fn(async () => escrowWith({ claim_expires_at_ms: '0' })));
    expect((await readCycleEscrowState('0xe30c91fe', 'testnet', client))?.claimExpiresAtMs).toBe(0);
    const bare = clientServing(jest.fn(async () => escrowWith({})));
    expect((await readCycleEscrowState('0xe30c91fe', 'testnet', bare))?.claimExpiresAtMs).toBe(0);
  });
});
