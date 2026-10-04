/**
 * resolveStablecoinMetadata knows one stablecoin, the network's USDC, by exact
 * type. It used to guess: an unknown type got 6 decimals and its raw type as
 * its label, anything containing "usde" got 9, and an absent USDT once made
 * every other coin read as "USDT, 6 decimals". Every coin but USDC now has
 * no decimals, so nothing scales it.
 */

jest.mock('@/services/network-config', () => ({
  getCurrentNetwork: () => 'testnet',
}));

import { resolveStablecoinMetadata } from '../stablecoin-metadata';

const USDC = '0x26b3bc67befc214058ca78ea9a2690298d731a2d4309485ec3d40198063c4abc::usdc::USDC';
const USDT = '0x' + 'bb'.repeat(32) + '::usdt::USDT';
const SUI_USDE = '0x' + 'cc'.repeat(32) + '::sui_usde::SUI_USDE';
const LOOKALIKE_USDC = '0x' + 'dd'.repeat(32) + '::usdc::USDC';

describe('resolveStablecoinMetadata', () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.NEXT_PUBLIC_TESTNET_USDC;
    delete process.env.NEXT_PUBLIC_TESTNET_USDC;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.NEXT_PUBLIC_TESTNET_USDC;
    else process.env.NEXT_PUBLIC_TESTNET_USDC = saved;
  });

  it('resolves the network USDC by type, by symbol, and when unnamed', () => {
    const usdc = { label: 'USDC', coinType: USDC, decimals: 6 };
    expect(resolveStablecoinMetadata(USDC)).toEqual(usdc);
    expect(resolveStablecoinMetadata(USDC.slice(2))).toEqual(usdc);
    expect(resolveStablecoinMetadata('usdc')).toEqual(usdc);
    expect(resolveStablecoinMetadata('')).toEqual(usdc);
    expect(resolveStablecoinMetadata(null)).toEqual(usdc);
  });

  it('gives every other coin no decimals instead of a guess', () => {
    expect(resolveStablecoinMetadata(SUI_USDE)).toEqual({ label: 'SUI_USDE', coinType: SUI_USDE, decimals: null });
    expect(resolveStablecoinMetadata(USDT)).toEqual({ label: 'USDT', coinType: USDT, decimals: null });
    expect(resolveStablecoinMetadata(LOOKALIKE_USDC)).toEqual({
      label: 'USDC',
      coinType: LOOKALIKE_USDC,
      decimals: null,
    });
    expect(resolveStablecoinMetadata('USDT')).toEqual({ label: 'USDT', coinType: '', decimals: null });
  });

  it('leaves USDC unscaled when its configured type is not a coin type', () => {
    process.env.NEXT_PUBLIC_TESTNET_USDC = '0xyour_testnet_usdc_type';
    expect(resolveStablecoinMetadata('')).toEqual({ label: 'USDC', coinType: '', decimals: null });
  });
});
