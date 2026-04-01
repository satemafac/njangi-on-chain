import type { AccountData } from '@/services/zkLoginService';
import { ZkLoginClient } from '@/services/zkLoginClient';

jest.mock('../circle-service', () => ({
  getCircleTransactionPackageId: jest.fn(),
}));

jest.mock('../network-config', () => ({
  getCurrentNetwork: jest.fn(() => 'testnet'),
  getCurrentPackageId: jest.fn(() => '0xabc'),
}));

const { getCircleTransactionPackageId } = jest.requireMock('../circle-service') as {
  getCircleTransactionPackageId: jest.Mock;
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

describe('ZkLoginClient liveness transaction methods', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    getCircleTransactionPackageId.mockReset();
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ digest: '0xdeadbeef' }),
    } as Response)) as unknown as typeof fetch;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it('submits a serialized heartbeat transaction through the generic zkLogin route', async () => {
    getCircleTransactionPackageId.mockResolvedValue('0xabc');
    const client = ZkLoginClient.getInstance();

    await client.heartbeatAdminLiveness(account, {
      circleId: '0x123',
      network: 'testnet',
    });

    expect(getCircleTransactionPackageId).toHaveBeenCalledWith('0x123', account.userAddr);
    expect(global.fetch).toHaveBeenCalledTimes(1);

    const request = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(request.action).toBe('sendSerializedTransaction');
    const tx = JSON.parse(request.txb);
    expect(tx.transactions).toHaveLength(1);
    expect(tx.transactions[0].target).toBe(
      '0x0000000000000000000000000000000000000000000000000000000000000abc::njangi_circles::heartbeat_admin_liveness',
    );
  });

  it('builds a deduplicated batch heartbeat transaction across package ids', async () => {
    getCircleTransactionPackageId
      .mockResolvedValueOnce('0xaaa')
      .mockResolvedValueOnce('0xbbb');
    const client = ZkLoginClient.getInstance();

    await client.batchHeartbeatAdminLiveness(account, {
      circleIds: ['0x111', '0x222', '0x111'],
      network: 'testnet',
    });

    expect(getCircleTransactionPackageId).toHaveBeenCalledTimes(2);
    const request = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    const tx = JSON.parse(request.txb);

    expect(tx.transactions).toHaveLength(2);
    expect(tx.transactions[0].target).toBe(
      '0x0000000000000000000000000000000000000000000000000000000000000aaa::njangi_circles::heartbeat_admin_liveness',
    );
    expect(tx.transactions[1].target).toBe(
      '0x0000000000000000000000000000000000000000000000000000000000000bbb::njangi_circles::heartbeat_admin_liveness',
    );
  });

  it('rejects empty batch heartbeat requests before hitting the API', async () => {
    const client = ZkLoginClient.getInstance();

    await expect(
      client.batchHeartbeatAdminLiveness(account, {
        circleIds: ['   '],
        network: 'testnet',
      }),
    ).rejects.toThrow('At least one circle ID is required.');

    expect(global.fetch).not.toHaveBeenCalled();
  });
});
