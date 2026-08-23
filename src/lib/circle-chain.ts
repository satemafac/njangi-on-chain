import type { NetworkType } from '@/config/public-env';

export type CircleActiveSource = 'field' | 'activation-event' | 'default';

export interface PublishedPackageMetadata {
  /**
   * Package version that DEFINED the v1.1 timed-escrow types
   * (ContributionTimeKey). Types introduced in an upgrade anchor to the
   * id of the version that introduced them — neither the original id nor
   * whatever published-at later becomes. Null on lineages that have not
   * published v1.1 yet (mainnet today).
   */
  timedEntriesPackageId?: string | null;
  publishedAt: string | null;
  originalId: string | null;
}

export interface CircleLifecycleFields {
  is_active?: unknown;
  paused_after_cycle?: unknown;
  current_cycle?: unknown;
}

export interface CircleLifecycleState {
  isActive: boolean;
  isPausedAfterCycle: boolean;
  currentCycle: number;
  activeSource: CircleActiveSource;
}

function parseBooleanLike(value: unknown): boolean | null {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();

    if (normalized === 'true') {
      return true;
    }

    if (normalized === 'false') {
      return false;
    }
  }

  return null;
}

function parseIntegerLike(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);

    if (Number.isFinite(parsed)) {
      return Math.trunc(parsed);
    }
  }

  return null;
}

// Browser-safe mirror of move/Published.toml for upgrade-aware package routing.
const PACKAGE_LINEAGE_BY_NETWORK: Record<NetworkType, PublishedPackageMetadata> = {
  mainnet: {
    publishedAt: '0x7bf5274804a6008ebfbd9bfe766defb7fd5aa5fe6777419c2b6531ec99120b55',
    originalId: '0x7bf5274804a6008ebfbd9bfe766defb7fd5aa5fe6777419c2b6531ec99120b55',
    timedEntriesPackageId: null,
  },
  // Testnet lineage. Original published 2026-06-12; v2 (2026-06-15) added
  // njangi_goal_pool; v3 (2026-06-15) added combined "amount by date" goals;
  // v4 (2026-08-02) locked the rotation order mid-cycle and made
  // `njangi_cycle_escrow::finalize` recipient-only; v5 (2026-08-20) let a
  // circle that was already running elsewhere join mid-rotation; v6
  // (2026-08-22) added the Circle Record v1.1 entries — open_cycle*_indexed
  // (escrow-history dynamic field on the Circle) and contribute_timed*
  // (per-member contribution timestamps).
  //
  // published-at = latest package (move-call target); original-id stays v1
  // (type identity + event filters). Every version since has been an UPGRADE,
  // not a fresh publish, so original-id is unchanged and every circle created
  // under an earlier version remains reachable — which is why v4 avoided
  // touching any public struct's abilities, and why v5 put its migration
  // ledger in a dynamic field rather than adding a field to CircleConfig.
  // Either would have been upgrade-incompatible and forced a new lineage,
  // stranding every existing circle.
  testnet: {
    publishedAt: '0x859e3add80ce891423d49702b2b3350addf1726ca634000c7394748c0c416c8e',
    originalId: '0x89cddf4dfe654e7c7b16333096d9e750cf04bb96f7de934403a512d460594f02',
    // v6 introduced the timed-escrow types; they stay anchored here even
    // after future upgrades move published-at.
    timedEntriesPackageId:
      '0x859e3add80ce891423d49702b2b3350addf1726ca634000c7394748c0c416c8e',
  },
};

export function normalizePackageId(value: string | null | undefined): string | null {
  if (!value || typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  return trimmed.startsWith('0x')
    ? `0x${trimmed.slice(2).toLowerCase()}`
    : `0x${trimmed.toLowerCase()}`;
}

export function getPublishedPackageMetadata(
  network: NetworkType,
): PublishedPackageMetadata {
  const metadata = PACKAGE_LINEAGE_BY_NETWORK[network];

  return {
    publishedAt: normalizePackageId(metadata.publishedAt),
    originalId: normalizePackageId(metadata.originalId),
  };
}

export function resolveUpgradeAwarePackageId(args: {
  network: NetworkType;
  objectPackageId: string;
  currentPackageId: string;
}): string {
  const { network, objectPackageId, currentPackageId } = args;
  const normalizedCurrentPackageId = normalizePackageId(currentPackageId);
  const normalizedObjectPackageId = normalizePackageId(objectPackageId);
  const { publishedAt, originalId } = getPublishedPackageMetadata(network);

  if (!normalizedObjectPackageId) {
    return normalizedCurrentPackageId ?? objectPackageId;
  }

  if (!normalizedCurrentPackageId) {
    return normalizedObjectPackageId;
  }

  if (normalizedObjectPackageId === normalizedCurrentPackageId) {
    return normalizedCurrentPackageId;
  }

  if (
    publishedAt === normalizedCurrentPackageId &&
    originalId === normalizedObjectPackageId
  ) {
    return normalizedCurrentPackageId;
  }

  return normalizedObjectPackageId;
}

export function getPackageLookupIds(args: {
  network: NetworkType;
  packageId?: string | null;
  currentPackageId: string;
}): string[] {
  const { network, packageId, currentPackageId } = args;
  const normalizedPackageId = normalizePackageId(packageId);
  const normalizedCurrentPackageId = normalizePackageId(currentPackageId);
  const { publishedAt, originalId } = getPublishedPackageMetadata(network);
  const lookupIds = new Set<string>();
  const add = (value: string | null | undefined) => {
    const normalized = normalizePackageId(value);
    if (normalized) {
      lookupIds.add(normalized);
    }
  };

  const isCurrentLineagePackage =
    normalizedPackageId == null ||
    normalizedPackageId === normalizedCurrentPackageId ||
    normalizedPackageId === publishedAt ||
    normalizedPackageId === originalId;

  if (isCurrentLineagePackage) {
    add(normalizedCurrentPackageId);
    add(publishedAt);
    add(originalId);
  } else {
    add(normalizedPackageId);
  }

  return Array.from(lookupIds);
}

export function extractPackageIdFromMoveType(moveType?: string | null): string | null {
  if (!moveType) {
    return null;
  }

  const match = moveType.match(/^(0x[a-fA-F0-9]+)::/);
  return match?.[1] ?? null;
}

export function resolveCircleLifecycleState(
  fields: CircleLifecycleFields,
  options: {
    activationEventFound?: boolean;
    defaultCurrentCycle?: number;
  } = {},
): CircleLifecycleState {
  const { activationEventFound = false, defaultCurrentCycle = 1 } = options;
  const explicitIsActive = parseBooleanLike(fields.is_active);
  const explicitPausedAfterCycle = parseBooleanLike(fields.paused_after_cycle);
  const currentCycle = parseIntegerLike(fields.current_cycle);

  return {
    isActive: explicitIsActive ?? activationEventFound,
    isPausedAfterCycle: explicitPausedAfterCycle ?? false,
    currentCycle: currentCycle ?? defaultCurrentCycle,
    activeSource:
      explicitIsActive !== null
        ? 'field'
        : activationEventFound
          ? 'activation-event'
          : 'default',
  };
}
