import { SuiClient } from '@mysten/sui/client';
import { getCircleConfigFieldsFromDynamicFields } from '@/lib/circle-config';
import { parseRecoveryStatus } from '@/lib/recovery-liveness';
import {
  batchQueryEvents,
  getSuiClientFromPool,
  getUserPackageIds,
} from '@/services/circle-service';
import {
  getCurrentNetwork,
  getCurrentRpcUrl,
  type NetworkType,
} from '@/services/network-config';
import type { BatchHeartbeatAdminLivenessRequest } from '@/services/zkLoginClient';
import type { AccountData } from '@/services/zkLoginService';

export const ADMIN_LOGIN_HEARTBEAT_STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;
export const ADMIN_LOGIN_HEARTBEAT_DISCOVERY_THROTTLE_MS = 6 * 60 * 60 * 1000;
export const ADMIN_LOGIN_HEARTBEAT_FAILURE_RETRY_MS = 15 * 60 * 1000;

const STORAGE_KEY_PREFIX = 'njangi:admin-heartbeat-refresh:v1';
const inflightRefreshes = new Set<string>();

type LoggerLike = Pick<Console, 'info' | 'warn' | 'error'>;
type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

interface CircleCreatedEventLike {
  circle_id?: string;
  admin?: string;
}

export interface StaleAdminHeartbeatCircle {
  circleId: string;
  lastAdminHeartbeatAt: number;
  autoReleaseTriggerTime: number | null;
  recoveryState: number;
}

export interface AdminHeartbeatRefreshRecord {
  lastAttemptAt: number;
  lastResult: 'success' | 'noop' | 'failure';
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastSource: 'login_success' | 'session_restore';
  lastCircleIds: string[];
}

export interface LoginDrivenHeartbeatRefreshResult {
  status: 'submitted' | 'noop' | 'throttled' | 'failed';
  reason:
    | 'submitted'
    | 'no_stale_circles'
    | 'recent_attempt'
    | 'recent_failure'
    | 'already_inflight'
    | 'submission_failed';
  circleIds: string[];
  digest?: string;
}

type HeartbeatSubmitter = {
  batchHeartbeatAdminLiveness: (
    account: AccountData,
    request: BatchHeartbeatAdminLivenessRequest,
  ) => Promise<{ digest: string; requireRelogin?: boolean }>;
};

const normalizeAddress = (value: string | null | undefined): string | null => {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
};

const getDefaultStorage = (): StorageLike | null => {
  if (typeof window === 'undefined') {
    return null;
  }

  return window.localStorage;
};

export function getAdminHeartbeatRefreshStorageKey(
  userAddress: string,
  network: NetworkType,
): string {
  const normalizedUser = normalizeAddress(userAddress) ?? userAddress;
  return `${STORAGE_KEY_PREFIX}:${network}:${normalizedUser}`;
}

export function parseAdminHeartbeatRefreshRecord(
  rawValue: string | null,
): AdminHeartbeatRefreshRecord | null {
  if (!rawValue) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawValue) as Partial<AdminHeartbeatRefreshRecord> | null;
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }

    const lastResult =
      parsed.lastResult === 'success' || parsed.lastResult === 'noop' || parsed.lastResult === 'failure'
        ? parsed.lastResult
        : null;
    const lastSource =
      parsed.lastSource === 'login_success' || parsed.lastSource === 'session_restore'
        ? parsed.lastSource
        : null;

    if (!lastResult || !lastSource || typeof parsed.lastAttemptAt !== 'number') {
      return null;
    }

    return {
      lastAttemptAt: parsed.lastAttemptAt,
      lastResult,
      lastSuccessAt: typeof parsed.lastSuccessAt === 'number' ? parsed.lastSuccessAt : null,
      lastFailureAt: typeof parsed.lastFailureAt === 'number' ? parsed.lastFailureAt : null,
      lastSource,
      lastCircleIds: Array.isArray(parsed.lastCircleIds)
        ? parsed.lastCircleIds.filter((entry): entry is string => typeof entry === 'string')
        : [],
    };
  } catch {
    return null;
  }
}

