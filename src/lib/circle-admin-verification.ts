// circle-admin-verification.ts — On-chain circle-admin lookup.
//
// Mirrors `/api/circles/[id]/verify-admin.ts`: the circle object's `admin`
// field on chain is the source of truth for who may administer a circle.
// Server-side guards (see `src/middleware/admin-auth.middleware.ts`) compare
// the caller's session-verified address against this value instead of
// trusting client-supplied identity.

import { getNetworkConfig } from '../services/network-config';
import { getPooledSuiClient } from '../services/sui-rpc-failover';
import type { NetworkType } from '../services/whatsapp-registry-service';

/** Normalize addresses the same way verify-admin.ts does before comparing. */
export function normalizeSuiAddress(address: string): string {
  return address.toLowerCase().replace(/^0x/, '');
}

export function suiAddressesEqual(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (!a || !b) {
    return false;
  }
  return normalizeSuiAddress(a) === normalizeSuiAddress(b);
}

export interface CircleAuthority {
  /** The circle's `admin` field, or `null` when the object carries none. */
  admin: string | null;
  /** Object id of the circle's `members` Table, keyed by member address. */
  membersTableId: string | null;
}

function readTableId(value: unknown): string | null {
  // A Table field renders as { type, fields: { id: { id }, size } }.
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as { fields?: unknown; id?: unknown };
  const inner = (record.fields && typeof record.fields === 'object'
    ? record.fields
    : record) as { id?: unknown };
  const uid = inner.id && typeof inner.id === 'object' ? (inner.id as { id?: unknown }).id : null;
  return typeof uid === 'string' ? uid : null;
}

/**
 * Reads the circle object once: who administers it and where its members
 * are recorded. Returns `null` when the circle does not exist.
 * Throws on RPC failure — callers must fail closed.
 */
export async function fetchCircleAuthority(
  circleId: string,
  network: NetworkType,
): Promise<CircleAuthority | null> {
  const networkConfig = getNetworkConfig(network);
  const suiClient = getPooledSuiClient({ network, rpcUrl: networkConfig.rpcUrl });

  const circleObject = await suiClient.getObject({
    id: circleId,
    options: { showContent: true },
  });

  const content = circleObject.data?.content;
  if (!content || content.dataType !== 'moveObject') {
    return null;
  }

  const fields = (content as { fields?: { admin?: unknown; members?: unknown } }).fields;
  return {
    admin: typeof fields?.admin === 'string' ? fields.admin : null,
    membersTableId: readTableId(fields?.members),
  };
}

/**
 * Fetches the admin address recorded on the on-chain circle object.
 * Returns `null` when the circle does not exist or carries no admin field.
 * Throws on RPC failure — callers must fail closed.
 */
export async function fetchCircleAdminAddress(
  circleId: string,
  network: NetworkType,
): Promise<string | null> {
  const authority = await fetchCircleAuthority(circleId, network);
  return authority?.admin ?? null;
}
