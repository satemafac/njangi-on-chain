/**
 * resolveStablecoinMetadata with and without a configured USDT. Testnet
 * configures none (its old entry was a malformed address), and an absent
 * USDT must not turn every other coin type into "USDT, 6 decimals".
 */

const USDC = '0x' + 'aa'.repeat(32) + '::usdc::USDC';
const USDT = '0x' + 'bb'.repeat(32) + '::usdt::USDT';
const SUI_USDE = '0x' + 'cc'.repeat(32) + '::sui_usde::SUI_USDE';

let tokens: { SUI: string; USDC: string; USDT?: string; SUI_USDE?: string };

jest.mock('@/services/network-config', () => ({
  getCurrentCoinTypes: () => ({ SUI: '0x2::sui::SUI', USDC, SUI_USDE }),
  getCurrentTokens: () => tokens,
}));

import { resolveStablecoinMetadata } from '../stablecoin-metadata';

describe('resolveStablecoinMetadata', () => {
  describe('on a network without USDT', () => {
    beforeEach(() => {
      tokens = { SUI: '0x2::sui::SUI', USDC, SUI_USDE };
    });

    it('does not label other coin types as USDT', () => {
      expect(resolveStablecoinMetadata(SUI_USDE)).toEqual({ label: 'SUI_USDE', coinType: SUI_USDE, decimals: 9 });
      expect(resolveStablecoinMetadata(USDC)).toEqual({ label: 'USDC', coinType: USDC, decimals: 6 });
    });

    it('still recognises USDT by symbol', () => {
      expect(resolveStablecoinMetadata('USDT')).toEqual({ label: 'USDT', coinType: 'USDT', decimals: 6 });
    });
  });

  describe('on a network with USDT', () => {
    beforeEach(() => {
      tokens = { SUI: '0x2::sui::SUI', USDC, USDT, SUI_USDE };
    });

    it('maps the configured coin type and the symbol to it', () => {
      expect(resolveStablecoinMetadata(USDT)).toEqual({ label: 'USDT', coinType: USDT, decimals: 6 });
      expect(resolveStablecoinMetadata('usdt')).toEqual({ label: 'USDT', coinType: USDT, decimals: 6 });
      expect(resolveStablecoinMetadata(SUI_USDE).label).toBe('SUI_USDE');
    });
  });
});
