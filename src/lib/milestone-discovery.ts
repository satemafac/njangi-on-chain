// milestone-discovery.ts — Auto-discover the `CircleMilestones<T>` shared
// object (the smart-goal tracker) for a circle so the UI never asks anyone
// to paste object ids. Mirrors cycle-escrow-discovery.ts, which solves the
// identical problem for `CycleEscrow<T>`: discovery rides the creation
// event (`MilestonesCreated`, emitted by
// `njangi_milestones::create_circle_milestones`) and live state comes from
// a plain object read parsed into typed TS shapes.

import type { SuiClient } from '@mysten/sui/client';
import type { NetworkType } from '../services/whatsapp-registry-service';
import { getNetworkConfig, getPackageIdForNetwork } from '../services/network-config';
import { getPublishedPackageMetadata } from './circle-chain';
import { getPooledSuiClient } from '../services/sui-rpc-failover';
import { getCircleConfigFields } from './circle-config';
import { readCycleEscrowState } from './cycle-escrow-discovery';

// Mirrors njangi_core::MILESTONE_TYPE_* (move/sources/njangi_core.move).
export const MILESTONE_KIND_MONETARY = 0;
export const MILESTONE_KIND_TIME = 1;

export type MilestoneKind = 'monetary' | 'time';

/** One parsed `Milestone` entry from the on-chain tracker. */
export interface MilestoneState {
  index: number;
  kind: MilestoneKind;
  /** Cumulative target in base units of `T`; '0' for time milestones. */
  targetAmount: string;
  /** Sui clock target in ms; 0 for monetary milestones. */
  targetTimestampMs: number;
  description: string;
  requiresVerification: boolean;
  /** Admin address once verified; null until then (or when not gated). */
  verifiedBy: string | null;
  /** Number of opaque proof blobs members have anchored. */
  proofCount: number;
  completed: boolean;
  completedAtMs: number;
  /** Cumulative contributed (monetary) or timestamp (time) at completion. */
  achievedValue: string;
}

/** Identity of a circle's tracker, derived from `MilestonesCreated`. */
export interface CircleMilestonesSummary {
  milestonesId: string;
  circleId: string;
  /** Canonical Move type of `T`, e.g. `0x2::sui::SUI`. */
  assetType: string;
  /** Chain timestamp of the creation event (0 when unavailable). */
  createdAtMs: number;
}

/** Full parsed state of a `CircleMilestones<T>` shared object. */
export interface CircleMilestonesState {
  milestonesId: string;
  circleId: string;
  /** Canonical Move type of `T`, extracted from the object type tag. */
  assetType: string;
  milestones: MilestoneState[];
  /** Index of the next milestone eligible for completion. */
  nextToComplete: number;
  /** Sum of every credited escrow pot, base units of `T`. */
  cumulativeContributed: string;
  /** How many settled escrows have been credited so far. */
  creditedEscrowCount: number;
  /** UID of the on-chain `credited_escrows` Table — lets the UI check
   *  whether a specific settled escrow has been counted yet (the
   *  opportunistic "update progress" affordance). Empty when the RPC
   *  output omitted it. */
  creditedTableId: string;
  /** True once any progress is recorded / milestone completes — the
   *  definition is frozen and add_* calls will abort. */
  locked: boolean;
  /** True when every milestone has completed (GoalAchieved has fired). */
  goalAchieved: boolean;
}

/** UI-facing progress for a single milestone. */
export interface MilestoneProgress {
  index: number;
  /** 0–100, clamped. */
  percent: number;
  /** True when the on-chain completion condition is already satisfied
   *  (the milestone may still need admin verification before
   *  `complete_milestone` succeeds). */
  conditionMet: boolean;
}

