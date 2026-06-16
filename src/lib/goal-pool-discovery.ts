// goal-pool-discovery.ts — Auto-discover GoalPool objects + read their live
// state without copy/pasting object ids. Event-anchored + object-read (no DB
// mirror), mirroring cycle-escrow-discovery.ts.

import type { SuiClient } from '@mysten/sui/client';
import type { NetworkType } from '../services/whatsapp-registry-service';
import { getNetworkConfig, getPackageIdForNetwork } from '../services/network-config';
import { getPublishedPackageMetadata } from './circle-chain';
import { getPooledSuiClient } from '../services/sui-rpc-failover';

export const GOAL_KIND_AMOUNT = 0;
export const GOAL_KIND_DATE = 1;
export const GOAL_KIND_AMOUNT_BY_DATE = 2;

export interface GoalPoolSummary {
  poolId: string;
  name: string;
  admin: string;
  beneficiary: string;
  goalKind: number;
  targetAmount: string;
  targetDateMs: string;
  deadlineMs: string;
  assetType: string;
  requiresAttestation: boolean;
  openedAtMs: number;
}

export interface GoalPoolState {
  poolId: string;
  name: string;
  admin: string;
  beneficiary: string;
  goalKind: number;
  targetAmount: string;
  targetDateMs: string;
  deadlineMs: string;
  /** Canonical Move type of T, e.g. `0x2::sui::SUI` — use as the tx typeArgument. */
  coinType: string;
  totalRaised: string;
  balance: string;
  contributorCount: number;
  released: boolean;
  cancelled: boolean;
  requiresAttestation: boolean;
  compliancyConfigId: string | null;
  contributionsTableId: string | null;
  createdAtMs: string;
}

function packageIdFor(network: NetworkType): string {
  const fromConfig = getPackageIdForNetwork(network);
  if (fromConfig && fromConfig.trim() !== '') return fromConfig;
  const envKey =
    network === 'mainnet'
      ? 'NEXT_PUBLIC_MAINNET_PACKAGE_ID'
      : 'NEXT_PUBLIC_TESTNET_PACKAGE_ID';
  const id = process.env[envKey];
  if (!id) throw new Error(`Missing ${envKey}; cannot discover GoalPool. Restart the dev server.`);
  return id;
}

// Event types anchor to the ORIGINAL package id and survive upgrades.
function eventTypePackageIdFor(network: NetworkType): string {
  const { originalId } = getPublishedPackageMetadata(network);
  if (originalId && originalId.trim() !== '') return originalId;
  return packageIdFor(network);
}

function normalizeAddress(value: string): string {
  const trimmed = value.trim().toLowerCase();
  return trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
}

function decodeBytesToType(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return new TextDecoder().decode(new Uint8Array(raw as number[]));
  return '';
}

/** Extract the coin type T from a `...::njangi_goal_pool::GoalPool<T>` type tag. */
function coinTypeFromPoolType(typeTag: string | undefined): string {
  if (!typeTag) return '';
  const m = typeTag.match(/njangi_goal_pool::GoalPool<(.+)>$/);
  return m ? m[1] : '';
}

/** Lists GoalPools opened by an admin (newest first). Used by the dashboard. */
export async function findGoalPoolsByAdmin(
  client: SuiClient,
  network: NetworkType,
  adminAddress: string,
  opts?: { limit?: number },
): Promise<GoalPoolSummary[]> {
  const packageId = eventTypePackageIdFor(network);
  const limit = opts?.limit ?? 100;
  const target = normalizeAddress(adminAddress);
  const out: GoalPoolSummary[] = [];
  try {
    const events = await client.queryEvents({
      query: { MoveEventType: `${packageId}::njangi_goal_pool::GoalPoolOpened` },
      limit,
      order: 'descending',
    });
    for (const event of events.data) {
      const p = (event.parsedJson ?? {}) as Record<string, unknown>;
      if (typeof p.admin !== 'string' || normalizeAddress(p.admin) !== target) continue;
      out.push({
        poolId: String(p.pool_id),
        name: typeof p.name === 'string' ? p.name : decodeBytesToType(p.name),
        admin: String(p.admin),
        beneficiary: String(p.beneficiary),
        goalKind: Number(p.goal_kind),
        targetAmount: String(p.target_amount ?? '0'),
        targetDateMs: String(p.target_date_ms ?? '0'),
        deadlineMs: String(p.deadline_ms ?? '0'),
        assetType: decodeBytesToType(p.asset_type),
        requiresAttestation: Boolean(p.requires_attestation),
        openedAtMs: Number(p.opened_at_ms ?? 0),
      });
    }
  } catch {
    return [];
  }
  return out;
}

