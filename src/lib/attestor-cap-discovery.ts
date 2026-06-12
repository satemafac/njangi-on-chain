// attestor-cap-discovery.ts — Query owned AttestorCap objects for the
// signed-in operator so the Phase 8 admin console can pre-fill the cap
// id without operators copying it from a runbook.
//
// Returns all caps the user currently owns; single-cap operators get a
// deterministic prefill, and multi-cap operators can still pick from the
// UI. Designed to run in the browser.

import type { SuiClient } from '@mysten/sui/client';
import type { NetworkType } from '../services/whatsapp-registry-service';
import { getNetworkConfig } from '../services/network-config';
import { getPooledSuiClient } from '../services/sui-rpc-failover';

export interface AttestorCapRef {
  objectId: string;
  version: string;
  digest: string;
}

function packageIdFor(network: NetworkType): string {
  const envKey =
    network === 'mainnet'
      ? 'NEXT_PUBLIC_MAINNET_PACKAGE_ID'
      : 'NEXT_PUBLIC_TESTNET_PACKAGE_ID';
  const id = process.env[envKey];
  if (!id) {
    throw new Error(`Missing ${envKey}; cannot discover AttestorCap.`);
  }
  return id;
}

export async function findOwnedAttestorCaps(
  owner: string,
  network: NetworkType,
  client?: SuiClient,
): Promise<AttestorCapRef[]> {
  if (!owner) return [];
  const packageId = packageIdFor(network);
  const rpcClient =
    client ??
    getPooledSuiClient({
      network,
      rpcUrl: getNetworkConfig(network).rpcUrl,
    });
  const structType = `${packageId}::njangi_compliance::AttestorCap`;
  const caps: AttestorCapRef[] = [];
  let cursor: string | null | undefined = null;
  for (let page = 0; page < 5; page += 1) {
    const response = await rpcClient.getOwnedObjects({
      owner,
      filter: { StructType: structType },
      options: { showContent: false },
      cursor,
    });
    for (const item of response.data) {
      const data = item.data;
      if (!data?.objectId) continue;
      caps.push({
        objectId: data.objectId,
        version: String(data.version ?? ''),
        digest: data.digest ?? '',
      });
    }
    if (!response.hasNextPage || !response.nextCursor) break;
    cursor = response.nextCursor;
  }
  return caps;
}
