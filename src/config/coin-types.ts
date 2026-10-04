// coin-types.ts — the one place a network's SUI and USDC coin types come from.
//
// The MVP settles in exactly two coins: native SUI and the network's native
// Circle-issued USDC. Every map, constant and helper that names a coin type
// (network-config's `coinTypes` and `tokens`, wallet.ts, the API constants)
// resolves USDC through usdcCoinTypeForNetwork, so they cannot disagree. They
// did: testnet `tokens.USDC` named a package (0x9e89…) that does not exist on
// chain while `coinTypes.USDC` named the live one, and wallet.ts read the env
// value with `??`, so an empty NEXT_PUBLIC_<NET>_USDC became "" there and the
// default everywhere else.
//
// No imports beyond the network type: network-config.ts imports this module.

import type { NetworkType } from './public-env';

export const SUI_COIN_TYPE = '0x2::sui::SUI';

/**
 * The native Circle USDC of each network: what exchanges deliver over Sui.
 * Not the Wormhole-bridged `::coin::COIN`. Testnet's is the type every live
 * testnet custody wallet holds (census 2026-10-03).
 */
export const DEFAULT_USDC_COIN_TYPES: Readonly<Record<NetworkType, string>> = {
  testnet: '0x26b3bc67befc214058ca78ea9a2690298d731a2d4309485ec3d40198063c4abc::usdc::USDC',
  mainnet: '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC',
};

/**
 * `0x<1-64 hex>::module::Name`, the shape of a non-generic coin type. Both
 * the app and scripts/validate-env.mjs apply it; keep the two in step.
 */
export const COIN_TYPE_PATTERN = /^0x[0-9a-fA-F]{1,64}::[A-Za-z_][A-Za-z0-9_]*::[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The network's USDC type: NEXT_PUBLIC_<NET>_USDC when it holds a value, the
 * default otherwise. Blank counts as unset. A malformed value is returned as
 * is rather than swapped for the default: validate-env reports it, and the
 * supported-coin lookups (src/lib/supported-coins.ts) refuse to match it, so
 * nothing signs or scales with it.
 */
export function usdcCoinTypeForNetwork(network: NetworkType): string {
  // Literal process.env reads: Next.js only inlines NEXT_PUBLIC_* values into
  // the browser bundle when the property is spelled out.
  const configured =
    network === 'mainnet' ? process.env.NEXT_PUBLIC_MAINNET_USDC : process.env.NEXT_PUBLIC_TESTNET_USDC;
  const trimmed = configured?.trim() ?? '';
  return trimmed !== '' ? trimmed : DEFAULT_USDC_COIN_TYPES[network];
}
