const mockGetBalance = jest.fn();

jest.mock('@mysten/sui/client', () => ({
  SuiClient: jest.fn(() => ({
    getBalance: mockGetBalance,
  })),
}));

import {
  clearWalletBalanceCache,
  refreshSuiBalance,
  refreshUsdcBalance,
  refreshWalletBalances,
} from '@/lib/wallet';

describe('wallet balance helpers', () => {
  const walletAddress =
    '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcd';

  beforeEach(() => {
    jest.clearAllMocks();
    clearWalletBalanceCache();
    process.env.NEXT_PUBLIC_SUI_NETWORK = 'testnet';
    process.env.NEXT_PUBLIC_TESTNET_USDC =
      '0x26b3bc67befc214058ca78ea9a2690298d731a2d4309485ec3d40198063c4abc::usdc::USDC';
    process.env.NEXT_PUBLIC_TESTNET_RPC_URL = 'https://fullnode.testnet.sui.io:443';
  });

  it('refreshes SUI balance from chain', async () => {
    mockGetBalance.mockResolvedValue({ totalBalance: '1500000000' });

    const result = await refreshSuiBalance(walletAddress, { forceRefresh: true });

    expect(result.symbol).toBe('SUI');
    expect(result.totalBalance).toBe('1500000000');
    expect(result.source).toBe('chain');
    expect(mockGetBalance).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: walletAddress,
        coinType: '0x2::sui::SUI',
      }),
    );
  });

  it('uses cache for repeated USDC balance reads within ttl', async () => {
    mockGetBalance.mockResolvedValue({ totalBalance: '42' });

    const first = await refreshUsdcBalance(walletAddress);
    const second = await refreshUsdcBalance(walletAddress);

    expect(first.totalBalance).toBe('42');
    expect(second.totalBalance).toBe('42');
    expect(first.source).toBe('chain');
    expect(second.source).toBe('cache');
    expect(mockGetBalance).toHaveBeenCalledTimes(1);
  });

  it('returns combined snapshot for SUI and USDC', async () => {
    mockGetBalance
      .mockResolvedValueOnce({ totalBalance: '100' })
      .mockResolvedValueOnce({ totalBalance: '200' });

    const snapshot = await refreshWalletBalances(walletAddress, { forceRefresh: true });

    expect(snapshot.walletAddress).toBe(walletAddress);
    expect(snapshot.sui.totalBalance).toBe('100');
    expect(snapshot.usdc.totalBalance).toBe('200');
    expect(snapshot.source).toBe('chain');
  });
});
