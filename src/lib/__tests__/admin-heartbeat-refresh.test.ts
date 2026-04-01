import type { SuiClient } from '@mysten/sui/client';
import type { AccountData } from '@/services/zkLoginService';
import {
  ADMIN_LOGIN_HEARTBEAT_DISCOVERY_THROTTLE_MS,
  ADMIN_LOGIN_HEARTBEAT_FAILURE_RETRY_MS,
  ADMIN_LOGIN_HEARTBEAT_STALE_THRESHOLD_MS,
  discoverStaleAdminHeartbeatCircles,
  getAdminHeartbeatRefreshStorageKey,
  getAdminHeartbeatRefreshThrottleState,
  parseAdminHeartbeatRefreshRecord,
  refreshAdminHeartbeatsAfterAuth,
} from '@/lib/admin-heartbeat-refresh';

jest.mock('@/services/circle-service', () => ({
  batchQueryEvents: jest.fn(),
  getSuiClientFromPool: jest.fn(),
  getUserPackageIds: jest.fn(),
}));

jest.mock('@/services/network-config', () => ({
  getCurrentNetwork: jest.fn(() => 'testnet'),
  getCurrentRpcUrl: jest.fn(() => 'https://rpc.test'),
}));

const { batchQueryEvents, getUserPackageIds } = jest.requireMock('@/services/circle-service') as {
  batchQueryEvents: jest.Mock;
  getUserPackageIds: jest.Mock;
};

const account = {
  provider: 'Google',
  userAddr: '0x0000000000000000000000000000000000000000000000000000000000000aaa',
  zkProofs: {
    proofPoints: {},
    issBase64Details: {},
    headerBase64: 'header',
  },
  ephemeralPrivateKey: 'ephemeral-private-key',
  userSalt: 'salt',
  sub: 'sub',
  aud: 'aud',
  maxEpoch: 1,
} as unknown as AccountData;

const createStorage = (): Pick<Storage, 'getItem' | 'setItem'> => {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
};

const createConfigObject = (fields: Record<string, unknown>) => ({
  data: {
    content: {
      fields: {
        value: {
          fields,
        },
      },
    },
  },
});