function packageIdFor(network: NetworkType): string {
  // Prefer the canonical resolver (handles legacy NEXT_PUBLIC_PACKAGE_ID
  // fallback) — direct process.env reads can be stale in browser bundles.
  const fromConfig = getPackageIdForNetwork(network);
  if (fromConfig && fromConfig.trim() !== '') return fromConfig;
  const envKey =
    network === 'mainnet'
      ? 'NEXT_PUBLIC_MAINNET_PACKAGE_ID'
      : 'NEXT_PUBLIC_TESTNET_PACKAGE_ID';
  const id = process.env[envKey];
  if (!id) {
    throw new Error(
      `Missing ${envKey}; cannot auto-discover CircleMilestones. Restart the dev server.`,
    );
  }
  return id;
}

// Move event types are anchored to the package's ORIGINAL id across
// upgrades (see the cycle-escrow-discovery.ts postmortem: filtering on the
// published-at id silently matches nothing after an upgrade). Prefer the
// original id for event queries.
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Unwraps a Move `Option<...>` from RPC JSON. Sui surfaces options in a
 * few shapes depending on type/version: the value directly, `null`, an
 * array (`vec`), or `{ fields: { vec: [...] } }`.
 */
function moveOptionToValue(value: unknown): unknown | null {
  if (value === null || typeof value === 'undefined') return null;
  if (Array.isArray(value)) return value.length > 0 ? value[0] : null;
  const record = asRecord(value);
  if (!record) return value;
  if ('some' in record) return record.some ?? null;
  const inner = asRecord(record.fields) ?? record;
  const vec = inner.vec;
  if (Array.isArray(vec)) return vec.length > 0 ? vec[0] : null;
  return value;
}

function parseU64String(value: unknown): string {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.trunc(value)).toString();
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) return value;
  return '0';
}

function parseU64Number(value: unknown): number {
  return Number(parseU64String(value));
}

/** Extracts `T` from a `...::njangi_milestones::CircleMilestones<T>` tag. */
function assetTypeFromTrackerType(typeTag: string | undefined | null): string {
  if (!typeTag) return '';
  const match = typeTag.match(/<(.+)>$/);
  return match ? match[1] : '';
}

function parseMilestone(raw: unknown, index: number): MilestoneState | null {
  const record = asRecord(raw);
  if (!record) return null;
  // Vector entries surface either wrapped ({ type, fields }) or flat.
  const fields = asRecord(record.fields) ?? record;
  if (!('kind' in fields)) return null;

  const verifiedRaw = moveOptionToValue(fields.verified_by);
  const proofs = fields.proofs;

  return {
    index,
    kind:
      Number(fields.kind ?? MILESTONE_KIND_MONETARY) === MILESTONE_KIND_TIME
        ? 'time'
        : 'monetary',
    targetAmount: parseU64String(fields.target_amount),
    targetTimestampMs: parseU64Number(fields.target_timestamp_ms),
    description: typeof fields.description === 'string' ? fields.description : '',
    requiresVerification: Boolean(fields.requires_verification),
    verifiedBy: typeof verifiedRaw === 'string' ? normalizeAddress(verifiedRaw) : null,
    proofCount: Array.isArray(proofs) ? proofs.length : 0,
    completed: Boolean(fields.completed),
    completedAtMs: parseU64Number(fields.completed_at_ms),
    achievedValue: parseU64String(fields.achieved_value),
  };
}

export interface MoveObjectContentLike {
  dataType?: string;
  type?: string;
  fields?: Record<string, unknown>;
}

/**
 * Pure parser: Move object JSON (`showContent` output) → typed state.
 * Exported separately so fixtures can exercise it without an RPC mock.
 */
