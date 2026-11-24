// app-packages.ts — which Move packages this app's circles come from.
//
// A Move type counts as ours only when its package is one of these. Anybody
// can publish a package with a `njangi_circles::Circle` struct, so a read
// that checks only `::njangi_circles::Circle` would accept a look-alike
// object as a circle (sui-read.ts readObject `expectType`).

import { getPackageLookupIds, normalizePackageId } from './package-lineage';
import { getCurrentNetwork, getNetworkConfig, type NetworkType } from '@/services/network-config';

/**
 * Known package IDs to always check for circles.
 * This ensures member-only circles from previous deployments remain discoverable.
 */
export const KNOWN_PACKAGE_IDS: Record<'testnet' | 'mainnet', string[]> = {
  testnet: [
    '0x9f916ce4a0a4970e1d466a79ec2a916ec930feac10218e2b94c282a3906d7926',
    '0x8d44cd03809c95bd8b46c3f26cc9f7a62085d0f8b1bb22082b6ff768be0cb78f',
    '0xd0f586ee515a0289be671399c3a4550f96cd556592e10686b820cdba6a56ecdc',
    '0xafdc1beeda48394d47ecfacf2f03592af72dd59f54887099551ca8c369c460cd',
  ],
  mainnet: [
    '0xcec9cfc2bd69cd02e302433333142db502ab1566fab71d8489630b164927177b',
    '0x7bf5274804a6008ebfbd9bfe766defb7fd5aa5fe6777419c2b6531ec99120b55',
  ],
};

/**
 * The packages this app's circles and custody wallets can come from on
 * `network`: the current lineage (original id, the versions that defined
 * types, published-at, the configured package) and earlier deployments
 * (KNOWN_PACKAGE_IDS).
 */
export function appPackageIds(network: NetworkType = getCurrentNetwork()): string[] {
  const ids = new Set(
    getPackageLookupIds({ network, packageId: null, currentPackageId: getNetworkConfig(network).packageId }),
  );
  for (const knownId of KNOWN_PACKAGE_IDS[network] || []) {
    const normalized = normalizePackageId(knownId);
    if (normalized) ids.add(normalized);
  }
  return Array.from(ids);
}

/** The Move types a circle object may have on `network` (readObject's `expectType`). */
export function circleMoveTypes(network?: NetworkType): string[] {
  return appPackageIds(network).map((id) => `${id}::njangi_circles::Circle`);
}

/** The Move types a circle's custody wallet may have on `network`. */
export function custodyWalletMoveTypes(network?: NetworkType): string[] {
  return appPackageIds(network).map((id) => `${id}::njangi_custody::CustodyWallet`);
}
