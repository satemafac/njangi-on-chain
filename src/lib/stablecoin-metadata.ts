// stablecoin-metadata.ts — label and decimals for a custody wallet's
// stablecoin, as the recovery and balance cards show it.
//
// The only stablecoin the app supports is the network's USDC, known by exact
// type (src/lib/supported-coins.ts). This used to guess: an unknown type got
// 6 decimals and its raw type string as its label, and anything containing
// "usde" got 9. Every other coin now comes back with `decimals: null`, which
// the cards render as an unsupported coin rather than a scaled number.

import { getCurrentNetwork } from '@/services/network-config';
import { normalizeCoinType, resolveSupportedCoin, supportedCoinBySymbol } from '@/lib/supported-coins';

export interface StablecoinMetadata {
  label: string;
  coinType: string;
  /** 6 for the network's USDC; null for every other coin, which is never scaled. */
  decimals: number | null;
}

export function resolveStablecoinMetadata(targetCoinType?: string | null): StablecoinMetadata {
  const network = getCurrentNetwork();
  const target = (targetCoinType || '').trim();

  // Unnamed, or named by symbol: the network's USDC.
  if (!target || target.toUpperCase() === 'USDC') {
    const usdc = supportedCoinBySymbol('USDC', network);
    return usdc
      ? { label: 'USDC', coinType: usdc.coinType, decimals: usdc.decimals }
      : { label: 'USDC', coinType: '', decimals: null };
  }

  const coin = resolveSupportedCoin(target, network);
  if (coin?.symbol === 'USDC') {
    return { label: 'USDC', coinType: coin.coinType, decimals: coin.decimals };
  }

  // Anything else, USDT and suiUSDe included, is not supported here.
  const normalized = normalizeCoinType(target);
  return {
    label: normalized ? normalized.split('::').pop() || target : target.toUpperCase(),
    coinType: normalized ? target : '',
    decimals: null,
  };
}