export function parseCircleMilestonesContent(
  milestonesId: string,
  content: MoveObjectContentLike | null | undefined,
): CircleMilestonesState | null {
  if (!content || (content.dataType && content.dataType !== 'moveObject')) {
    return null;
  }
  const fields = content.fields;
  if (!fields) return null;

  const rawMilestones = Array.isArray(fields.milestones) ? fields.milestones : [];
  const milestones = rawMilestones
    .map((entry, index) => parseMilestone(entry, index))
    .filter((entry): entry is MilestoneState => entry !== null);

  // `Table<ID, bool>` surfaces its size via `fields.size` and its UID via
  // `fields.id.id` in RPC output.
  const creditedTable = asRecord(fields.credited_escrows);
  const creditedInner = asRecord(creditedTable?.fields) ?? creditedTable;
  const creditedEscrowCount = parseU64Number(creditedInner?.size);
  const creditedIdRecord = asRecord(creditedInner?.id);
  const creditedTableId =
    typeof creditedIdRecord?.id === 'string' ? creditedIdRecord.id : '';

  const nextToComplete = parseU64Number(fields.next_to_complete);

  return {
    milestonesId,
    circleId: typeof fields.circle_id === 'string' ? fields.circle_id : '',
    assetType: assetTypeFromTrackerType(content.type),
    milestones,
    nextToComplete,
    cumulativeContributed: parseU64String(fields.cumulative_contributed),
    creditedEscrowCount,
    creditedTableId,
    locked: Boolean(fields.locked),
    goalAchieved: milestones.length > 0 && nextToComplete >= milestones.length,
  };
}

/**
 * Checks whether a settled escrow has already been credited into the
 * goal tracker, via the `credited_escrows` Table's dynamic field for the
 * escrow id. Returns:
 *   * `true`  — already counted (record_cycle_progress would abort 409),
 *   * `false` — not yet counted (the "update progress" button applies),
 *   * `null`  — unknown (missing table id or RPC error); callers should
 *     hide the affordance rather than invite an abort.
 */
export async function isEscrowCredited(
  creditedTableId: string,
  escrowId: string,
  network: NetworkType,
  client?: SuiClient,
): Promise<boolean | null> {
  if (!creditedTableId || !escrowId) return null;
  const rpcClient =
    client ??
    getPooledSuiClient({
      network,
      rpcUrl: getNetworkConfig(network).rpcUrl,
    });
  try {
    const field = await rpcClient.getDynamicFieldObject({
      parentId: creditedTableId,
      name: { type: '0x2::object::ID', value: escrowId },
    });
    if (field.error) {
      // `dynamicFieldNotFound` means the escrow was never credited.
      const code = (field.error as { code?: string }).code ?? '';
      return code === 'dynamicFieldNotFound' ? false : null;
    }
    return field.data ? true : false;
  } catch (err) {
    console.warn('[milestone-discovery] credited-escrow lookup failed', err);
    return null;
  }
}

/**
 * Safety valve for the exhaustive event scan: 200 pages x 50 events =
 * 10k `MilestonesCreated` events before we give up. Trackers are created
 * at most once per circle, so this bounds pathological RPC behaviour
 * rather than expected data volume. Exported so tests can pin it.
 */
export const MAX_MILESTONE_EVENT_PAGES = 200;

/**
 * Finds the canonical smart-goal tracker for a circle by scanning
 * `MilestonesCreated` events OLDEST-FIRST with full cursor pagination.
 *
 * Unlike cycle-escrow discovery (where the wanted event is recent by
 * construction), the tracker is created ONCE and must stay discoverable
 * for the circle's whole life — a fixed recency window would eventually
 * scroll old circles' creation events out of view, report "no smart
 * goals" for circles that have one, and invite a DUPLICATE tracker
 * (`create_circle_milestones` has no on-chain uniqueness guard; the Move
 * doc comment delegates "first MilestonesCreated event is canonical" to
 * the client). Scanning ascending makes the FIRST match the canonical
 * (oldest) event, so we can return early; concluding that no tracker
 * exists requires draining every page.
 */