describe('admin heartbeat refresh helpers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('discovers only stale admin circles with recovery enabled and non-terminal state', async () => {
    const now = 1_710_000_000_000;
    const staleHeartbeat = now - ADMIN_LOGIN_HEARTBEAT_STALE_THRESHOLD_MS - 10_000;
    const freshHeartbeat = now - 5 * 60 * 1000;
    const client: Pick<SuiClient, 'getDynamicFields' | 'getObject' | 'queryEvents'> = {
      getDynamicFields: jest.fn(async ({ parentId }: { parentId: string }) => ({
        data: [{ objectId: `config-${parentId}`, objectType: '0x1::circle_config::CircleConfig' }],
      })),
      getObject: jest.fn(async ({ id }: { id: string }) => {
        if (id === 'config-0xstale') {
          return createConfigObject({
            recovery_state: '0',
            recovery_proposal: { vec: [] },
            auto_release_enabled: true,
            auto_release_delay_ms: '1000',
            auto_release_start_time: String(staleHeartbeat),
            next_in_command: { vec: [] },
            recovery_state_updated_at: String(now),
          });
        }

        if (id === 'config-0xfresh') {
          return createConfigObject({
            recovery_state: '0',
            recovery_proposal: { vec: [] },
            auto_release_enabled: true,
            auto_release_delay_ms: '1000',
            auto_release_start_time: String(freshHeartbeat),
            next_in_command: { vec: [] },
            recovery_state_updated_at: String(now),
          });
        }

        if (id === 'config-0xdisabled') {
          return createConfigObject({
            recovery_state: '0',
            recovery_proposal: { vec: [] },
            auto_release_enabled: false,
            auto_release_delay_ms: '1000',
            auto_release_start_time: String(staleHeartbeat),
            next_in_command: { vec: [] },
            recovery_state_updated_at: String(now),
          });
        }

        return createConfigObject({
          recovery_state: '3',
          recovery_proposal: { vec: [] },
          auto_release_enabled: true,
          auto_release_delay_ms: '1000',
          auto_release_start_time: String(staleHeartbeat),
          next_in_command: { vec: [] },
          recovery_state_updated_at: String(now),
        });
      }),
      queryEvents: jest.fn(),
    };

    getUserPackageIds.mockResolvedValue(['0xpack1']);
    batchQueryEvents.mockResolvedValue([
      { parsedJson: { circle_id: '0xstale', admin: account.userAddr } },
      { parsedJson: { circle_id: '0xfresh', admin: account.userAddr } },
      { parsedJson: { circle_id: '0xdisabled', admin: account.userAddr } },
      { parsedJson: { circle_id: '0xterminal', admin: account.userAddr } },
      { parsedJson: { circle_id: '0xother', admin: '0x999' } },
      { parsedJson: { circle_id: '0xstale', admin: account.userAddr } },
    ]);

    const circles = await discoverStaleAdminHeartbeatCircles({
      userAddress: account.userAddr,
      client,
      now,
    });

    expect(circles).toEqual([
      {
        circleId: '0xstale',
        lastAdminHeartbeatAt: staleHeartbeat,
        autoReleaseTriggerTime: staleHeartbeat + 1000,
        recoveryState: 0,
      },
    ]);
  });

  it('applies different throttle windows for recent attempts and recent failures', () => {
    const now = 1_710_000_000_000;

    expect(
      getAdminHeartbeatRefreshThrottleState({
        record: {
          lastAttemptAt: now - 1000,
          lastResult: 'success',
          lastSuccessAt: now - 1000,
          lastFailureAt: null,
          lastSource: 'login_success',
          lastCircleIds: [],
        },
        now,
      }),
    ).toEqual({
      shouldThrottle: true,
      reason: 'recent_attempt',
    });

    expect(
      getAdminHeartbeatRefreshThrottleState({
        record: {
          lastAttemptAt: now - ADMIN_LOGIN_HEARTBEAT_DISCOVERY_THROTTLE_MS - 1000,
          lastResult: 'failure',
          lastSuccessAt: null,
          lastFailureAt: now - 1000,
          lastSource: 'session_restore',
          lastCircleIds: [],
        },
        now,
      }),
    ).toEqual({
      shouldThrottle: true,
      reason: 'recent_failure',
    });

    expect(
      getAdminHeartbeatRefreshThrottleState({
        record: {
          lastAttemptAt: now - ADMIN_LOGIN_HEARTBEAT_DISCOVERY_THROTTLE_MS - 1000,
          lastResult: 'failure',
          lastSuccessAt: null,
          lastFailureAt: now - ADMIN_LOGIN_HEARTBEAT_FAILURE_RETRY_MS - 1000,
          lastSource: 'session_restore',
          lastCircleIds: [],
        },
        now,
      }),
    ).toEqual({
      shouldThrottle: false,
      reason: null,
    });
  });

  it('submits a best-effort batch heartbeat and then throttles rapid repeats', async () => {
    const now = 1_710_000_000_000;
    const storage = createStorage();
    const heartbeatClient = {
      batchHeartbeatAdminLiveness: jest.fn(async () => ({ digest: '0xdeadbeef' })),
    };
    const discoverCircles = jest.fn(async () => [
      {
        circleId: '0xstale',
        lastAdminHeartbeatAt: now - ADMIN_LOGIN_HEARTBEAT_STALE_THRESHOLD_MS - 1,
        autoReleaseTriggerTime: now + 1000,
        recoveryState: 0,
      },
    ]);

    const firstResult = await refreshAdminHeartbeatsAfterAuth({
      account,
      heartbeatClient,
      source: 'login_success',
      storage,
      now,
      discoverCircles,
    });

    expect(firstResult).toEqual({
      status: 'submitted',
      reason: 'submitted',
      circleIds: ['0xstale'],
      digest: '0xdeadbeef',
    });
    expect(heartbeatClient.batchHeartbeatAdminLiveness).toHaveBeenCalledWith(account, {
      circleIds: ['0xstale'],
      network: 'testnet',
    });

    const secondResult = await refreshAdminHeartbeatsAfterAuth({
      account,
      heartbeatClient,
      source: 'session_restore',
      storage,
      now: now + 60_000,
      discoverCircles,
    });

    expect(secondResult).toEqual({
      status: 'throttled',
      reason: 'recent_attempt',
      circleIds: ['0xstale'],
    });
    expect(heartbeatClient.batchHeartbeatAdminLiveness).toHaveBeenCalledTimes(1);
  });

  it('swallows submission failures and stores retry metadata', async () => {
    const now = 1_710_000_000_000;
    const storage = createStorage();
    const heartbeatClient = {
      batchHeartbeatAdminLiveness: jest.fn(async () => {
        throw new Error('rpc unavailable');
      }),
    };

    const result = await refreshAdminHeartbeatsAfterAuth({
      account,
      heartbeatClient,
      source: 'session_restore',
      storage,
      now,
      discoverCircles: async () => [
        {
          circleId: '0xstale',
          lastAdminHeartbeatAt: now - ADMIN_LOGIN_HEARTBEAT_STALE_THRESHOLD_MS - 1,
          autoReleaseTriggerTime: now + 1000,
          recoveryState: 1,
        },
      ],
    });

    expect(result).toEqual({
      status: 'failed',
      reason: 'submission_failed',
      circleIds: [],
    });

    const key = getAdminHeartbeatRefreshStorageKey(account.userAddr, 'testnet');
    expect(parseAdminHeartbeatRefreshRecord(storage.getItem(key))).toMatchObject({
      lastResult: 'failure',
      lastFailureAt: now,
      lastSource: 'session_restore',
    });
  });

  it('records a noop result when no stale circles need a heartbeat', async () => {
    const now = 1_710_000_000_000;
    const storage = createStorage();
    const heartbeatClient = {
      batchHeartbeatAdminLiveness: jest.fn(async () => ({ digest: '0xdeadbeef' })),
    };

    const result = await refreshAdminHeartbeatsAfterAuth({
      account,
      heartbeatClient,
      source: 'login_success',
      storage,
      now,
      discoverCircles: async () => [],
    });

    expect(result).toEqual({
      status: 'noop',
      reason: 'no_stale_circles',
      circleIds: [],
    });
    expect(heartbeatClient.batchHeartbeatAdminLiveness).not.toHaveBeenCalled();

    const key = getAdminHeartbeatRefreshStorageKey(account.userAddr, 'testnet');
    expect(parseAdminHeartbeatRefreshRecord(storage.getItem(key))).toMatchObject({
      lastResult: 'noop',
      lastAttemptAt: now,
      lastSource: 'login_success',
    });
  });

  it('deduplicates concurrent auth-triggered refresh attempts for the same wallet', async () => {
    const now = 1_710_000_000_000;
    const storage = createStorage();
    let resolveDiscovery: ((value: Array<{
      circleId: string;
      lastAdminHeartbeatAt: number;
      autoReleaseTriggerTime: number | null;
      recoveryState: number;
    }>) => void) | null = null;

    const heartbeatClient = {
      batchHeartbeatAdminLiveness: jest.fn(async () => ({ digest: '0xdeadbeef' })),
    };

    const firstCallPromise = refreshAdminHeartbeatsAfterAuth({
      account,
      heartbeatClient,
      source: 'login_success',
      storage,
      now,
      discoverCircles: () =>
        new Promise((resolve) => {
          resolveDiscovery = resolve;
        }),
    });

    const secondCallResult = await refreshAdminHeartbeatsAfterAuth({
      account,
      heartbeatClient,
      source: 'session_restore',
      storage,
      now,
      discoverCircles: async () => [],
    });

    expect(secondCallResult).toEqual({
      status: 'throttled',
      reason: 'already_inflight',
      circleIds: [],
    });

    resolveDiscovery?.([
      {
        circleId: '0xstale',
        lastAdminHeartbeatAt: now - ADMIN_LOGIN_HEARTBEAT_STALE_THRESHOLD_MS - 1,
        autoReleaseTriggerTime: now + 1000,
        recoveryState: 0,
      },
    ]);

    await firstCallPromise;
    expect(heartbeatClient.batchHeartbeatAdminLiveness).toHaveBeenCalledTimes(1);
  });
});
