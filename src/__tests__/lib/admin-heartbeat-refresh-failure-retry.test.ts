// Follow-up to NJA-3971 (admin heartbeat). Place at
// src/__tests__/lib/admin-heartbeat-refresh-failure-retry.test.ts.
// All three cases fail on main 2d2c74ab + NJA-3971 (PR #180); the network is stubbed.
import type { AccountData } from '../../services/zkLoginService';
import {
  ADMIN_LOGIN_HEARTBEAT_FAILURE_RETRY_MS,
  getAdminHeartbeatRefreshStorageKey,
  parseAdminHeartbeatRefreshRecord,
  refreshAdminHeartbeatsAfterAuth,
} from '../../lib/admin-heartbeat-refresh';

jest.mock('@/services/circle-service', () => ({
  batchQueryEvents: jest.fn(),
  getSuiClientFromPool: jest.fn(),
  getUserPackageIds: jest.fn(),
}));

jest.mock('@/services/network-config', () => ({
  getCurrentNetwork: jest.fn(() => 'testnet'),
  getCurrentRpcUrl: jest.fn(() => 'https://rpc.test'),
}));

const { batchQueryEvents, getSuiClientFromPool, getUserPackageIds } = jest.requireMock(
  '@/services/circle-service',
) as {
  batchQueryEvents: jest.Mock;
  getSuiClientFromPool: jest.Mock;
  getUserPackageIds: jest.Mock;
};

const USER = '0x0000000000000000000000000000000000000000000000000000000000003971';

const account = {
  provider: 'Google',
  userAddr: USER,
  zkProofs: { proofPoints: {}, issBase64Details: {}, headerBase64: 'header' },
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

const quietLogger = () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() });

describe('admin heartbeat refresh: failed reads are retried, never held as facts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('retries a failure the refresh itself recorded once the 15-minute window has passed', async () => {
    const now = 1_710_000_000_000;
    const storage = createStorage();
    const heartbeatClient = {
      batchHeartbeatAdminLiveness: jest.fn(async () => ({ digest: '0xdeadbeef' })),
    };

    // 1. The scan fails: the refresh records a failure, with lastAttemptAt = lastFailureAt = now.
    const first = await refreshAdminHeartbeatsAfterAuth({
      account,
      heartbeatClient,
      source: 'login_success',
      storage,
      logger: quietLogger(),
      now,
      discoverCircles: async () => {
        throw new Error('scan failed');
      },
    });
    expect(first.status).toBe('failed');

    // 2. Inside the window: still held, as a recent failure.
    const discoverInside = jest.fn(async () => []);
    const inside = await refreshAdminHeartbeatsAfterAuth({
      account,
      heartbeatClient,
      source: 'session_restore',
      storage,
      logger: quietLogger(),
      now: now + ADMIN_LOGIN_HEARTBEAT_FAILURE_RETRY_MS - 1000,
      discoverCircles: discoverInside,
    });
    expect(inside).toMatchObject({ status: 'throttled', reason: 'recent_failure' });
    expect(discoverInside).not.toHaveBeenCalled();

    // 3. After the window: the scan runs again. It must not be held for the
    //    6-hour discovery throttle just because the failure stamped lastAttemptAt.
    const discoverAfter = jest.fn(async () => []);
    const after = await refreshAdminHeartbeatsAfterAuth({
      account,
      heartbeatClient,
      source: 'session_restore',
      storage,
      logger: quietLogger(),
      now: now + ADMIN_LOGIN_HEARTBEAT_FAILURE_RETRY_MS + 1000,
      discoverCircles: discoverAfter,
    });
    expect(discoverAfter).toHaveBeenCalledTimes(1);
    expect(after.status).toBe('noop');
  });

  it('records a failure, not noop, when every candidate circle could not be inspected', async () => {
    const now = 1_710_000_000_000;
    const storage = createStorage();
    const heartbeatClient = {
      batchHeartbeatAdminLiveness: jest.fn(async () => ({ digest: '0xdeadbeef' })),
    };

    getUserPackageIds.mockResolvedValue(['0xpack1']);
    // The scan itself succeeds and finds one circle this user administers...
    batchQueryEvents.mockResolvedValue([
      { parsedJson: { circle_id: '0xcircle1', admin: USER } },
    ]);
    // ...but reading that circle's config fails.
    getSuiClientFromPool.mockReturnValue({
      getDynamicFields: jest.fn(async () => {
        throw new Error('read failed');
      }),
    });

    const result = await refreshAdminHeartbeatsAfterAuth({
      account,
      heartbeatClient,
      source: 'login_success',
      storage,
      logger: quietLogger(),
      now,
    });

    expect(heartbeatClient.batchHeartbeatAdminLiveness).not.toHaveBeenCalled();
    // An unread circle is not a fresh one: this must not become "no stale circles".
    expect(result.status).toBe('failed');
    const key = getAdminHeartbeatRefreshStorageKey(USER, 'testnet');
    expect(parseAdminHeartbeatRefreshRecord(storage.getItem(key))).toMatchObject({
      lastResult: 'failure',
      lastFailureAt: now,
    });
  });

  it('records a failure, not noop, when one circle was read and another could not be', async () => {
    const now = 1_710_000_000_000;
    const storage = createStorage();
    const heartbeatClient = {
      batchHeartbeatAdminLiveness: jest.fn(async () => ({ digest: '0xdeadbeef' })),
    };

    getUserPackageIds.mockResolvedValue(['0xpack1']);
    batchQueryEvents.mockResolvedValue([
      { parsedJson: { circle_id: '0xreadable', admin: USER } },
      { parsedJson: { circle_id: '0xunreadable', admin: USER } },
    ]);
    // 0xreadable is read and has no config (so it is not stale); 0xunreadable fails.
    getSuiClientFromPool.mockReturnValue({
      getDynamicFields: jest.fn(async ({ parentId }: { parentId: string }) => {
        if (parentId === '0xunreadable') {
          throw new Error('read failed');
        }
        return { data: [], hasNextPage: false, nextCursor: null };
      }),
    });

    const result = await refreshAdminHeartbeatsAfterAuth({
      account,
      heartbeatClient,
      source: 'login_success',
      storage,
      logger: quietLogger(),
      now,
    });

    expect(heartbeatClient.batchHeartbeatAdminLiveness).not.toHaveBeenCalled();
    // Nothing stale was found, but one circle went unread: that is not "no stale circles".
    expect(result.status).toBe('failed');
    const key = getAdminHeartbeatRefreshStorageKey(USER, 'testnet');
    expect(parseAdminHeartbeatRefreshRecord(storage.getItem(key))).toMatchObject({
      lastResult: 'failure',
      lastFailureAt: now,
    });
  });
});
