/**
 * One USDC type per network. Testnet `tokens.USDC` used to name a package
 * (0x9e89…) that does not exist on chain while `coinTypes.USDC` named the
 * live one, and wallet.ts turned an empty NEXT_PUBLIC_<NET>_USDC into "".
 * Every map and helper now resolves USDC through usdcCoinTypeForNetwork.
 */
import { DEFAULT_USDC_COIN_TYPES, SUI_COIN_TYPE, usdcCoinTypeForNetwork } from '@/config/coin-types';
import { getNetworkConfig } from '@/services/network-config';

const KEYS = ['NEXT_PUBLIC_TESTNET_USDC', 'NEXT_PUBLIC_MAINNET_USDC'] as const;
const LIVE_TESTNET_USDC = '0x26b3bc67befc214058ca78ea9a2690298d731a2d4309485ec3d40198063c4abc::usdc::USDC';
const MISSING_TESTNET_USDC = '0x9e89965f542887a8f0383451ba553fedf62c04e4dc68f60dec5b8d7ad1436bd6::usdc::USDC';

describe('usdcCoinTypeForNetwork', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const key of KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });
  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('defaults to the native USDC of each network, the live type on testnet', () => {
    expect(usdcCoinTypeForNetwork('testnet')).toBe(LIVE_TESTNET_USDC);
    expect(usdcCoinTypeForNetwork('mainnet')).toBe(DEFAULT_USDC_COIN_TYPES.mainnet);
  });

  it('treats a blank value as unset, never as the type ""', () => {
    process.env.NEXT_PUBLIC_TESTNET_USDC = '';
    process.env.NEXT_PUBLIC_MAINNET_USDC = '   ';
    expect(usdcCoinTypeForNetwork('testnet')).toBe(LIVE_TESTNET_USDC);
    expect(usdcCoinTypeForNetwork('mainnet')).toBe(DEFAULT_USDC_COIN_TYPES.mainnet);
  });

  it('uses a configured value, trimmed', () => {
    process.env.NEXT_PUBLIC_TESTNET_USDC = `  ${'0x' + 'ab'.repeat(32)}::usdc::USDC  `;
    expect(usdcCoinTypeForNetwork('testnet')).toBe(`0x${'ab'.repeat(32)}::usdc::USDC`);
  });

  it.each(['testnet', 'mainnet'] as const)(
    'network-config names the same USDC in coinTypes and tokens on %s',
    (network) => {
      for (const configured of [undefined, '', `0x${'cd'.repeat(32)}::usdc::USDC`]) {
        if (configured === undefined) delete process.env[`NEXT_PUBLIC_${network.toUpperCase()}_USDC`];
        else process.env[`NEXT_PUBLIC_${network.toUpperCase()}_USDC`] = configured;
        const config = getNetworkConfig(network);
        expect(config.coinTypes.USDC).toBe(usdcCoinTypeForNetwork(network));
        expect(config.tokens.USDC).toBe(config.coinTypes.USDC);
        expect(config.coinTypes.SUI).toBe(SUI_COIN_TYPE);
        expect(config.tokens.SUI).toBe(SUI_COIN_TYPE);
      }
    },
  );

  it('never names the testnet package that does not exist', () => {
    const config = getNetworkConfig('testnet');
    expect(config.tokens.USDC).not.toBe(MISSING_TESTNET_USDC);
    expect(config.coinTypes.USDC).not.toBe(MISSING_TESTNET_USDC);
  });
});
