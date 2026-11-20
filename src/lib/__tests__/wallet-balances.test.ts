/**
 * NJA-2840 — readWalletBalancesViaGraphql, the dashboard's GraphQL balance read.
 *
 * fetch and the network config are mocked, so no network is touched. A read
 * that fails, is malformed or stops short must throw (the dashboard then falls
 * back to JSON-RPC, and past that shows the balance as unavailable); it must
 * never come back as fewer coins or as a zero balance.
 */
import { readWalletBalancesViaGraphql, WALLET_BALANCES_MAX_PAGES } from '../wallet-balances';

jest.mock('../../services/network-config', () => ({
  getGraphqlUrlForNetwork: jest.fn(() => 'https://graphql.testnet.invalid/graphql'),
}));

const GRAPHQL_URL = 'https://graphql.testnet.invalid/graphql';
const OWNER = `0x${'a1'.repeat(32)}`;
const SUI = '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';
const USDC = '0x26b3bc67befc214058ca78ea9a2690298d731a2d4309485ec3d40198063c4abc::usdc::USDC';

interface FakeResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

const answer = (body: unknown, status = 200): FakeResponse => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const balancesPage = (nodes: unknown[], pageInfo: unknown = { hasNextPage: false, endCursor: null }) => ({
  data: { address: { balances: { pageInfo, nodes } } },
});

const fetchMock = jest.fn();
const realFetch = globalThis.fetch;

/** The JSON body of the `call`-th request. */
const sentBody = (call: number) => JSON.parse(fetchMock.mock.calls[call][1].body);

beforeEach(() => {
  fetchMock.mockReset();
  (globalThis as { fetch: unknown }).fetch = fetchMock;
});

afterAll(() => {
  (globalThis as { fetch: unknown }).fetch = realFetch;
});

describe('readWalletBalancesViaGraphql (NJA-2840)', () => {
  it('returns every balance GraphQL reports, posting the owner to the network GraphQL URL', async () => {
    fetchMock.mockResolvedValueOnce(
      answer(
        balancesPage([
          { coinType: { repr: SUI }, totalBalance: '1500000000' },
          { coinType: { repr: USDC }, totalBalance: '25000000' },
        ]),
      ),
    );

    await expect(readWalletBalancesViaGraphql('testnet', OWNER)).resolves.toEqual([
      { coinType: SUI, totalBalance: '1500000000' },
      { coinType: USDC, totalBalance: '25000000' },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(GRAPHQL_URL);
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
    expect(sentBody(0).variables).toEqual({ owner: OWNER, after: null });
    expect(sentBody(0).query).toMatch(/balances\(first: 50, after: \$after\)/);
    expect(sentBody(0).query).toMatch(/coinType \{ repr \} totalBalance/);
  });

  it('returns an empty list only when GraphQL answers completely that the address holds no coins', async () => {
    fetchMock.mockResolvedValueOnce(answer(balancesPage([])));

    await expect(readWalletBalancesViaGraphql('testnet', OWNER)).resolves.toEqual([]);
  });

  it('follows endCursor until the last page and returns every page', async () => {
    fetchMock
      .mockResolvedValueOnce(
        answer(
          balancesPage([{ coinType: { repr: SUI }, totalBalance: '1500000000' }], {
            hasNextPage: true,
            endCursor: 'cursor-1',
          }),
        ),
      )
      .mockResolvedValueOnce(answer(balancesPage([{ coinType: { repr: USDC }, totalBalance: '25000000' }])));

    await expect(readWalletBalancesViaGraphql('testnet', OWNER)).resolves.toEqual([
      { coinType: SUI, totalBalance: '1500000000' },
      { coinType: USDC, totalBalance: '25000000' },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sentBody(1).variables).toEqual({ owner: OWNER, after: 'cursor-1' });
  });

  it('throws when the request itself fails', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    await expect(readWalletBalancesViaGraphql('testnet', OWNER)).rejects.toThrow('Failed to fetch');
  });

  const brokenAnswers: Array<[string, () => FakeResponse]> = [
    ['a non-2xx status', () => answer({}, 503)],
    [
      'a GraphQL errors body, even alongside data',
      () =>
        answer({
          errors: [{ message: 'rate limited' }],
          ...balancesPage([{ coinType: { repr: SUI }, totalBalance: '1500000000' }]),
        }),
    ],
    [
      'a body that is not JSON',
      () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON');
        },
      }),
    ],
    ['a null address', () => answer({ data: { address: null } })],
    ['no data at all', () => answer({ data: null })],
    ['no balances list', () => answer({ data: { address: { balances: null } } })],
    ['nodes that are not a list', () => answer({ data: { address: { balances: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: {} } } } })],
    ['missing page info', () => answer({ data: { address: { balances: { nodes: [] } } } })],
    ['more pages announced without a cursor', () => answer(balancesPage([], { hasNextPage: true, endCursor: null }))],
  ];

  it.each(brokenAnswers)('throws on %s', async (_label, respond) => {
    fetchMock.mockResolvedValueOnce(respond());

    await expect(readWalletBalancesViaGraphql('testnet', OWNER)).rejects.toThrow();
  });

  const malformedNodes: Array<[string, unknown]> = [
    ['a missing coinType', { totalBalance: '5' }],
    ['a null coinType.repr', { coinType: { repr: null }, totalBalance: '5' }],
    ['an empty coinType.repr', { coinType: { repr: '' }, totalBalance: '5' }],
    ['a missing totalBalance', { coinType: { repr: USDC } }],
    ['a numeric totalBalance', { coinType: { repr: USDC }, totalBalance: 5 }],
    ['a fractional totalBalance', { coinType: { repr: USDC }, totalBalance: '5.5' }],
    ['a negative totalBalance', { coinType: { repr: USDC }, totalBalance: '-5' }],
    ['an empty totalBalance', { coinType: { repr: USDC }, totalBalance: '' }],
    ['a null node', null],
  ];

  it.each(malformedNodes)('fails the whole read on %s instead of dropping the node or reading 0', async (_label, bad) => {
    fetchMock.mockResolvedValueOnce(
      answer(balancesPage([{ coinType: { repr: SUI }, totalBalance: '1500000000' }, bad])),
    );

    await expect(readWalletBalancesViaGraphql('testnet', OWNER)).rejects.toThrow();
  });

  it('throws rather than return a partial list when paging never ends', async () => {
    fetchMock.mockImplementation(async () =>
      answer(
        balancesPage([{ coinType: { repr: SUI }, totalBalance: '1' }], { hasNextPage: true, endCursor: 'next' }),
      ),
    );

    await expect(readWalletBalancesViaGraphql('testnet', OWNER)).rejects.toThrow(/partial/);
    expect(fetchMock).toHaveBeenCalledTimes(WALLET_BALANCES_MAX_PAGES);
  });
});