export async function findCircleMilestones(
  client: SuiClient,
  network: NetworkType,
  circleId: string,
  opts?: { pageSize?: number },
): Promise<CircleMilestonesSummary | null> {
  const packageId = eventTypePackageIdFor(network);
  const pageSize = opts?.pageSize ?? 50;
  try {
    let cursor: Awaited<ReturnType<SuiClient['queryEvents']>>['nextCursor'] = null;
    let pages = 0;

    do {
      const page = await client.queryEvents({
        query: { MoveEventType: `${packageId}::njangi_milestones::MilestonesCreated` },
        limit: pageSize,
        order: 'ascending',
        cursor: cursor ?? undefined,
      });

      for (const event of page.data) {
        const parsed = (event.parsedJson ?? {}) as Record<string, unknown>;
        if (!matchesCircle(parsed.circle_id, circleId)) continue;
        const milestonesId =
          typeof parsed.milestones_id === 'string' ? parsed.milestones_id : '';
        if (!milestonesId) continue;
        // Ascending order: the first match IS the oldest (canonical)
        // creation event — later duplicates lose by construction.
        return {
          milestonesId,
          circleId: String(parsed.circle_id ?? circleId),
          assetType: bytesToCanonicalType(decodeBytes(parsed.asset_type)),
          createdAtMs: Number(event.timestampMs ?? 0),
        };
      }

      cursor = page.hasNextPage && page.nextCursor ? page.nextCursor : null;
      pages += 1;

      if (pages >= MAX_MILESTONE_EVENT_PAGES && cursor) {
        console.warn(
          `[milestone-discovery] Stopped after ${MAX_MILESTONE_EVENT_PAGES} pages scanning MilestonesCreated for ${circleId}; treating as not found.`,
        );
        break;
      }
    } while (cursor);

    return null;
  } catch (err) {
    console.warn('[milestone-discovery] Failed to query MilestonesCreated', err);
    return null;
  }
}

/**
 * Fetches and parses the live `CircleMilestones<T>` shared object for UI
 * progress displays ("2 of 3 milestones reached", celebration states).
 */
export async function readCircleMilestonesState(
  milestonesId: string,
  network: NetworkType,
  client?: SuiClient,
): Promise<CircleMilestonesState | null> {
  const rpcClient =
    client ??
    getPooledSuiClient({
      network,
      rpcUrl: getNetworkConfig(network).rpcUrl,
    });
  const obj = await rpcClient.getObject({
    id: milestonesId,
    options: { showContent: true },
  });
  if (!obj.data?.content || obj.data.content.dataType !== 'moveObject') {
    return null;
  }
  return parseCircleMilestonesContent(
    milestonesId,
    obj.data.content as MoveObjectContentLike,
  );
}

/**
 * Per-milestone progress for progress bars and celebration cues.
 *
 *   * Monetary: cumulative credited contributions over the target.
 *   * Time: elapsed share of the window between `originMs` (typically the
 *     tracker's creation timestamp from `findCircleMilestones`) and the
 *     target. Without an origin we report 0 until the clock target is hit
 *     — honest, if less pretty.
 *
 * Completed milestones are always 100 / condition met.
 */
export function computeMilestoneProgress(
  milestone: MilestoneState,
  opts: { cumulativeContributed: string; nowMs: number; originMs?: number },
): MilestoneProgress {
  if (milestone.completed) {
    return { index: milestone.index, percent: 100, conditionMet: true };
  }

  if (milestone.kind === 'monetary') {
    let target = 0n;
    let cumulative = 0n;
    try {
      target = BigInt(milestone.targetAmount);
      cumulative = BigInt(opts.cumulativeContributed);
    } catch {
      return { index: milestone.index, percent: 0, conditionMet: false };
    }
    if (target <= 0n) {
      return { index: milestone.index, percent: 0, conditionMet: false };
    }
    if (cumulative >= target) {
      return { index: milestone.index, percent: 100, conditionMet: true };
    }
    const percent = Number((cumulative * 100n) / target);
    return {
      index: milestone.index,
      percent: Math.max(0, Math.min(99, percent)),
      conditionMet: false,
    };
  }

  // Time milestone.
  const target = milestone.targetTimestampMs;
  if (target > 0 && opts.nowMs >= target) {
    return { index: milestone.index, percent: 100, conditionMet: true };
  }
  const origin = opts.originMs;
  if (typeof origin === 'number' && origin > 0 && target > origin) {
    const elapsed = Math.max(0, opts.nowMs - origin);
    const span = target - origin;
    const percent = Math.floor((elapsed / span) * 100);
    return {
      index: milestone.index,
      percent: Math.max(0, Math.min(99, percent)),
      conditionMet: false,
    };
  }
  return { index: milestone.index, percent: 0, conditionMet: false };
}

