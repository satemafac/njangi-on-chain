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
  walletAddress: string;
  preferredAssetIntent: CoinbaseAssetIntent;
  fiatAmount?: number;
  fiatCurrency?: string;
}

export function buildCoinbaseOnrampUrl(
  params: BuildCoinbaseOnrampUrlParams,
): string {
  const url = new URL(COINBASE_HOSTED_ONRAMP_BASE_URL);
  const addresses = [
    {
      address: params.walletAddress,
      blockchains: ['sui'],
    },
  ];

  url.searchParams.set('sessionToken', params.sessionToken);
  url.searchParams.set(
    'assets',
    mapIntentToCoinbaseAsset(params.preferredAssetIntent),
  );
  url.searchParams.set('addresses', JSON.stringify(addresses));

  if (params.fiatAmount && Number.isFinite(params.fiatAmount)) {
    url.searchParams.set('presetFiatAmount', String(params.fiatAmount));
  }

  if (params.fiatCurrency) {
    url.searchParams.set('fiatCurrency', params.fiatCurrency.toUpperCase());
  }

  return url.toString();
}
