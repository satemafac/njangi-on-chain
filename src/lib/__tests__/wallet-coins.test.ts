/**
 * Wallet balances are one row per exact coin type. Rows used to be merged by
 * struct name — any package's `::usdc::USDC` joined the real USDC row — and
 * unknown coins were scaled at 9 decimals, which the send flow then used.
 */
import { detectFundsArrival } from '@/lib/funds-arrival';
import { buildWalletCoins, findSupportedWalletCoin, walletCoinAmount } from '@/lib/wallet-coins';

const USDC = '0x26b3bc67befc214058ca78ea9a2690298d731a2d4309485ec3d40198063c4abc::usdc::USDC';
const LOOKALIKE_USDC = `0x${'ba'.repeat(32)}::usdc::USDC`;
const OTHER = `0x${'cd'.repeat(32)}::coin::COIN`;

describe('buildWalletCoins', () => {
  it('keeps a look-alike USDC in its own unsupported row, never summed into USDC', () => {
    const coins = buildWalletCoins(
      [
        { coinType: LOOKALIKE_USDC, totalBalance: '999000000' },
        { coinType: USDC, totalBalance: '25000000' },
        { coinType: '0x2::sui::SUI', totalBalance: '1500000000' },
      ],
      'testnet',
    );

    expect(coins).toEqual([
      { coinType: '0x2::sui::SUI', symbol: 'SUI', balance: '1500000000', decimals: 9, supported: true },
      { coinType: USDC, symbol: 'USDC', balance: '25000000', decimals: 6, supported: true },
      { coinType: LOOKALIKE_USDC, symbol: 'USDC', balance: '999000000', decimals: null, supported: false },
    ]);
    expect(findSupportedWalletCoin(coins, 'USDC')?.coinType).toBe(USDC);
    expect(findSupportedWalletCoin(coins, 'USDC')?.balance).toBe('25000000');
  });

  it('gives an unknown coin no decimals, so nothing scales it', () => {
    const [coin] = buildWalletCoins([{ coinType: OTHER, totalBalance: '42' }], 'testnet');
    expect(coin).toMatchObject({ symbol: 'COIN', decimals: null, supported: false });
    expect(walletCoinAmount(coin)).toBeNull();
  });

  it('reads whole units with the coin’s own decimals', () => {
    const coins = buildWalletCoins(
      [
        { coinType: '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI', totalBalance: '2500000000' },
        { coinType: USDC, totalBalance: '300000' },
      ],
      'testnet',
    );
    expect(walletCoinAmount(findSupportedWalletCoin(coins, 'SUI'))).toBe(2.5);
    expect(walletCoinAmount(findSupportedWalletCoin(coins, 'USDC'))).toBe(0.3);
  });

  it('reads a malformed balance as 0', () => {
    const [coin] = buildWalletCoins([{ coinType: USDC, totalBalance: 'NaN' }], 'testnet');
    expect(coin.balance).toBe('0');
  });
});

describe('detectFundsArrival', () => {
  const base = { SUI: 1_000_000_000n, USDC: 5_000_000n };

  it('reports USDC in 6 decimals and SUI in 9', () => {
    expect(detectFundsArrival(base, { ...base, USDC: 30_000_000n })).toEqual({
      symbol: 'USDC',
      received: 25_000_000n,
      label: '25 USDC',
    });
    expect(detectFundsArrival(base, { ...base, SUI: 2_500_000_000n })).toEqual({
      symbol: 'SUI',
      received: 1_500_000_000n,
      label: '1.5 SUI',
    });
  });

  it('does not count a fall (gas spent meanwhile) as an arrival', () => {
    expect(detectFundsArrival(base, { ...base, SUI: 900_000_000n })).toBeNull();
    expect(detectFundsArrival(base, base)).toBeNull();
  });
});
