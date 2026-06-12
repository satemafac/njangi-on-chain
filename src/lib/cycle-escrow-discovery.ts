// cycle-escrow-discovery.ts — Auto-discover the live per-cycle escrow for a
// circle so members never have to copy/paste object ids. Uses the
// `CycleEscrowOpened` event emitted by `njangi_cycle_escrow::open_cycle`.

import type { SuiClient } from '@mysten/sui/client';
import type { NetworkType } from '../services/whatsapp-registry-service';
import { getNetworkConfig, getPackageIdForNetwork } from '../services/network-config';
import { getPublishedPackageMetadata } from './circle-chain';
import { getPooledSuiClient } from '../services/sui-rpc-failover';

export interface CycleEscrowSummary {
  escrowId: string;
  circleId: string;
  cycleNo: number;
  recipient: string;
  contributionAmount: string;
  requiredContributors: number;
  assetType: string;
  openedAtMs: number;
}

export interface CycleEscrowLiveState {
  escrowId: string;
  cycleNo: number;
  recipient: string;
  contributionAmount: string;
  requiredContributors: number;
  contributorsSoFar: number;
  totalContributed: string;
  assetType: string;
  finalized: boolean;
  claimed: boolean;
  contributedMembers: string[];
  /** Full rotation member list from the frozen snapshot (includes the
   *  recipient). The UI uses this to render a per-member progress ring. */
  members: string[];
  /** Phase 7: mirrors the on-chain `requires_attestation` flag. UI uses
   *  this to decide whether to route through the gated contribute/finalize
   *  paths that require a valid ComplianceAttestation. */
  requiresAttestation: boolean;
}

function packageIdFor(network: NetworkType): string {
  // Prefer the canonical resolver (handles legacy NEXT_PUBLIC_PACKAGE_ID
  // fallback). Browser bundles can return undefined from direct
  // process.env reads if the dev server was started before .env.local
  // was populated, which would silently break round discovery.
  const fromConfig = getPackageIdForNetwork(network);
  if (fromConfig && fromConfig.trim() !== '') return fromConfig;
  const envKey =
    network === 'mainnet'
      ? 'NEXT_PUBLIC_MAINNET_PACKAGE_ID'
      : 'NEXT_PUBLIC_TESTNET_PACKAGE_ID';
  const id = process.env[envKey];
  if (!id) {
    throw new Error(
      `Missing ${envKey}; cannot auto-discover CycleEscrow. Restart the dev server.`,
    );
  }
  return id;
}

// Move struct/event types are anchored to the package's ORIGINAL id, not the
// published-at, and that identity is preserved across upgrades. So a
// `MoveEventType` filter built from the (post-upgrade) published-at id matches
// nothing — querying `CycleEscrowOpened` events after a v1→v3 upgrade silently
// returned zero rows, which surfaced as a perpetual "round hasn't been opened
// yet" even though the open tx had landed. Prefer the original id for event
// queries; fall back to the published-at when no lineage is recorded.
function eventTypePackageIdFor(network: NetworkType): string {
  const { originalId } = getPublishedPackageMetadata(network);
  if (originalId && originalId.trim() !== '') return originalId;
  return packageIdFor(network);
}

function decodeBytes(raw: unknown): Uint8Array {
  if (!raw) return new Uint8Array();
  if (raw instanceof Uint8Array) return raw;
  if (Array.isArray(raw)) return new Uint8Array(raw as number[]);
  if (typeof raw === 'string') {
    return /^[0-9a-fA-F]+$/.test(raw)
      ? new Uint8Array(Buffer.from(raw, 'hex'))
      : new Uint8Array(Buffer.from(raw, 'base64'));
  }
  return new Uint8Array();
}