/** Progress for every milestone in the tracker, in index order. */
export function computeGoalProgress(
  state: CircleMilestonesState,
  opts?: { nowMs?: number; originMs?: number },
): MilestoneProgress[] {
  const nowMs = opts?.nowMs ?? Date.now();
  return state.milestones.map((milestone) =>
    computeMilestoneProgress(milestone, {
      cumulativeContributed: state.cumulativeContributed,
      nowMs,
      originMs: opts?.originMs,
    }),
  );
}

/** The next milestone eligible for completion, or null once achieved. */
export function nextIncompleteMilestone(
  state: CircleMilestonesState,
): MilestoneState | null {
  return state.milestones[state.nextToComplete] ?? null;
}

// ---------------------------------------------------------------------------
// Uncounted-escrow discovery (the "update progress" affordance)
// ---------------------------------------------------------------------------

/** One `CycleEscrowOpened` event for a circle, in open order. */
export interface CircleEscrowEventRef {
  escrowId: string;
  cycleNo: number;
  openedAtMs: number;
}

/** A settled (claimed) escrow the goal tracker hasn't credited yet. */
export interface UncountedEscrow {
  escrowId: string;
  cycleNo: number;
}

/**
 * Page safety cap for the escrow event scan (mirrors
 * MAX_MILESTONE_EVENT_PAGES): 200 pages x 50 events bounds pathological
 * RPC behaviour, not expected volume.
 */
export const MAX_ESCROW_EVENT_PAGES = 200;

/**
 * Enumerates EVERY `CycleEscrowOpened` event for a circle, oldest first,
 * with full cursor pagination.
 *
 * findCurrentCycleEscrow (cycle-escrow-discovery.ts) deliberately looks at
 * a single recent window — fine for "what round is live right now", wrong
 * for goal accounting: cumulative monetary milestones need every claimed
 * escrow credited, and a claimed-but-uncredited escrow stays creditable on
 * chain forever even after the next cycle opens. A recency window would
 * silently drop those stragglers; this scan keeps them discoverable for
 * the circle's whole life.
 */
export async function listCircleEscrowEvents(
  client: SuiClient,
  network: NetworkType,
  circleId: string,
  opts?: { pageSize?: number },
): Promise<CircleEscrowEventRef[]> {
  const packageId = eventTypePackageIdFor(network);
  const pageSize = opts?.pageSize ?? 50;
  const found: CircleEscrowEventRef[] = [];
  const seen = new Set<string>();
  try {
    let cursor: Awaited<ReturnType<SuiClient['queryEvents']>>['nextCursor'] = null;
    let pages = 0;

    do {
      const page = await client.queryEvents({
        query: {
          MoveEventType: `${packageId}::njangi_cycle_escrow::CycleEscrowOpened`,
        },
        limit: pageSize,
        order: 'ascending',
        cursor: cursor ?? undefined,
      });

      for (const event of page.data) {
        const parsed = (event.parsedJson ?? {}) as Record<string, unknown>;
        if (!matchesCircle(parsed.circle_id, circleId)) continue;
        const escrowId =
          typeof parsed.escrow_id === 'string' ? parsed.escrow_id : '';
        if (!escrowId || seen.has(escrowId)) continue;
        seen.add(escrowId);
        found.push({
          escrowId,
          cycleNo: parseU64Number(parsed.cycle_no),
          openedAtMs: parseU64Number(parsed.opened_at_ms),
        });
      }

      cursor = page.hasNextPage && page.nextCursor ? page.nextCursor : null;
      pages += 1;

      if (pages >= MAX_ESCROW_EVENT_PAGES && cursor) {
        console.warn(
          `[milestone-discovery] Stopped after ${MAX_ESCROW_EVENT_PAGES} pages scanning CycleEscrowOpened for ${circleId}; results may be partial.`,
        );
        break;
      }
    } while (cursor);
  } catch (err) {
    console.warn('[milestone-discovery] Failed to query CycleEscrowOpened', err);
  }
  return found;
}

