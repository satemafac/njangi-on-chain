/**
 * NJA-2866 — the wallet balance helpers in src/lib/wallet.ts must read a
 * balance from Sui's GraphQL service first, with JSON-RPC as the fallback, and
 * refuse an unreadable answer instead of reading it as zero.
 *
 * Every JSON-RPC endpoint the app is configured with refuses JSON-RPC
 * (NJA-2830). refreshSuiBalance / refreshUsdcBalance / refreshWalletBalances
 * read only through getPooledSuiClient(...).getBalance, so create-circle and
 * the wallet refresh cannot return a balance while GraphQL would answer.
 *
 * fetch and the JSON-RPC client are stubbed here: nothing reaches the network.
 * The GraphQL stub answers in the shape verified live on 2026-11-15 for
 * `query WalletBalance($owner: SuiAddress!, $coinType: String!)`:
 * `address.balance(coinType:).totalBalance` is a decimal string, '0' for an
 * address that owns nothing. Should the fix reuse the dashboard's list read
 * instead (src/lib/wallet-balances.ts, `address.balances`), the stub answers
 * that shape too.
 */
const mockGetBalance = jest.fn();

jest.mock('../../services/sui-rpc-failover', () => {
  // Plain functions, not jest.fn: restoreMocks must not strip the client.
  const client = { getBalance: (...args: unknown[]) => mockGetBalance(...args) };
  return {
    getPooledSuiClient: () => client,
    withSuiRpcFailover: (_network: unknown, _label: unknown, run: (c: typeof client) => unknown) => run(client),
  };
});

import { clearWalletBalanceCache, refreshSuiBalance } from '../wallet';

const GRAPHQL_URL = 'https://graphql.testnet.invalid/graphql';
// A valid Sui address: 0x followed by exactly 64 hex digits.
const OWNER = `0x${'b2'.repeat(32)}`;
const SUI = '0x2::sui::SUI';
const SUI_FULL = '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';
const JSON_RPC_REFUSED = new Error(
  '-32601 Method not found. JSON-RPC on public fullnodes has been deprecated',
);

type FakeFetch = (url: unknown, init?: { body?: unknown }) => Promise<unknown>;

const fetchMock = jest.fn();
const realFetch = globalThis.fetch;

/** The JSON body of the `call`-th fetch. */
const sentBody = (call: number) => JSON.parse(String(fetchMock.mock.calls[call][1].body));

/** `address.balance(coinType:)`, the verified per-coin query, as opposed to the `address.balances(...)` list. */
const isSingleBalanceQuery = (query: string): boolean => /\bbalance\s*\(/.test(query);

/** A fetch answering `body` with `status`, whatever was asked. */
const answer = (body: unknown, status = 200): FakeFetch => async () => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

/**
 * A fetch answering as Sui's GraphQL service does for a wallet whose SUI
 * balance is `totalBalance`, in whichever of the two shapes was asked for.
 * `totalBalance` is `unknown` so a broken answer can be recorded as well.
 */
const graphqlAnswering = (totalBalance: unknown): FakeFetch => async (_url, init) => {
  const query = String(JSON.parse(String(init?.body ?? '{}')).query ?? '');
  const body = isSingleBalanceQuery(query)
    ? { data: { address: { balance: { totalBalance } } } }
    : {
        data: {
          address: {
            balances: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: totalBalance === '0' ? [] : [{ coinType: { repr: SUI_FULL }, totalBalance }],
            },
          },
        },
      };
  return { ok: true, status: 200, json: async () => body };
};

