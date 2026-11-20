/**
 * batchFetchCircleObjects (src/services/circle-service.ts) is the dashboard's
 * per-circle fallback when multiGetObjects fails (dashboard.tsx ~3870). On
 * this commit it reads every circle with JSON-RPC getObject only; since the
 * configured endpoints refuse JSON-RPC (NJA-2830), every circle comes back as
 * the `{}` error entry and the dashboard counts the whole batch unreadable.
 *
 * Expected: the circles are read first from Sui GraphQL
 * (multiGetObjects { address version asMoveObject { contents { type { repr } json } } })
 * and returned in the JSON-RPC getObject shape processCircleObject reads
 * (dashboard.tsx :2408-2535): data.objectId, data.version, data.type and
 * data.content { dataType: 'moveObject', type, fields }.
 *
 * Fails on this commit: no GraphQL read exists, so the entry is `{}` and
 * fetch is never called.
 */

jest.mock('@/services/network-config', () => ({
  getCurrentNetwork: () => 'testnet',
  getCurrentPackageId: () => '0xc5aed33e4da2530d0f9b36a64d96d662b109ba2962bb6918bc3fa21be1622465',
  getCurrentRpcUrl: () => 'https://primary.rpc.invalid',
  getCurrentGraphqlUrl: () => 'https://graphql.testnet.sui.io/graphql',
  getGraphqlUrlForNetwork: () => 'https://graphql.testnet.sui.io/graphql',
  getNetworkConfig: () => ({
    rpcUrl: 'https://primary.rpc.invalid',
    graphqlUrl: 'https://graphql.testnet.sui.io/graphql',
  }),
}));

jest.mock('@/services/sui-rpc-failover', () => ({
  getPooledSuiClient: jest.fn(),
  withSuiRpcFailover: jest.fn(),
}));

jest.mock('@/lib/sui-read', () => ({
  readObject: jest.fn(),
  queryEventsCached: jest.fn(),
  IMMUTABLE_READ_TTL_MS: 0,
}));

jest.mock('@/lib/circle-chain', () => ({
  extractPackageIdFromMoveType: jest.fn(),
  getPackageLookupIds: jest.fn(() => []),
  normalizePackageId: (value: string | null | undefined) => value?.toLowerCase() ?? null,
  resolveUpgradeAwarePackageId: jest.fn(
    ({ objectPackageId, currentPackageId }: { objectPackageId?: string; currentPackageId: string }) =>
      objectPackageId ?? currentPackageId,
  ),
}));

import { batchFetchCircleObjects } from '../../services/circle-service';

const GRAPHQL_URL = 'https://graphql.testnet.sui.io/graphql';
const PKG = '0x89cddf4dfe654e7c7b16333096d9e750cf04bb96f7de934403a512d460594f02';
const CIRCLE = '0x' + 'c1'.repeat(32);
const ADMIN = '0x' + 'ad'.repeat(32);
const CIRCLE_TYPE = `${PKG}::njangi_circles::Circle`;

/** `contents.json` as GraphQL renders a Circle: u64s and addresses as strings. */
const CIRCLE_FIELDS = {
  id: { id: CIRCLE },
  name: 'Family Circle',
  admin: ADMIN,
  current_members: '3',
  next_payout_time: '1788072287141',
  contribution_amount: '1000000000',
  security_deposit: '2000000000',
  contribution_amount_local: '1500',
  security_deposit_local: '3000',
  cycle_length: '1',
  cycle_day: '2',
  max_members: '5',
};

/** The live multiGetObjects answer shape (verified 2026-11-15 against testnet GraphQL). */
const graphqlBody = {
  data: {
    multiGetObjects: [
      {
        address: CIRCLE,
        version: 42,
        asMoveObject: { contents: { type: { repr: CIRCLE_TYPE }, json: CIRCLE_FIELDS } },
      },
    ],
  },
};

const fetchMock = jest.fn();
const globalWithFetch = globalThis as unknown as { fetch: unknown };
const originalFetch = globalWithFetch.fetch;

/** Every configured JSON-RPC endpoint refuses JSON-RPC (NJA-2830). */
const retiredJsonRpcClient = () =>
  ({
    getObject: jest.fn().mockRejectedValue(new Error('Unexpected status code: 405')),
  }) as unknown as Parameters<typeof batchFetchCircleObjects>[1];

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => graphqlBody });
  globalWithFetch.fetch = fetchMock;
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterAll(() => {
  globalWithFetch.fetch = originalFetch;
});

describe('batchFetchCircleObjects over Sui GraphQL', () => {
  it('returns each circle in the JSON-RPC getObject shape processCircleObject reads when JSON-RPC is retired', async () => {
    const client = retiredJsonRpcClient();

    // The JSON-RPC retry backoff is one real 500ms wait; well inside the timeout.
    const result = await batchFetchCircleObjects([CIRCLE], client, { maxConcurrent: 1 });

    const entry = result.get(CIRCLE);
    // On this commit: `{}` after two failed getObject attempts; no GraphQL read exists.
    expect(entry).toMatchObject({
      data: {
        objectId: CIRCLE,
        type: CIRCLE_TYPE,
        content: {
          dataType: 'moveObject',
          type: CIRCLE_TYPE,
          fields: {
            name: 'Family Circle',
            admin: ADMIN,
            current_members: '3',
            next_payout_time: '1788072287141',
            contribution_amount: '1000000000',
            security_deposit: '2000000000',
            contribution_amount_local: '1500',
            security_deposit_local: '3000',
            cycle_length: '1',
            cycle_day: '2',
            max_members: '5',
          },
        },
      },
    });

    const data = (entry as { data: { version: unknown; type: string } }).data;
    // processCircleObject takes the package id from data.type with this pattern (dashboard.tsx :2522).
    expect(data.type.match(/^(0x[a-fA-F0-9]+)::/)?.[1]).toBe(PKG);
    // JSON-RPC renders version as a string, GraphQL as a number; either must say 42.
    expect(String(data.version)).toBe('42');

    // The read went to the GraphQL service of the configured network.
    expect(fetchMock).toHaveBeenCalledWith(GRAPHQL_URL, expect.objectContaining({ method: 'POST' }));
  }, 15_000);
});
