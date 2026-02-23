import {
  buildCoinbaseOnrampUrl,
  mapIntentToCoinbaseAsset,
} from '@/lib/coinbase-onramp';

describe('coinbase onramp helpers', () => {
  it('maps app intent to Coinbase asset symbol', () => {
    expect(mapIntentToCoinbaseAsset('SUI')).toBe('SUI');
    expect(mapIntentToCoinbaseAsset('USDC_ON_SUI')).toBe('USDC');
  });

  it('builds hosted onramp URL using secure init session parameters', () => {
    const url = buildCoinbaseOnrampUrl({
      sessionToken: 'session-token-123',
      preferredAssetIntent: 'USDC_ON_SUI',
      fiatAmount: 75,
      fiatCurrency: 'usd',
    });

    const parsed = new URL(url);

    expect(parsed.origin + parsed.pathname).toBe(
      'https://pay.coinbase.com/buy/select-asset',
    );
    expect(parsed.searchParams.get('sessionToken')).toBe('session-token-123');
    expect(parsed.searchParams.get('defaultAsset')).toBe('USDC');
    expect(parsed.searchParams.get('defaultNetwork')).toBe('sui');
    expect(parsed.searchParams.get('defaultExperience')).toBe('buy');
    expect(parsed.searchParams.get('presetFiatAmount')).toBe('75');
    expect(parsed.searchParams.get('fiatCurrency')).toBe('USD');
    expect(parsed.searchParams.get('addresses')).toBeNull();
    expect(parsed.searchParams.get('assets')).toBeNull();
  });
});
