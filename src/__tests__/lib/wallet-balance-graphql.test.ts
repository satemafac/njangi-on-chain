// NJA-2839: every configured Sui JSON-RPC endpoint refuses JSON-RPC
// (publicnode -32000, blockvision 404, Sui fullnode -32601) while Sui's GraphQL
// service still answers. The wallet balance helpers must read the balance from
// GraphQL first (raw fetch), use JSON-RPC only as the fallback, and refuse an
// unreadable answer instead of reading it as zero. Mirrors src/lib/sui-epoch.ts.
const mockGetBalance = jest.fn();

jest.mock('@/services/sui-rpc-failover', () => ({
  getPooledSuiClient: jest.fn(() => ({ getBalance: mockGetBalance })),
  withSuiRpcFailover: jest.fn(
    async (_network: unknown, _name: unknown, operation: (client: unknown) => Promise<unknown>) =>
      operation({ getBalance: mockGetBalance }),
  ),
}));

jest.mock('@/services/network-config', () => {
  const graphqlUrl = (network: string) => `https://graphql.${network}.example/graphql`;
  const config = (network: string) => ({
    rpcUrl: `https://rpc.${network}.example`,
    rpcAltUrl: `https://rpc-alt.${network}.example`,
    graphqlUrl: graphqlUrl(network),
    packageId: '0x1',
    enoki: { apiKey: '', network },
  });
  return {
    getGraphqlUrlForNetwork: graphqlUrl,
    getCurrentGraphqlUrl: () => graphqlUrl('testnet'),
    getCurrentNetwork: () => 'testnet',
    getCurrentRpcUrl: () => config('testnet').rpcUrl,
    getRpcUrlForNetwork: (network: string) => config(network).rpcUrl,
    getNetworkConfig: config,
    getCurrentNetworkConfig: () => config('testnet'),
  };
});

import {
  clearWalletBalanceCache,
  refreshSuiBalance,
  refreshWalletBalances,
} from '../../lib/wallet';

const SUI = '0x2::sui::SUI';
const USDC = '0x26b3bc67befc214058ca78ea9a2690298d731a2d4309485ec3d40198063c4abc::usdc::USDC';

// Exactly 64 hex digits after 0x (a previous attempt used 72 and the fix had
// to correct the test).
const walletAddress =
  '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

// The refusal Sui's own fullnode gives (-32601), as the SDK surfaces it.
const jsonRpcRefused = new Error(
  'Method not found. JSON-RPC on public fullnodes has been deprecated. Please migrate to gRPC or GraphQL endpoints.',
);

function graphqlResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

// Recorded live 2026-11-15 against graphql.testnet.sui.io: an empty wallet
// answers totalBalance '0' (a string), not null.
function balanceAnswer(totalBalance: string | null) {
  return { data: { address: { balance: { totalBalance } } } };
}

function requestBody(call: unknown[] | undefined): string {
  const init = call?.[1] as { body?: unknown } | undefined;
  return typeof init?.body === 'string' ? init.body : JSON.stringify(init?.body ?? '');
}

describe('wallet balance helpers read Sui GraphQL first (NJA-2839)', () => {
  const fetchMock = jest.fn();
  const originalFetch = global.fetch;

  beforeEach(() => {
    mockGetBalance.mockReset();
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
    clearWalletBalanceCache();
    process.env.NEXT_PUBLIC_SUI_NETWORK = 'testnet';
    process.env.NEXT_PUBLIC_TESTNET_USDC = USDC;
    process.env.NEXT_PUBLIC_TESTNET_RPC_URL = 'https://fullnode.testnet.sui.io:443';
    process.env.NEXT_PUBLIC_TESTNET_GRAPHQL_URL = 'https://graphql.testnet.example/graphql';
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it('uses a valid Sui address (0x + exactly 64 hex digits) in these tests', () => {
    expect(walletAddress).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('reads the SUI balance over GraphQL while every JSON-RPC endpoint refuses JSON-RPC', async () => {
    fetchMock.mockResolvedValue(graphqlResponse(balanceAnswer('1500000000')));
    mockGetBalance.mockRejectedValue(jsonRpcRefused);

    await expect(refreshSuiBalance(walletAddress, { forceRefresh: true })).resolves.toMatchObject({
      symbol: 'SUI',
      coinType: SUI,
      totalBalance: '1500000000',
      source: 'chain',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [unknown, { method?: string } | undefined];
    expect(String(url)).toMatch(/graphql/i);
    expect(init?.method).toBe('POST');
    const body = requestBody(fetchMock.mock.calls[0]);
    expect(body).toContain(walletAddress);
    expect(body).toContain(SUI);
    // GraphQL answered, so JSON-RPC was never needed.
    expect(mockGetBalance).not.toHaveBeenCalled();
  });

  it('reads an empty wallet as 0 over GraphQL (totalBalance is the string 0, not null)', async () => {
    fetchMock.mockResolvedValue(graphqlResponse(balanceAnswer('0')));
    mockGetBalance.mockRejectedValue(jsonRpcRefused);

    const result = await refreshSuiBalance(walletAddress, { forceRefresh: true });

    expect(result.totalBalance).toBe('0');
    expect(result.source).toBe('chain');
  });

  it('refreshWalletBalances reads SUI and USDC over GraphQL while JSON-RPC is refused', async () => {
    fetchMock.mockImplementation(async (_url: unknown, init?: { body?: unknown }) => {
      const body = typeof init?.body === 'string' ? init.body : '';
      return graphqlResponse(balanceAnswer(body.includes(USDC) ? '200' : '100'));
    });
    mockGetBalance.mockRejectedValue(jsonRpcRefused);

    const snapshot = await refreshWalletBalances(walletAddress, { forceRefresh: true });

    expect(snapshot.walletAddress).toBe(walletAddress);
    expect(snapshot.sui.totalBalance).toBe('100');
    expect(snapshot.usdc.totalBalance).toBe('200');
    expect(snapshot.source).toBe('chain');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('refuses an unreadable answer from both sources instead of resolving a balance', async () => {
    // GraphQL answers without a balance; the JSON-RPC fallback answers a body
    // with no totalBalance. Neither is a reading, so neither may become a value.
    fetchMock.mockResolvedValue(graphqlResponse({ data: { address: null } }));
    mockGetBalance.mockResolvedValue({});

    await expect(refreshSuiBalance(walletAddress, { forceRefresh: true })).rejects.toThrow();
  });

  it('refuses a GraphQL error when JSON-RPC is refused too, never a zero balance', async () => {
    fetchMock.mockResolvedValue(graphqlResponse({ errors: [{ message: 'boom' }] }));
    mockGetBalance.mockRejectedValue(jsonRpcRefused);

    await expect(refreshSuiBalance(walletAddress, { forceRefresh: true })).rejects.toThrow();
  });
});
