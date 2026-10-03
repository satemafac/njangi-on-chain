/**
 * The WhatsApp /status reply's custody-wallet lines.
 *
 * Regression guarded here: the reply found the custody wallet only by
 * scanning the newest 100 CustodyWalletCreated events, so for any circle
 * outside that window (or when the one endpoint serving events was down) the
 * balance lines silently dropped out, which reads as nothing being held. The
 * wallet now comes from the shared resolver (custody-wallet-discovery.ts),
 * and when it cannot be found or read the reply says the balance couldn't be
 * checked.
 */

jest.mock('@/services/network-config', () => ({
  getNetworkConfig: jest.fn(() => ({ rpcUrl: 'http://localhost:9000', packageId: '0xenvpkg' })),
}));
jest.mock('@/services/sui-rpc-failover', () => ({
  getPooledSuiClient: jest.fn(),
}));
jest.mock('@/lib/sui-read', () => ({
  readObject: jest.fn(),
  queryEventsCached: jest.fn(),
}));
jest.mock('@/lib/circle-chain', () => ({
  resolveCircleLifecycleState: jest.fn(() => ({ isActive: true })),
}));
jest.mock('@/services/join-request-database', () => ({
  __esModule: true,
  default: { getUserByAddress: jest.fn() },
}));
jest.mock('@/lib/custody-wallet-discovery', () => ({
  resolveCustodyWalletId: jest.fn(),
}));

import {
  getCircleStatus,
  formatCircleStatusForWhatsApp,
  type CircleStatusData,
} from '@/services/circle-status.service';
import { getPooledSuiClient } from '@/services/sui-rpc-failover';
import { readObject, queryEventsCached } from '@/lib/sui-read';
import { resolveCustodyWalletId } from '@/lib/custody-wallet-discovery';

const ORIGINAL_PKG = '0x' + '0e'.repeat(32);
const CIRCLE_ID = '0x' + 'c3'.repeat(32);
const ADMIN = '0x' + 'a1'.repeat(32);
const WALLET = '0x' + 'aa'.repeat(32);

const resolveMock = resolveCustodyWalletId as jest.Mock;
const queryEventsMock = queryEventsCached as jest.Mock;

let walletGetObject: jest.Mock;

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});

  (readObject as jest.Mock).mockImplementation(async (id: string) =>
    id === CIRCLE_ID
      ? {
          data: {
            type: `${ORIGINAL_PKG}::njangi_circles::Circle`,
            content: {
              dataType: 'moveObject',
              fields: {
                name: 'Susu',
                admin: ADMIN,
                rotation_order: [ADMIN],
                current_cycle: '1',
                current_position: '0',
                is_active: true,
              },
            },
          },
        }
      : { data: null },
  );
  queryEventsMock.mockResolvedValue({ data: [] });

  // 2 SUI in the wallet's main balance (JSON-RPC renders Balance<T> as a
  // plain string of base units).
  walletGetObject = jest.fn(async () => ({
    data: { content: { dataType: 'moveObject', fields: { balance: '2000000000' } } },
  }));
  (getPooledSuiClient as jest.Mock).mockReturnValue({
    getDynamicFields: jest.fn(async () => ({ data: [] })),
    getObject: walletGetObject,
  });
  resolveMock.mockResolvedValue({ walletId: WALLET, source: 'creation_tx' });
});

async function readStatus(): Promise<CircleStatusData> {
  const status = await getCircleStatus(CIRCLE_ID, 'testnet');
  if (!status) throw new Error('expected a status');
  return status;
}

describe('getCircleStatus custody wallet', () => {
  it('finds the wallet through the shared resolver, not a CustodyWalletCreated scan', async () => {
    const status = await readStatus();

    expect(resolveMock).toHaveBeenCalledWith(
      expect.objectContaining({ circleId: CIRCLE_ID, packageId: ORIGINAL_PKG }),
    );
    const scannedTypes = queryEventsMock.mock.calls.map(
      ([params]) => (params as { query?: { MoveEventType?: string } }).query?.MoveEventType ?? '',
    );
    expect(scannedTypes.some((type) => type.includes('CustodyWalletCreated'))).toBe(false);
    expect(status.custodyWalletId).toBe(WALLET);
    expect(status.custodyBalance).toBe(2);
    expect(status.custodyBalanceUnavailable).toBe(false);
    expect(formatCircleStatusForWhatsApp(status, CIRCLE_ID)).toContain('Total: 2.0000 SUI');
  });

  it("says the balance couldn't be checked when no tier finds the wallet", async () => {
    resolveMock.mockResolvedValue(null);

    const status = await readStatus();

    expect(status.custodyBalance).toBeUndefined();
    expect(status.custodyBalanceUnavailable).toBe(true);
    expect(formatCircleStatusForWhatsApp(status, CIRCLE_ID)).toContain(
      "couldn't check the balance right now",
    );
  });

  it("says the balance couldn't be checked when the wallet read throws", async () => {
    walletGetObject.mockRejectedValue(new Error('All configured Sui RPC endpoints are in rate limit cooldown'));

    const status = await readStatus();

    expect(status.custodyBalanceUnavailable).toBe(true);
    expect(status.custodyBalance).toBeUndefined();
  });

  it('treats a wallet read without content as a failed read, not an empty wallet', async () => {
    walletGetObject.mockResolvedValue({ error: { code: 'unknown' } });

    const status = await readStatus();

    expect(status.custodyBalanceUnavailable).toBe(true);
  });

  it('keeps the rest of the status when the resolver itself throws', async () => {
    resolveMock.mockRejectedValue(new Error('unexpected'));

    const status = await readStatus();

    expect(status.name).toBe('Susu');
    expect(status.custodyBalanceUnavailable).toBe(true);
  });

  it('omits the custody lines, without a warning, for a wallet that was read and holds nothing', async () => {
    walletGetObject.mockResolvedValue({
      data: { content: { dataType: 'moveObject', fields: { balance: '0' } } },
    });

    const status = await readStatus();
    const text = formatCircleStatusForWhatsApp(status, CIRCLE_ID);

    expect(status.custodyBalanceUnavailable).toBe(false);
    expect(text).not.toContain('Custody Wallet');
    expect(text).not.toContain("couldn't check");
  });
});
