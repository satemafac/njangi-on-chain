import type { NetworkType } from '@/config/public-env';

// The package lineage moved to package-lineage.ts (a leaf module, so the
// list of this app's packages does not depend on the rest of this file).
export {
  extractPackageIdFromMoveType,
  getPackageLookupIds,
  getPublishedPackageMetadata,
  normalizePackageId,
  resolveUpgradeAwarePackageId,
  type PublishedPackageMetadata,
} from './package-lineage';

export type CircleActiveSource = 'field' | 'activation-event' | 'default';


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
