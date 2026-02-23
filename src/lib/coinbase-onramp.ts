import type { CoinbaseAssetIntent } from '@/types/coinbase-onramp';

export const COINBASE_HOSTED_ONRAMP_BASE_URL =
  'https://pay.coinbase.com/buy/select-asset';

export function mapIntentToCoinbaseAsset(
  preferredAssetIntent: CoinbaseAssetIntent,
): 'SUI' | 'USDC' {
  return preferredAssetIntent === 'SUI' ? 'SUI' : 'USDC';
}

export interface BuildCoinbaseOnrampUrlParams {
  sessionToken: string;
  preferredAssetIntent: CoinbaseAssetIntent;
  fiatAmount?: number;
  fiatCurrency?: string;
  redirectUrl?: string;
}

export function buildCoinbaseOnrampUrl(
  params: BuildCoinbaseOnrampUrlParams,
): string {
  const url = new URL(COINBASE_HOSTED_ONRAMP_BASE_URL);

  url.searchParams.set('sessionToken', params.sessionToken);
  url.searchParams.set('defaultAsset', mapIntentToCoinbaseAsset(params.preferredAssetIntent));
  url.searchParams.set('defaultNetwork', 'sui');
  url.searchParams.set('defaultExperience', 'buy');

  if (params.fiatAmount && Number.isFinite(params.fiatAmount)) {
    url.searchParams.set('presetFiatAmount', String(params.fiatAmount));
  }

  if (params.fiatCurrency) {
    url.searchParams.set('fiatCurrency', params.fiatCurrency.toUpperCase());
  }

  if (params.redirectUrl) {
    url.searchParams.set('redirectUrl', params.redirectUrl);
  }

  return url.toString();
}
