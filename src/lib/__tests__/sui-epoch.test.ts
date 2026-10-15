const mockWithSuiRpcFailover = jest.fn();

jest.mock('@/services/network-config', () => {
  const config = {
    rpcUrl: 'https://rpc.testnet.example',
    graphqlUrl: 'https://graphql.testnet.example/graphql',
    packageId: '0x1',
    enoki: { apiKey: 'test-key', network: 'testnet' },
  };
  return {
    getGraphqlUrlForNetwork: (network: string) => `https://graphql.${network}.example/graphql`,
    getCurrentGraphqlUrl: () => config.graphqlUrl,
    getCurrentNetwork: () => 'testnet',
    getCurrentRpcUrl: () => config.rpcUrl,
    getCurrentEnokiConfig: () => config.enoki,
    getNetworkConfig: () => config,
  };
});

jest.mock('@/services/sui-rpc-failover', () => ({
  withSuiRpcFailover: (...args: unknown[]) => mockWithSuiRpcFailover(...args),
}));

import { readCurrentSuiEpoch } from '../sui-epoch';

function graphqlResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

// The JSON-RPC fallback, as the failover wrapper would run it against a client
// whose getLatestSuiSystemState resolves (or rejects) with `result`.
function jsonRpcAnswers(result: Promise<unknown>) {
  mockWithSuiRpcFailover.mockImplementation(async (_network, _name, operation) =>
    operation({ getLatestSuiSystemState: () => result }),
  );
}

describe('readCurrentSuiEpoch', () => {
  const fetchMock = jest.fn();

  beforeEach(() => {
    mockWithSuiRpcFailover.mockReset();
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  it("reads the epoch from the network's GraphQL service without touching JSON-RPC", async () => {
    fetchMock.mockResolvedValue(graphqlResponse({ data: { epoch: { epochId: 1253 } } }));

    await expect(readCurrentSuiEpoch('testnet')).resolves.toBe(1253);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://graphql.testnet.example/graphql',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(mockWithSuiRpcFailover).not.toHaveBeenCalled();
  });

  // The 2026-10-15 outage, inverted: GraphQL down, JSON-RPC up.
  it('falls back to JSON-RPC when GraphQL is unreachable', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    jsonRpcAnswers(Promise.resolve({ epoch: '1253' }));

    await expect(readCurrentSuiEpoch('testnet')).resolves.toBe(1253);
    expect(mockWithSuiRpcFailover).toHaveBeenCalledWith('testnet', expect.any(String), expect.any(Function));
  });

  it('falls back to JSON-RPC when GraphQL answers an error status', async () => {
    fetchMock.mockResolvedValue(graphqlResponse({}, 503));
    jsonRpcAnswers(Promise.resolve({ epoch: '7' }));

    await expect(readCurrentSuiEpoch('mainnet')).resolves.toBe(7);
  });

  it('falls back to JSON-RPC when GraphQL returns errors instead of an epoch', async () => {
    fetchMock.mockResolvedValue(graphqlResponse({ errors: [{ message: 'boom' }] }));
    jsonRpcAnswers(Promise.resolve({ epoch: '42' }));

    await expect(readCurrentSuiEpoch('testnet')).resolves.toBe(42);
  });

  it('throws when neither source answers, instead of guessing an epoch', async () => {
    fetchMock.mockResolvedValue(graphqlResponse({}, 503));
    jsonRpcAnswers(Promise.reject(new Error('Unexpected status code: 503')));

    await expect(readCurrentSuiEpoch('testnet')).rejects.toThrow(
      'Could not reach the Sui testnet network to start sign-in',
    );
  });

  it('treats an unreadable epoch as a failed read', async () => {
    fetchMock.mockResolvedValue(graphqlResponse({ data: { epoch: { epochId: 'soon' } } }));
    jsonRpcAnswers(Promise.resolve({ epoch: '' }));

    await expect(readCurrentSuiEpoch('testnet')).rejects.toThrow('Could not reach the Sui testnet network');
  });
});

// The bug as users saw it: every JSON-RPC provider down, so the OAuth button
// never got a login URL. Sign-in must still start while GraphQL answers.
describe('EnokiZkLoginService.beginLogin', () => {
  const fetchMock = jest.fn();

  beforeEach(() => {
    process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID = 'google-client';
    process.env.NEXT_PUBLIC_FACEBOOK_CLIENT_ID = 'facebook-client';
    process.env.NEXT_PUBLIC_APPLE_CLIENT_ID = 'apple-client';
    process.env.NEXT_PUBLIC_REDIRECT_URI = 'https://njangionchain.com/auth/callback';
    mockWithSuiRpcFailover.mockReset();
    mockWithSuiRpcFailover.mockRejectedValue(new Error('Unexpected status code: 503'));
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(graphqlResponse({ data: { epoch: { epochId: 1253 } } }));
    global.fetch = fetchMock as unknown as typeof fetch;
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('starts sign-in from the GraphQL epoch while JSON-RPC is down', async () => {
    let service: { beginLogin: (...args: unknown[]) => Promise<{ loginUrl: string; setupData: { maxEpoch: number } }> };
    jest.isolateModules(() => {
      // Env is read when the module loads, so load it after setting env.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      service = require('@/services/enokiZkLoginService').EnokiZkLoginService.getInstance();
    });

    const { loginUrl, setupData } = await service!.beginLogin(
      'Google',
      'testnet',
      'https://njangionchain.com',
      // Any 32 bytes make a valid Ed25519 public key; no keypair needed.
      { ephemeralPublicKey: Buffer.alloc(32, 7).toString('base64'), randomness: '123456789' },
    );

    expect(setupData.maxEpoch).toBe(1254);
    expect(new URL(loginUrl).searchParams.get('nonce')).toBeTruthy();
    expect(mockWithSuiRpcFailover).not.toHaveBeenCalled();
  });
});
