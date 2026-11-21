/**
 * NJA-3571: getCircleConfigFields is a failed read (a rejection), never null
 * ("no config"), when no transport lists a circle's dynamic fields
 * completely, and the JSON-RPC fallback asks for the first page by parentId
 * alone. fetch is stubbed: nothing here reaches the network.
 */

const mockGraphqlUrlForNetwork = jest.fn();

jest.mock('@/services/network-config', () => ({
  getCurrentNetwork: () => 'testnet',
  getGraphqlUrlForNetwork: (network: string) => mockGraphqlUrlForNetwork(network),
}));

import { getCircleConfigFields } from '../../lib/circle-config';
import { readDynamicFieldsViaJsonRpc } from '../../lib/dynamic-fields-graphql';

const GRAPHQL_URL = 'https://graphql.testnet.sui.io/graphql';
const CIRCLE_ID = '0x' + 'd'.repeat(64);

const otherField = {
  objectId: '0x' + 'ab'.repeat(32),
  objectType: '0x2::table::Table<address, u64>',
  type: 'DynamicField',
  name: { type: '0x1::string::String', value: 'members' },
};
const configField = {
  objectId: '0x' + 'cf'.repeat(32),
  objectType: '0x1::njangi_circles::CircleConfig',
  type: 'DynamicField',
  name: { type: '0x1::string::String', value: 'circle_config' },
};

const fetchMock = jest.fn();
const globalWithFetch = globalThis as unknown as { fetch: unknown };
const originalFetch = globalWithFetch.fetch;

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(() => Promise.reject(new Error('GraphQL is unreachable')));
  globalWithFetch.fetch = fetchMock;
  mockGraphqlUrlForNetwork.mockReset();
  mockGraphqlUrlForNetwork.mockReturnValue(GRAPHQL_URL);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(() => {
  globalWithFetch.fetch = originalFetch;
});

describe('getCircleConfigFields never reads a failed or partial dynamic-field list as "no config"', () => {
  it('rejects when Sui GraphQL fails and every JSON-RPC endpoint refuses (NJA-2830)', async () => {
    const getDynamicFields = jest.fn().mockRejectedValue(new Error('Unexpected status code: 405'));
    const getObject = jest.fn();
    const client = { getDynamicFields, getObject } as unknown as Parameters<typeof getCircleConfigFields>[0];

    await expect(getCircleConfigFields(client, CIRCLE_ID)).rejects.toThrow('Unexpected status code: 405');
    expect(fetchMock.mock.calls[0][0]).toBe(GRAPHQL_URL);
    expect(getObject).not.toHaveBeenCalled();
  });

  it('rejects, never resolves null, when JSON-RPC reports more fields without a cursor to read them', async () => {
    mockGraphqlUrlForNetwork.mockReturnValue('');
    const getDynamicFields = jest.fn().mockResolvedValue({ data: [otherField], hasNextPage: true, nextCursor: null });
    const getObject = jest.fn();
    const client = { getDynamicFields, getObject } as unknown as Parameters<typeof getCircleConfigFields>[0];

    await expect(getCircleConfigFields(client, CIRCLE_ID)).rejects.toThrow('without a cursor');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getObject).not.toHaveBeenCalled();
  });
});

describe('readDynamicFieldsViaJsonRpc', () => {
  it('asks for the first page by parentId alone and sends a cursor only when following nextCursor', async () => {
    const getDynamicFields = jest.fn(async (args: { parentId: string; cursor?: string | null }) =>
      args.cursor === 'page-2'
        ? { data: [configField], hasNextPage: false, nextCursor: null }
        : { data: [otherField], hasNextPage: true, nextCursor: 'page-2' },
    );
    const client = { getDynamicFields } as unknown as Parameters<typeof readDynamicFieldsViaJsonRpc>[0];

    await expect(readDynamicFieldsViaJsonRpc(client, CIRCLE_ID)).resolves.toEqual([otherField, configField]);
    expect(getDynamicFields).toHaveBeenCalledTimes(2);
    expect(getDynamicFields.mock.calls[0][0]).toStrictEqual({ parentId: CIRCLE_ID });
    expect(getDynamicFields).toHaveBeenNthCalledWith(2, { parentId: CIRCLE_ID, cursor: 'page-2' });
  });
});