export function getAdminHeartbeatRefreshThrottleState(args: {
  record: AdminHeartbeatRefreshRecord | null;
  now?: number;
  discoveryThrottleMs?: number;
  failureRetryMs?: number;
}): {
  shouldThrottle: boolean;
  reason: 'recent_attempt' | 'recent_failure' | null;
} {
  const {
    record,
    now = Date.now(),
    discoveryThrottleMs = ADMIN_LOGIN_HEARTBEAT_DISCOVERY_THROTTLE_MS,
    failureRetryMs = ADMIN_LOGIN_HEARTBEAT_FAILURE_RETRY_MS,
  } = args;

  if (!record) {
    return { shouldThrottle: false, reason: null };
  }

  if (
    record.lastResult === 'failure'
    && typeof record.lastFailureAt === 'number'
    && now - record.lastFailureAt < failureRetryMs
  ) {
    return { shouldThrottle: true, reason: 'recent_failure' };
  }

  if (now - record.lastAttemptAt < discoveryThrottleMs) {
    return { shouldThrottle: true, reason: 'recent_attempt' };
  }

  return { shouldThrottle: false, reason: null };
}

function persistAdminHeartbeatRefreshRecord(
  storage: StorageLike | null,
  key: string,
  record: AdminHeartbeatRefreshRecord,
): void {
  if (!storage) {
    return;
  }

  try {
    storage.setItem(key, JSON.stringify(record));
  } catch (error) {
    console.warn('[admin-heartbeat-refresh] Failed to persist throttle record.', error);
  }
}

export async function discoverStaleAdminHeartbeatCircles(args: {
  userAddress: string;
  client?: SuiClient;
  now?: number;
  staleThresholdMs?: number;
  logger?: LoggerLike;
}): Promise<StaleAdminHeartbeatCircle[]> {
  const {
    userAddress,
    client = getSuiClientFromPool(getCurrentRpcUrl()),
    now = Date.now(),
    staleThresholdMs = ADMIN_LOGIN_HEARTBEAT_STALE_THRESHOLD_MS,
    logger = console,
  } = args;

  const normalizedUser = normalizeAddress(userAddress);
  if (!normalizedUser) {
    return [];
  }

  const packageIds = await getUserPackageIds(normalizedUser);
  const circleCreatedEvents = await batchQueryEvents(
    packageIds,
    'CircleCreated',
    client,
    {
      maxConcurrent: 5,
      limit: 1000,
      order: 'descending',
    },
  );

  const candidateCircleIds = Array.from(new Set(
    circleCreatedEvents
      .map((event) => event.parsedJson as CircleCreatedEventLike | undefined)
      .filter((event): event is CircleCreatedEventLike => Boolean(event))
      .filter((event) => normalizeAddress(event.admin) === normalizedUser)
      .map((event) => event.circle_id)
      .filter((circleId): circleId is string => typeof circleId === 'string' && circleId.length > 0),
  ));

  if (candidateCircleIds.length === 0) {
    return [];
  }

  const staleCutoff = now - staleThresholdMs;
  const discoveryResults = await Promise.allSettled(
    candidateCircleIds.map(async (circleId) => {
      const dynamicFields = await client.getDynamicFields({ parentId: circleId });
      const configFields = await getCircleConfigFieldsFromDynamicFields(client, dynamicFields.data);
      const recoveryStatus = parseRecoveryStatus(configFields);

      if (!recoveryStatus || !recoveryStatus.autoReleaseEnabled) {
        return null;
      }

      if (recoveryStatus.rawState === 2 || recoveryStatus.rawState === 3) {
        return null;
      }

      if (recoveryStatus.lastAdminHeartbeatAt > staleCutoff) {
        return null;
      }

      return {
        circleId,
        lastAdminHeartbeatAt: recoveryStatus.lastAdminHeartbeatAt,
        autoReleaseTriggerTime: recoveryStatus.autoReleaseTriggerTime,
        recoveryState: recoveryStatus.rawState,
      } satisfies StaleAdminHeartbeatCircle;
    }),
  );

  const staleCircles = discoveryResults.flatMap((result, index) => {
    if (result.status === 'fulfilled') {
      return result.value ? [result.value] : [];
    }

    logger.warn(
      '[admin-heartbeat-refresh] Failed to inspect circle during stale discovery.',
      {
        circleId: candidateCircleIds[index],
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      },
    );
    return [];
  });

  return staleCircles.sort((left, right) => left.lastAdminHeartbeatAt - right.lastAdminHeartbeatAt);
}

