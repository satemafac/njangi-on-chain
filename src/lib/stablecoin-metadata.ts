import { getCurrentCoinTypes, getCurrentTokens } from '@/services/network-config';

export interface StablecoinMetadata {
  label: string;
  coinType: string;
  decimals: number;
}

export function resolveStablecoinMetadata(targetCoinType?: string | null): StablecoinMetadata {
  const coinTypes = getCurrentCoinTypes();
  const tokens = getCurrentTokens();
  const normalizedTarget = (targetCoinType || '').trim();
  const normalizedUpper = normalizedTarget.toUpperCase();

  const usdcCoinType = coinTypes.USDC || tokens.USDC || normalizedTarget;
  // Optional: testnet configures no USDT. Defaulting it to the target would
  // make every non-USDC target match the USDT branch below.
  const usdtCoinType = tokens.USDT || '';
  const suiUsdeCoinType = coinTypes.SUI_USDE || tokens.SUI_USDE || normalizedTarget;

  if (
    !normalizedTarget ||
    normalizedUpper === 'USDC' ||
    normalizedTarget === usdcCoinType ||
    normalizedTarget === tokens.USDC
  ) {
    return { label: 'USDC', coinType: usdcCoinType, decimals: 6 };
  }

  if (normalizedUpper === 'USDT' || (usdtCoinType && normalizedTarget === usdtCoinType)) {
    return { label: 'USDT', coinType: usdtCoinType || normalizedTarget, decimals: 6 };
  }

  if (
    normalizedUpper === 'SUI_USDE' ||
    normalizedTarget === suiUsdeCoinType ||
    normalizedTarget === tokens.SUI_USDE
  ) {
    return { label: 'SUI_USDE', coinType: suiUsdeCoinType, decimals: 9 };
  }

  const lowerTarget = normalizedTarget.toLowerCase();
  if (lowerTarget.includes('usdt')) {
    return { label: 'USDT', coinType: normalizedTarget, decimals: 6 };
  }

  if (lowerTarget.includes('sui_usde') || lowerTarget.includes('usde')) {
    return { label: 'SUI_USDE', coinType: normalizedTarget, decimals: 9 };
  }

  return { label: normalizedTarget || 'USDC', coinType: normalizedTarget, decimals: 6 };
}
