/**
 * batchFetchCircleObjects reads Sui GraphQL first. A circle GraphQL does not
 * return readably is read with getObject, and a circle neither source could
 * read keeps the `{}` error entry the dashboard counts as unreadable: never a
 * missing entry, never a default.
 */

jest.mock('@/services/network-config', () => ({
  getCurrentNetwork: () => 'testnet',
  getCurrentPackageId: () => '0xc5aed33e4da2530d0f9b36a64d96d662b109ba2962bb6918bc3fa21be1622465',
  getCurrentRpcUrl: () => 'https://primary.rpc.invalid',
  getGraphqlUrlForNetwork: () => 'https://graphql.testnet.sui.io/graphql',
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
const CIRCLE = '0x' + 'c2'.repeat(32);
const CIRCLE_TYPE = `0x${'89'.repeat(32)}::njangi_circles::Circle`;

/** A circle as JSON-RPC getObject returns it. */
const RPC_OBJECT = {
  data: {
    objectId: CIRCLE,
    version: '7',
    type: CIRCLE_TYPE,
    content: { dataType: 'moveObject', type: CIRCLE_TYPE, fields: { name: 'Savings Circle' } },
  },
};

const fetchMock = jest.fn();
const globalWithFetch = globalThis as unknown as { fetch: unknown };
const originalFetch = globalWithFetch.fetch;

const graphqlAnswer = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

const clientWith = (getObject: jest.Mock) =>
  ({ getObject }) as unknown as Parameters<typeof batchFetchCircleObjects>[1];

beforeEach(() => {
  fetchMock.mockReset();
  globalWithFetch.fetch = fetchMock;
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterAll(() => {
  globalWithFetch.fetch = originalFetch;
});

describe('batchFetchCircleObjects when Sui GraphQL cannot read a circle', () => {
  it('keeps the `{}` error entry when GraphQL answers with errors and getObject fails', async () => {
    fetchMock.mockResolvedValue(graphqlAnswer({ errors: [{ message: 'service unavailable' }] }));
    const getObject = jest.fn().mockRejectedValue(new Error('Unexpected status code: 405'));

    const result = await batchFetchCircleObjects([CIRCLE], clientWith(getObject), { maxConcurrent: 1 });

    expect(fetchMock).toHaveBeenCalledWith(GRAPHQL_URL, expect.objectContaining({ method: 'POST' }));
    expect(getObject).toHaveBeenCalledTimes(2);
    expect(result.has(CIRCLE)).toBe(true);
    expect(result.get(CIRCLE)).toEqual({});
  }, 15_000);

  it('reads a circle GraphQL returns as null with getObject', async () => {
    fetchMock.mockResolvedValue(graphqlAnswer({ data: { multiGetObjects: [null] } }));
    const getObject = jest.fn().mockResolvedValue(RPC_OBJECT);

    const result = await batchFetchCircleObjects([CIRCLE], clientWith(getObject), { maxConcurrent: 1 });

    expect(getObject).toHaveBeenCalledTimes(1);
    expect(result.get(CIRCLE)).toBe(RPC_OBJECT);
  });

  it('reads a circle whose GraphQL entry has no contents.json with getObject', async () => {
    fetchMock.mockResolvedValue(
      graphqlAnswer({
        data: {
          multiGetObjects: [
            { address: CIRCLE, version: 7, asMoveObject: { contents: { type: { repr: CIRCLE_TYPE }, json: null } } },
          ],
        },
      }),
    );
    const getObject = jest.fn().mockResolvedValue(RPC_OBJECT);

    const result = await batchFetchCircleObjects([CIRCLE], clientWith(getObject), { maxConcurrent: 1 });

    expect(getObject).toHaveBeenCalledTimes(1);
    expect(result.get(CIRCLE)).toBe(RPC_OBJECT);
  });
});
