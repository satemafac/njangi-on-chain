import type { AccountData } from '../../services/zkLoginService';
import {
  getAdminHeartbeatRefreshStorageKey,
  parseAdminHeartbeatRefreshRecord,
  refreshAdminHeartbeatsAfterAuth,
} from '../../lib/admin-heartbeat-refresh';

// Stub the network: the event scan and package lookup never leave the test.
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
  userAddr: '0x0000000000000000000000000000000000000000000000000000000000003971',
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

describe('admin heartbeat refresh when the CircleCreated scan fails (NJA-3971)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('records a failure, not noop, when batchQueryEvents could not read the packages', async () => {
    const now = 1_710_000_000_000;
    const storage = createStorage();
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const heartbeatClient = {
      batchHeartbeatAdminLiveness: jest.fn(async () => ({ digest: '0xdeadbeef' })),
    };

    getUserPackageIds.mockResolvedValue(['0xpack1']);

    // Behave like the real batchQueryEvents in src/services/circle-service.ts
    // when every package fails all retries: with throwOnFailure it throws
    // (line 1020); with the default it silently returns the empty partial
    // list (line 1025) as if the scan had succeeded and found nothing.
    batchQueryEvents.mockImplementation(
      async (
        packageIds: string[],
        eventType: string,
        _client: unknown,
        options?: { throwOnFailure?: boolean },
      ) => {
        if (options?.throwOnFailure) {
          throw new Error(
            `Could not query ${eventType} for ${packageIds.length} of ${packageIds.length} package(s); the result would be incomplete.`,
          );
        }
        return [];
      },
    );

    // No discoverCircles override: exercise the real discoverStaleAdminHeartbeatCircles.
    const result = await refreshAdminHeartbeatsAfterAuth({
      account,
      heartbeatClient,
      source: 'login_success',
      storage,
      logger,
      now,
    });

    expect(batchQueryEvents).toHaveBeenCalledTimes(1);
    expect(heartbeatClient.batchHeartbeatAdminLiveness).not.toHaveBeenCalled();

    // A failed read is not "no stale circles": the refresh must report and
    // record a failure (retried after 15 min), not a noop (held for 6 h).
    expect(result.status).toBe('failed');

    const key = getAdminHeartbeatRefreshStorageKey(account.userAddr, 'testnet');
    const record = parseAdminHeartbeatRefreshRecord(storage.getItem(key));
    expect(record).toMatchObject({
      lastResult: 'failure',
      lastFailureAt: now,
      lastAttemptAt: now,
      lastSource: 'login_success',
    });
  });
});