beforeEach(() => {
  fetchMock.mockReset();
  mockGetBalance.mockReset();
  (globalThis as { fetch: unknown }).fetch = fetchMock;
  clearWalletBalanceCache();
  process.env.NEXT_PUBLIC_SUI_NETWORK = 'testnet';
  process.env.NEXT_PUBLIC_TESTNET_GRAPHQL_URL = GRAPHQL_URL;
  // Legacy aliases would conflict with the canonical value above (public-env.ts).
  delete process.env.TESTNET_GRAPHQL_URL;
  delete process.env.NEXT_PUBLIC_SUI_GRAPHQL_URL;
  delete process.env.SUI_GRAPHQL_URL;
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterAll(() => {
  (globalThis as { fetch: unknown }).fetch = realFetch;
});

describe('wallet balance helpers read Sui GraphQL first (NJA-2866)', () => {
  it('reads the SUI balance from GraphQL when every JSON-RPC endpoint refuses (NJA-2830)', async () => {
    fetchMock.mockImplementation(graphqlAnswering('1500000000'));
    mockGetBalance.mockRejectedValue(JSON_RPC_REFUSED);

    // Fails on this commit: refreshCoinBalance only calls
    // getPooledSuiClient().getBalance, so the helper rejects with the JSON-RPC
    // refusal and never asks GraphQL.
    await expect(refreshSuiBalance(OWNER, { forceRefresh: true })).resolves.toMatchObject({
      walletAddress: OWNER,
      network: 'testnet',
      coinType: SUI,
      symbol: 'SUI',
      totalBalance: '1500000000',
      source: 'chain',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe(GRAPHQL_URL);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST' });
    const sent = sentBody(0);
    expect(sent.query).toMatch(/totalBalance/);
    expect(sent.variables).toMatchObject({ owner: OWNER });
    if (isSingleBalanceQuery(sent.query)) {
      expect(sent.variables.coinType).toMatch(/^0x0*2::sui::SUI$/);
    }
  });

  it('an address that owns nothing reads as 0: a complete GraphQL answer, not a default', async () => {
    fetchMock.mockImplementation(graphqlAnswering('0'));
    mockGetBalance.mockRejectedValue(JSON_RPC_REFUSED);

    // Fails on this commit for the same reason: the JSON-RPC refusal is the answer.
    await expect(refreshSuiBalance(OWNER, { forceRefresh: true })).resolves.toMatchObject({
      totalBalance: '0',
      source: 'chain',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to JSON-RPC when GraphQL cannot be read', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    mockGetBalance.mockResolvedValue({ totalBalance: '42' });

    await expect(refreshSuiBalance(OWNER, { forceRefresh: true })).resolves.toMatchObject({
      totalBalance: '42',
      source: 'chain',
    });
    expect(mockGetBalance).toHaveBeenCalledWith(
      expect.objectContaining({ owner: OWNER, coinType: SUI }),
    );
  });

  const unreadableAnswers: Array<[string, FakeFetch]> = [
    ['a 503 status', answer({}, 503)],
    ['a GraphQL errors body', answer({ errors: [{ message: 'rate limited' }], data: null })],
    ['a null address', answer({ data: { address: null } })],
    ['no data at all', answer({})],
    [
      'a body that is not JSON',
      async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON');
        },
      }),
    ],
    ['a null totalBalance', graphqlAnswering(null)],
    ['a numeric totalBalance', graphqlAnswering(1500000000)],
    ['a non-decimal totalBalance', graphqlAnswering('1.5e9')],
  ];

  it.each(unreadableAnswers)(
    'refuses %s from GraphQL when JSON-RPC also refuses; it never reads as 0 and caches nothing',
    async (_label, respond) => {
      fetchMock.mockImplementation(respond);
      mockGetBalance.mockRejectedValue(JSON_RPC_REFUSED);

      await expect(refreshSuiBalance(OWNER, { forceRefresh: true })).rejects.toThrow();
      // A second read within the ttl must not find a cached balance either.
      await expect(refreshSuiBalance(OWNER)).rejects.toThrow();
    },
  );

  it('refuses a JSON-RPC answer without a readable balance on the fallback path too', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    mockGetBalance.mockResolvedValue({});

    // Fails on this commit: `totalBalance: balance.totalBalance` is taken as is,
    // so the helper resolves with totalBalance undefined and caches it as a fact.
    await expect(refreshSuiBalance(OWNER, { forceRefresh: true })).rejects.toThrow();
  });
});
