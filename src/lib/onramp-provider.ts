import type { CoinbaseAssetIntent } from '@/types/coinbase-onramp';

export type OnrampProviderFlag = 'auto' | 'coinbase' | 'moonpay';

export function normalizeOnrampProviderFlag(value?: string): OnrampProviderFlag {
  const normalized = (value ?? 'auto').trim().toLowerCase();
  if (normalized === 'coinbase') {
    return 'coinbase';
  }
  if (normalized === 'moonpay') {
    return 'moonpay';
  }
  return 'auto';
}

export function shouldUseCoinbaseProvider(
  providerFlag: OnrampProviderFlag,
  coinbaseEnabled: boolean,
): boolean {
  if (!coinbaseEnabled) {
    return false;
  }
  return providerFlag === 'coinbase' || providerFlag === 'auto';
}

export function mapCurrencyCodeToIntent(
  currencyCode: string,
): CoinbaseAssetIntent {
  return currencyCode.trim().toUpperCase() === 'SUI' ? 'SUI' : 'USDC_ON_SUI';
}

export function mapIntentToMoonPayCurrency(
  intent: CoinbaseAssetIntent,
): 'sui' | 'usdc' {
  return intent === 'SUI' ? 'sui' : 'usdc';
}