/**
 * Every settled round the tracker hasn't counted yet, oldest first.
 *
 * For each of the circle's escrows: skip ones already in the
 * `credited_escrows` table (record_cycle_progress would abort 409), skip
 * unknown credited-status (null — don't invite an abort on a flaky RPC),
 * then keep only claimed escrows (unclaimed ones aren't settled yet —
 * record_cycle_progress would abort E_ESCROW_NOT_SETTLED). Oldest-first
 * ordering lets the UI credit rounds in rotation order.
 */
export async function findUncountedEscrows(
  client: SuiClient,
  network: NetworkType,
  circleId: string,
  creditedTableId: string,
): Promise<UncountedEscrow[]> {
  if (!creditedTableId) return [];
  const events = await listCircleEscrowEvents(client, network, circleId);
  const uncounted: UncountedEscrow[] = [];
  for (const event of events) {
    const credited = await isEscrowCredited(
      creditedTableId,
      event.escrowId,
      network,
      client,
    );
    if (credited !== false) continue;
    try {
      const live = await readCycleEscrowState(event.escrowId, network, client);
      if (!live?.claimed) continue;
      uncounted.push({
        escrowId: event.escrowId,
        cycleNo: live.cycleNo || event.cycleNo,
      });
    } catch (err) {
      console.warn(
        '[milestone-discovery] escrow state read failed for',
        event.escrowId,
        err,
      );
    }
  }
  return uncounted;
}

// ---------------------------------------------------------------------------
// Circle goal context (smart-goal config + rotation state for the UI)
// ---------------------------------------------------------------------------

// Mirrors njangi_circle_config's goal_type values (and the frontend
// GOAL_TYPE_AMOUNT/GOAL_TYPE_TIME constants in circle-service.ts).
export const GOAL_TYPE_AMOUNT = 0;
export const GOAL_TYPE_TIME = 1;

/**
 * Everything the goals UI needs to know about a circle besides the
 * tracker itself: whether it was created as a smart-goal circle, who the
 * admin is, and whether the rotation has started (which freezes the
 * milestone definition on chain — see `assert_rotation_not_started`).
 */
export interface CircleGoalContext {
  circleId: string;
  name: string;
  admin: string;
  currentCycle: number;
  currentPosition: number;
  pausedAfterCycle: boolean;
  /** True once the first payout has settled — milestone adds will abort
   *  with E_CYCLE_ALREADY_STARTED from here on. */
  rotationStarted: boolean;
  isActive: boolean;
  membersTableId: string | null;
  autoSwapEnabled: boolean;
  /** True when the circle was created with a smart goal configured. */
  hasGoal: boolean;
  goalKind: 'amount' | 'date' | null;
  /** Overall target from circle creation, in MIST (Option<u64>). */
  targetAmountMist: string | null;
  /** Overall target in local-currency cents (Option<u64>). */
  targetAmountLocalCents: string | null;
  /** Overall target date from circle creation (raw u64 from config). */
  targetDateRaw: string | null;
  verificationRequired: boolean;
}

/**
 * Reads the circle object + its CircleConfig dynamic field and distills
 * the smart-goal context. Returns null when the circle object cannot be
 * read (deleted / wrong id / RPC failure).
 */