function bytesToCanonicalType(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function normalizeAddress(value: string): string {
  const trimmed = value.trim().toLowerCase();
  return trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
}

function matchesCircle(eventCircle: unknown, target: string): boolean {
  if (typeof eventCircle !== 'string') return false;
  return normalizeAddress(eventCircle) === normalizeAddress(target);
}

/**
 * Queries recent `CycleEscrowOpened` events and returns the most recently
 * opened escrow matching the supplied circle. Optionally filters by a
 * specific cycle number; pass `undefined` to pick the latest regardless.
 */
export async function findCurrentCycleEscrow(
  client: SuiClient,
  network: NetworkType,
  circleId: string,
  opts?: { cycleNo?: number; limit?: number },
): Promise<CycleEscrowSummary | null> {
  const packageId = eventTypePackageIdFor(network);
  const limit = opts?.limit ?? 50;
  try {
    const events = await client.queryEvents({
      query: { MoveEventType: `${packageId}::njangi_cycle_escrow::CycleEscrowOpened` },
      limit,
      order: 'descending',
    });

    for (const event of events.data) {
      const parsed = (event.parsedJson ?? {}) as Record<string, unknown>;
      if (!matchesCircle(parsed.circle_id, circleId)) continue;
      if (
        typeof opts?.cycleNo === 'number' &&
        Number(parsed.cycle_no) !== opts.cycleNo
      ) {
        continue;
      }
      const assetBytes = decodeBytes(parsed.asset_type);
      const escrowId = typeof parsed.escrow_id === 'string' ? parsed.escrow_id : '';
      if (!escrowId) continue;
      return {
        escrowId,
        circleId: String(parsed.circle_id ?? circleId),
        cycleNo: Number(parsed.cycle_no ?? 0),
        recipient: String(parsed.recipient ?? ''),
        contributionAmount: String(parsed.contribution_amount ?? '0'),
        requiredContributors: Number(parsed.required_contributors ?? 0),
        assetType: bytesToCanonicalType(assetBytes),
        openedAtMs: Number(parsed.opened_at_ms ?? 0),
      };
    }
    return null;
  } catch (err) {
    console.warn('[cycle-escrow-discovery] Failed to query CycleEscrowOpened', err);
    return null;
  }
}

/**
 * Fetches the current on-chain state of a CycleEscrow for UI progress
 * displays ("4 of 7 members have paid in", "finalized / claimed").
 */
export async function readCycleEscrowState(
  escrowId: string,
  network: NetworkType,
  client?: SuiClient,
): Promise<CycleEscrowLiveState | null> {
  const rpcClient =
    client ??
    getPooledSuiClient({
      network,
      rpcUrl: getNetworkConfig(network).rpcUrl,
    });
  const obj = await rpcClient.getObject({
    id: escrowId,
    options: { showContent: true },
  });
  if (!obj.data?.content || obj.data.content.dataType !== 'moveObject') {
    return null;
  }
  const fields =
    (obj.data.content as { fields: Record<string, unknown> }).fields;

  const snapshotWrapper = (fields.snapshot as { fields?: Record<string, unknown> } | undefined)
    ?.fields;
  const snapshot = snapshotWrapper ?? (fields.snapshot as Record<string, unknown> | undefined);
  if (!snapshot) return null;

  const membersRaw = snapshot.members;
  const members = Array.isArray(membersRaw) ? membersRaw.map((m) => String(m)) : [];
  const assetBytes = decodeBytes(snapshot.asset_type);

  const contributedTable = fields.contributed as Record<string, unknown> | undefined;
  // `Table<address, bool>` surfaces size via `fields.size` in RPC output;
  // fall back to the separate contributors_count field we track on chain.
  const tableSize = contributedTable && typeof contributedTable === 'object'
    ? Number((contributedTable as { fields?: { size?: unknown } }).fields?.size ?? 0)
    : 0;
  const contributorsCount = Number(fields.contributors_count ?? tableSize ?? 0);

  const balance = fields.balance as { fields?: { value?: unknown } } | undefined;
  const totalContributed = balance && balance.fields?.value !== undefined
    ? String(balance.fields.value)
    : '0';

  const contributedMembers: string[] = [];
  // The full contributor list is only retrievable via dynamic field pagination
  // which is expensive; the webhook / UI can reconstruct it from
  // ContributionRecorded events if needed. Leave empty here.

  // The recipient sits out the round they collect, so the on-chain
  // finalize gate uses `required_contributors = members - 1` (the v3 fix).
  // Read it straight from the frozen snapshot rather than re-deriving from
  // members.length, which over-counted by one and showed "0/3" instead of
  // "0/2" in the UI.
  const requiredContributors = Number(
    snapshot.required_contributors ?? Math.max(0, members.length - 1),
  );

  return {
    escrowId,
    cycleNo: Number(snapshot.cycle_no ?? 0),
    recipient: String(snapshot.recipient ?? ''),
    contributionAmount: String(snapshot.contribution_amount ?? '0'),
    requiredContributors,
    contributorsSoFar: contributorsCount,
    totalContributed,
    assetType: bytesToCanonicalType(assetBytes),
    finalized: Boolean(fields.finalized),
    claimed: Boolean(fields.claimed),
    contributedMembers,
    members,
    requiresAttestation: Boolean(fields.requires_attestation),
  };
}

/**
 * Queries ContributionRecorded events for a specific escrow so the UI
 * can render a per-member "paid / not paid" progress grid.
 */
export async function listContributors(
  escrowId: string,
  network: NetworkType,
  client?: SuiClient,
): Promise<string[]> {
  const packageId = eventTypePackageIdFor(network);
  const rpcClient =
    client ??
    getPooledSuiClient({
      network,
      rpcUrl: getNetworkConfig(network).rpcUrl,
    });
  try {
    const events = await rpcClient.queryEvents({
      query: {
        MoveEventType: `${packageId}::njangi_cycle_escrow::ContributionRecorded`,
      },
      limit: 200,
      order: 'descending',
    });
    const contributors: string[] = [];
    for (const event of events.data) {
      const parsed = (event.parsedJson ?? {}) as Record<string, unknown>;
      if (parsed.escrow_id !== escrowId) continue;
      const who = parsed.contributor;
      if (typeof who === 'string' && !contributors.includes(who)) {
        contributors.push(who);
      }
    }
    return contributors;
  } catch (err) {
    console.warn('[cycle-escrow-discovery] Failed to list contributors', err);
    return [];
  }
}
