export type CoinbaseAssetIntent = 'SUI' | 'USDC_ON_SUI';

export interface CoinbaseSessionTokenPayload {
  provider: 'coinbase';
  token: string;
  channelId?: string;
  assetIntent: CoinbaseAssetIntent;
}

export interface CoinbaseApiErrorPayload {
  provider: 'coinbase';
  error: string;
  message: string;
  fallbackProvider: 'moonpay' | null;
}

export interface CoinbaseSupportedAsset {
  intent: CoinbaseAssetIntent;
  symbol: 'SUI' | 'USDC';
  network: 'sui';
  assetId?: string;
  iconUrl?: string;
}

export interface CoinbasePaymentMethod {
  id: string;
  min: string | null;
  max: string | null;
}

export interface CoinbaseOptionsPayload {
  provider: 'coinbase';
  eligible: boolean;
  country: string;
  subdivision?: string;
  supportedAssets: CoinbaseSupportedAsset[];
  supportedIntents: CoinbaseAssetIntent[];
  paymentMethods: CoinbasePaymentMethod[];
  fallbackProvider: 'moonpay' | null;
  reasonCode?: string;
  message?: string;
}