export async function refreshAdminHeartbeatsAfterAuth(args: {
  account: AccountData;
  heartbeatClient: HeartbeatSubmitter;
  source: 'login_success' | 'session_restore';
  storage?: StorageLike | null;
  logger?: LoggerLike;
  now?: number;
  network?: NetworkType;
  discoverCircles?: (args: {
    userAddress: string;
    now: number;
    staleThresholdMs: number;
    logger: LoggerLike;
  }) => Promise<StaleAdminHeartbeatCircle[]>;
}): Promise<LoginDrivenHeartbeatRefreshResult> {
  const {
    account,
    heartbeatClient,
    source,
    storage = getDefaultStorage(),
    logger = console,
    now = Date.now(),
    network = getCurrentNetwork(),
    discoverCircles,
  } = args;

  const normalizedUser = normalizeAddress(account.userAddr);
  if (!normalizedUser) {
    return {
      status: 'noop',
      reason: 'no_stale_circles',
      circleIds: [],
    };
  }

  const storageKey = getAdminHeartbeatRefreshStorageKey(normalizedUser, network);
  if (inflightRefreshes.has(storageKey)) {
    logger.info('[admin-heartbeat-refresh] Skipping duplicate auth-triggered heartbeat refresh.', {
      userAddress: normalizedUser,
      source,
    });
    return {
      status: 'throttled',
      reason: 'already_inflight',
      circleIds: [],
    };
  }

  const existingRecord = parseAdminHeartbeatRefreshRecord(storage?.getItem(storageKey) ?? null);
  const throttleState = getAdminHeartbeatRefreshThrottleState({
    record: existingRecord,
    now,
  });

  if (throttleState.shouldThrottle) {
    logger.info('[admin-heartbeat-refresh] Throttled auth-triggered heartbeat refresh.', {
      userAddress: normalizedUser,
      source,
      reason: throttleState.reason,
    });
    return {
      status: 'throttled',
      reason: throttleState.reason ?? 'recent_attempt',
      circleIds: existingRecord?.lastCircleIds ?? [],
    };
  }

  inflightRefreshes.add(storageKey);

  try {
    const staleCircles = await (discoverCircles ?? discoverStaleAdminHeartbeatCircles)({
      userAddress: normalizedUser,
      now,
      staleThresholdMs: ADMIN_LOGIN_HEARTBEAT_STALE_THRESHOLD_MS,
      logger,
    });
    const circleIds = staleCircles.map((circle) => circle.circleId);

    if (circleIds.length === 0) {
      persistAdminHeartbeatRefreshRecord(storage, storageKey, {
        lastAttemptAt: now,
        lastResult: 'noop',
        lastSuccessAt: existingRecord?.lastSuccessAt ?? null,
        lastFailureAt: existingRecord?.lastFailureAt ?? null,
        lastSource: source,
        lastCircleIds: [],
      });

      logger.info('[admin-heartbeat-refresh] No stale admin circles found during auth refresh.', {
        userAddress: normalizedUser,
        source,
      });

      return {
        status: 'noop',
        reason: 'no_stale_circles',
        circleIds: [],
      };
    }

    const response = await heartbeatClient.batchHeartbeatAdminLiveness(account, {
      circleIds,
      network,
    });

    persistAdminHeartbeatRefreshRecord(storage, storageKey, {
      lastAttemptAt: now,
      lastResult: 'success',
      lastSuccessAt: now,
      lastFailureAt: existingRecord?.lastFailureAt ?? null,
      lastSource: source,
      lastCircleIds: circleIds,
    });

    logger.info('[admin-heartbeat-refresh] Submitted batched admin heartbeat refresh after auth.', {
      userAddress: normalizedUser,
      source,
      circleIds,
      digest: response.digest,
    });

    return {
      status: 'submitted',
      reason: 'submitted',
      circleIds,
      digest: response.digest,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    persistAdminHeartbeatRefreshRecord(storage, storageKey, {
      lastAttemptAt: now,
      lastResult: 'failure',
      lastSuccessAt: existingRecord?.lastSuccessAt ?? null,
      lastFailureAt: now,
      lastSource: source,
      lastCircleIds: existingRecord?.lastCircleIds ?? [],
    });

    logger.warn('[admin-heartbeat-refresh] Auth-triggered heartbeat refresh failed.', {
      userAddress: normalizedUser,
      source,
      error: errorMessage,
    });

    return {
      status: 'failed',
      reason: 'submission_failed',
      circleIds: existingRecord?.lastCircleIds ?? [],
    };
  } finally {
    inflightRefreshes.delete(storageKey);
  }
}