/** Reads the live state of a single GoalPool object. */
export async function readGoalPoolState(
  poolId: string,
  network: NetworkType,
  client?: SuiClient,
): Promise<GoalPoolState | null> {
  const config = getNetworkConfig(network);
  const sui = client ?? getPooledSuiClient({ network, rpcUrl: config.rpcUrl });
  const obj = await sui.getObject({ id: poolId, options: { showContent: true, showType: true } });
  const content = obj.data?.content;
  if (!content || content.dataType !== 'moveObject') return null;
  const f = (content as { fields: Record<string, unknown> }).fields;

  const balanceField = f.balance as { fields?: { value?: unknown } } | string | undefined;
  const balance =
    typeof balanceField === 'object' && balanceField?.fields?.value != null
      ? String(balanceField.fields.value)
      : String(balanceField ?? '0');

  const contributions = f.contributions as { fields?: { id?: { id?: string } } } | undefined;
  const contributionsTableId = contributions?.fields?.id?.id ?? null;

  // Option<ID> serializes as null or the id string (sometimes wrapped).
  const rawConfig = f.compliance_config_id as unknown;
  const compliancyConfigId =
    typeof rawConfig === 'string' ? rawConfig : (rawConfig as { id?: string } | null)?.id ?? null;

  return {
    poolId,
    name: typeof f.name === 'string' ? f.name : decodeBytesToType(f.name),
    admin: String(f.admin),
    beneficiary: String(f.beneficiary),
    goalKind: Number(f.goal_kind),
    targetAmount: String(f.target_amount ?? '0'),
    targetDateMs: String(f.target_date_ms ?? '0'),
    deadlineMs: String(f.deadline_ms ?? '0'),
    coinType: coinTypeFromPoolType((obj.data as { type?: string })?.type),
    totalRaised: String(f.total_raised ?? '0'),
    balance,
    contributorCount: Number(f.contributor_count ?? 0),
    released: Boolean(f.released),
    cancelled: Boolean(f.cancelled),
    requiresAttestation: Boolean(f.requires_attestation),
    compliancyConfigId,
    contributionsTableId,
    createdAtMs: String(f.created_at ?? '0'),
  };
}

export interface GoalPoolContributor {
  contributor: string;
  amount: string;
}

/** Lists contributors via ContributionRecorded events (gross, newest first). */
export async function listGoalPoolContributors(
  client: SuiClient,
  network: NetworkType,
  poolId: string,
  opts?: { limit?: number },
): Promise<GoalPoolContributor[]> {
  const packageId = eventTypePackageIdFor(network);
  const limit = opts?.limit ?? 200;
  const target = normalizeAddress(poolId);
  const out: GoalPoolContributor[] = [];
  try {
    const events = await client.queryEvents({
      query: { MoveEventType: `${packageId}::njangi_goal_pool::ContributionRecorded` },
      limit,
      order: 'descending',
    });
    for (const event of events.data) {
      const p = (event.parsedJson ?? {}) as Record<string, unknown>;
      if (typeof p.pool_id !== 'string' || normalizeAddress(p.pool_id) !== target) continue;
      out.push({ contributor: String(p.contributor), amount: String(p.amount ?? '0') });
    }
  } catch {
    return [];
  }
  return out;
}

/**
 * Reads a single contributor's CURRENT recorded amount from the on-chain
 * contributions Table (net of any refund), for refund UIs. Returns '0' if absent.
 */
export async function readContributorAmount(
  contributionsTableId: string,
  who: string,
  network: NetworkType,
  client?: SuiClient,
): Promise<string> {
  const config = getNetworkConfig(network);
  const sui = client ?? getPooledSuiClient({ network, rpcUrl: config.rpcUrl });
  try {
    const entry = await sui.getDynamicFieldObject({
      parentId: contributionsTableId,
      name: { type: 'address', value: normalizeAddress(who) },
    });
    const content = entry.data?.content;
    if (!content || content.dataType !== 'moveObject') return '0';
    const f = (content as { fields: Record<string, unknown> }).fields;
    // Table<address,u64> entries store the value under `value`.
    return String(f.value ?? '0');
  } catch {
    return '0';
  }
}
