import type { NetworkType } from '@/config/public-env';

export type CircleActiveSource = 'field' | 'activation-event' | 'default';

export interface PublishedPackageMetadata {
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
  },
  testnet: {
    publishedAt: '0x0f60c64eda31d4e3456ae84b3edecdb8c9dbe525a5e3c0ab2cc9e4e7eb975967',
    originalId: '0xb5a3be4da4107df9a64e7157898373e92e0a832e1cb2fe544ce87fd96ef23892',
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