export async function readCircleGoalContext(
  circleId: string,
  network: NetworkType,
  client?: SuiClient,
): Promise<CircleGoalContext | null> {
  const rpcClient =
    client ??
    getPooledSuiClient({
      network,
      rpcUrl: getNetworkConfig(network).rpcUrl,
    });
  try {
    const obj = await rpcClient.getObject({
      id: circleId,
      options: { showContent: true },
    });
    const content = obj.data?.content;
    if (!content || content.dataType !== 'moveObject') return null;
    const fields = asRecord((content as { fields?: unknown }).fields);
    if (!fields) return null;

    const membersRecord = asRecord(fields.members);
    const membersInner = asRecord(membersRecord?.fields) ?? membersRecord;
    const membersIdRecord = asRecord(membersInner?.id);
    const membersTableId =
      typeof membersIdRecord?.id === 'string' ? membersIdRecord.id : null;

    const currentCycle = parseU64Number(fields.current_cycle);
    const currentPosition = parseU64Number(fields.current_position);
    const pausedAfterCycle = Boolean(fields.paused_after_cycle);
    const rotationStarted = !(
      currentCycle <= 1 && currentPosition === 0 && !pausedAfterCycle
    );

    let config: Record<string, unknown> | null = null;
    try {
      config = await getCircleConfigFields(rpcClient, circleId);
    } catch (err) {
      console.warn('[milestone-discovery] circle config read failed', err);
    }

    const goalTypeRaw = moveOptionToValue(config?.goal_type);
    const hasGoal = goalTypeRaw !== null && typeof goalTypeRaw !== 'undefined';
    const goalKind = hasGoal
      ? Number(goalTypeRaw) === GOAL_TYPE_TIME
        ? 'date'
        : 'amount'
      : null;
    const targetAmountRaw = moveOptionToValue(config?.target_amount);
    const targetAmountLocalRaw = moveOptionToValue(config?.target_amount_local);
    const targetDateRaw = moveOptionToValue(config?.target_date);

    return {
      circleId,
      name: typeof fields.name === 'string' ? fields.name : '',
      admin:
        typeof fields.admin === 'string' ? normalizeAddress(fields.admin) : '',
      currentCycle,
      currentPosition,
      pausedAfterCycle,
      rotationStarted,
      isActive: Boolean(fields.is_active),
      membersTableId,
      autoSwapEnabled: Boolean(config?.auto_swap_enabled),
      hasGoal,
      goalKind,
      targetAmountMist:
        targetAmountRaw !== null && typeof targetAmountRaw !== 'undefined'
          ? parseU64String(targetAmountRaw)
          : null,
      targetAmountLocalCents:
        targetAmountLocalRaw !== null && typeof targetAmountLocalRaw !== 'undefined'
          ? parseU64String(targetAmountLocalRaw)
          : null,
      targetDateRaw:
        targetDateRaw !== null && typeof targetDateRaw !== 'undefined'
          ? parseU64String(targetDateRaw)
          : null,
      verificationRequired: Boolean(config?.verification_required),
    };
  } catch (err) {
    console.warn('[milestone-discovery] circle goal context read failed', err);
    return null;
  }
}

/**
 * Best-effort membership probe via the circle's members Table. Returns
 * null on RPC trouble so callers can fail open (the contract enforces
 * membership on chain anyway).
 */
export async function isCircleMember(
  membersTableId: string | null,
  userAddress: string | null | undefined,
  network: NetworkType,
  client?: SuiClient,
): Promise<boolean | null> {
  if (!membersTableId || !userAddress) return null;
  const rpcClient =
    client ??
    getPooledSuiClient({
      network,
      rpcUrl: getNetworkConfig(network).rpcUrl,
    });
  try {
    const field = await rpcClient.getDynamicFieldObject({
      parentId: membersTableId,
      name: { type: 'address', value: userAddress },
    });
    if (field.error) {
      const code = (field.error as { code?: string }).code ?? '';
      return code === 'dynamicFieldNotFound' ? false : null;
    }
    return field.data ? true : false;
  } catch {
    return null;
  }
}
