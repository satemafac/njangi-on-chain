import type { AccountData } from '@/services/zkLoginService';
import { ZkLoginClient } from '@/services/zkLoginClient';

jest.mock('../circle-service', () => ({
  getCircleTransactionPackageId: jest.fn(),
}));

jest.mock('../network-config', () => ({
  getCurrentNetwork: jest.fn(() => 'testnet'),
  getCurrentPackageId: jest.fn(() => '0xabc'),
  getNetworkConfig: jest.fn(() => ({ rpcUrl: 'https://rpc.invalid' })),
}));

jest.mock('@/lib/zklogin-client-signer', () => ({
  loadSignerSession: jest.fn(),
  signAndExecuteWithZkLogin: jest.fn(),
}));

const { getCircleTransactionPackageId } = jest.requireMock('../circle-service') as {
  getCircleTransactionPackageId: jest.Mock;
};

const { loadSignerSession, signAndExecuteWithZkLogin } = jest.requireMock(
  '@/lib/zklogin-client-signer',
) as {
  loadSignerSession: jest.Mock;
  signAndExecuteWithZkLogin: jest.Mock;
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

/** Serialized move-call targets from the transaction handed to the signer. */
function signedTargets(callIndex = 0): string[] {
  const input = signAndExecuteWithZkLogin.mock.calls[callIndex][2];
  const tx = JSON.parse(input.transaction.serialize());
  return tx.transactions.map((command: { target: string }) => command.target);
}

describe('ZkLoginClient liveness transaction methods', () => {
  const originalFetch = global.fetch;
  const globalWithWindow = global as typeof global & { window?: unknown };
  const hadWindow = 'window' in globalWithWindow;

  beforeEach(() => {
    // The suite runs under `testEnvironment: 'node'`, but `tryClientSideSigner`
    // short-circuits when `window` is undefined. Stub it so the local signing
    // path is exercised rather than silently skipped.
    globalWithWindow.window = globalWithWindow.window ?? {};
    getCircleTransactionPackageId.mockReset();
    signAndExecuteWithZkLogin.mockReset();
    signAndExecuteWithZkLogin.mockResolvedValue({ digest: '0xdeadbeef' });
    loadSignerSession.mockReset();
    loadSignerSession.mockReturnValue({
      ephemeralPrivateKey: 'ephemeral-private-key',
      zkProofs: {},
      userSalt: 'salt',
      userAddress: account.userAddr,
      sub: 'sub',
      aud: 'aud',
      maxEpoch: 1,
      network: 'testnet',
    });
    global.fetch = jest.fn(async () => {
      throw new Error('No transaction may be sent to the server for signing.');
    }) as unknown as typeof fetch;
  });

  afterAll(() => {
    global.fetch = originalFetch;
    if (!hadWindow) Reflect.deleteProperty(globalWithWindow, 'window');
  });

  it('signs a heartbeat transaction locally instead of posting it to the server', async () => {
    getCircleTransactionPackageId.mockResolvedValue('0xabc');
    const client = ZkLoginClient.getInstance();

    const result = await client.heartbeatAdminLiveness(account, {
      circleId: '0x123',
      network: 'testnet',
    });

    expect(getCircleTransactionPackageId).toHaveBeenCalledWith('0x123', account.userAddr);
    // The signing oracle is gone: nothing is POSTed anywhere.
    expect(global.fetch).not.toHaveBeenCalled();
    expect(signAndExecuteWithZkLogin).toHaveBeenCalledTimes(1);
    expect(result.digest).toBe('0xdeadbeef');

    expect(signedTargets()).toEqual([
      '0x0000000000000000000000000000000000000000000000000000000000000abc::njangi_circles::heartbeat_admin_liveness',
    ]);
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
    expect(global.fetch).not.toHaveBeenCalled();
    expect(signedTargets()).toEqual([
      '0x0000000000000000000000000000000000000000000000000000000000000aaa::njangi_circles::heartbeat_admin_liveness',
      '0x0000000000000000000000000000000000000000000000000000000000000bbb::njangi_circles::heartbeat_admin_liveness',
    ]);
  });

  it('rejects empty batch heartbeat requests before signing', async () => {
    const client = ZkLoginClient.getInstance();

    await expect(
      client.batchHeartbeatAdminLiveness(account, {
        circleIds: ['   '],
        network: 'testnet',
      }),
    ).rejects.toThrow('At least one circle ID is required.');

    expect(signAndExecuteWithZkLogin).not.toHaveBeenCalled();
  });

  it('asks the user to sign in again when no local signing session exists', async () => {
    getCircleTransactionPackageId.mockResolvedValue('0xabc');
    loadSignerSession.mockReturnValue(null);
    const client = ZkLoginClient.getInstance();

    await expect(
      client.heartbeatAdminLiveness(account, { circleId: '0x123', network: 'testnet' }),
    ).rejects.toThrow('Your signing session is unavailable. Please sign in again.');

    // Critically: it must NOT silently fall back to server-side signing.
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
