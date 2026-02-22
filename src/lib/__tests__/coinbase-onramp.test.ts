import {
  buildCoinbaseOnrampUrl,
  mapIntentToCoinbaseAsset,
} from '@/lib/coinbase-onramp';

describe('coinbase onramp helpers', () => {
  it('maps app intent to Coinbase asset symbol', () => {
    expect(mapIntentToCoinbaseAsset('SUI')).toBe('SUI');
    expect(mapIntentToCoinbaseAsset('USDC_ON_SUI')).toBe('USDC');
  });

  it('builds hosted onramp URL with session token and encoded addresses', () => {
    const url = buildCoinbaseOnrampUrl({
      sessionToken: 'session-token-123',
      walletAddress:
        '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcd',
      preferredAssetIntent: 'USDC_ON_SUI',
      fiatAmount: 75,
      fiatCurrency: 'usd',
    });

    const parsed = new URL(url);

    expect(parsed.origin + parsed.pathname).toBe(
      'https://pay.coinbase.com/buy/select-asset',
    );
    expect(parsed.searchParams.get('sessionToken')).toBe('session-token-123');
    expect(parsed.searchParams.get('assets')).toBe('USDC');
    expect(parsed.searchParams.get('presetFiatAmount')).toBe('75');
    expect(parsed.searchParams.get('fiatCurrency')).toBe('USD');

    const addressesRaw = parsed.searchParams.get('addresses');
    expect(addressesRaw).toBeTruthy();
    const addresses = JSON.parse(addressesRaw ?? '[]') as Array<{
      address: string;
      blockchains: string[];
    }>;

    expect(addresses).toEqual([
      {
        address:
          '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcd',
        blockchains: ['sui'],
      },
    ]);
  });
});
