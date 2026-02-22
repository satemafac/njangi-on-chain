import {
  mapCurrencyCodeToIntent,
  mapIntentToMoonPayCurrency,
  normalizeOnrampProviderFlag,
  shouldUseCoinbaseProvider,
} from '@/lib/onramp-provider';

describe('onramp provider helpers', () => {
  it('normalizes provider flag values safely', () => {
    expect(normalizeOnrampProviderFlag(undefined)).toBe('auto');
    expect(normalizeOnrampProviderFlag('coinbase')).toBe('coinbase');
    expect(normalizeOnrampProviderFlag('moonpay')).toBe('moonpay');
    expect(normalizeOnrampProviderFlag('AUTO')).toBe('auto');
    expect(normalizeOnrampProviderFlag('unknown')).toBe('auto');
  });

  it('decides whether Coinbase should be used', () => {
    expect(shouldUseCoinbaseProvider('coinbase', true)).toBe(true);
    expect(shouldUseCoinbaseProvider('auto', true)).toBe(true);
    expect(shouldUseCoinbaseProvider('moonpay', true)).toBe(false);
    expect(shouldUseCoinbaseProvider('coinbase', false)).toBe(false);
  });

  it('maps currency code and intent correctly', () => {
    expect(mapCurrencyCodeToIntent('sui')).toBe('SUI');
    expect(mapCurrencyCodeToIntent('SUI')).toBe('SUI');
    expect(mapCurrencyCodeToIntent('usdc')).toBe('USDC_ON_SUI');
    expect(mapCurrencyCodeToIntent('anything-else')).toBe('USDC_ON_SUI');
    expect(mapIntentToMoonPayCurrency('SUI')).toBe('sui');
    expect(mapIntentToMoonPayCurrency('USDC_ON_SUI')).toBe('usdc');
  });
});
