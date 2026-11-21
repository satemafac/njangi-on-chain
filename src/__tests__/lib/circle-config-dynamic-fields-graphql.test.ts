/**
 * NJA-3571: getCircleConfigFields (src/lib/circle-config.ts) must list a
 * circle's dynamic fields through the part-1 helper
 * (src/lib/dynamic-fields-graphql.ts): Sui GraphQL first, JSON-RPC
 * getDynamicFields across every page as the fallback. On this commit it reads
 * one raw JSON-RPC page only, so when every JSON-RPC endpoint refuses
 * (NJA-2830) the config is lost although GraphQL answers, and a config past
 * the first page reads as "no config" from a partial list.
 * fetch is stubbed: nothing here reaches the network.
 */

const mockGraphqlUrlForNetwork = jest.fn();

jest.mock('@/services/network-config', () => ({
  getCurrentNetwork: () => 'testnet',
  getGraphqlUrlForNetwork: (network: string) => mockGraphqlUrlForNetwork(network),
}));

import { getCircleConfigFields } from '../../lib/circle-config';

const GRAPHQL_URL = 'https://graphql.testnet.sui.io/graphql';
const CIRCLE_ID = '0x' + 'd'.repeat(64);
const CONFIG_FIELD_ID = '0x' + 'cf'.repeat(32);
const OTHER_FIELD_ID = '0x' + 'ab'.repeat(32);
const CONFIG_TYPE = '0x1::njangi_circles::CircleConfig';
const TABLE_TYPE = '0x2::table::Table<address, u64>';

/** The CircleConfig as GraphQL renders it: u64 strings, numeric enum, null Option. */
const GRAPHQL_VALUE = {
  contribution_amount: '1000000000',
  max_members: '5',
  recovery_state: 2,
  next_in_command: null,
};
/** The same object as getObject returns it, with other values so the source shows. */
const JSON_RPC_VALUE = { contribution_amount: '7000000000', max_members: '9' };

const okResponse = (body: unknown) => ({
  ok: true,
  status: 200,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

/** One complete page of address(...).dynamicFields with the CircleConfig as its second field. */
const dynamicFieldsBody = {
  data: {
    address: {
      dynamicFields: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [
          {
            address: OTHER_FIELD_ID,
            name: { type: { repr: '0x1::string::String' }, json: 'members' },
            value: { __typename: 'MoveValue', type: { repr: TABLE_TYPE } },
          },
          {
            address: CONFIG_FIELD_ID,
            name: { type: { repr: '0x1::string::String' }, json: 'circle_config' },
            value: { __typename: 'MoveValue', type: { repr: CONFIG_TYPE } },
          },
        ],
      },
    },
  },
};

/** The CircleConfig field object as object(address: ...) { asMoveObject { contents { json } } } returns it. */
const configObjectBody = {
  data: {
    object: {
      address: CONFIG_FIELD_ID,
      asMoveObject: {
        contents: { json: { id: CONFIG_FIELD_ID, name: 'circle_config', value: GRAPHQL_VALUE } },
      },
    },
  },
};

const fetchMock = jest.fn();
const globalWithFetch = globalThis as unknown as { fetch: unknown };
const originalFetch = globalWithFetch.fetch;

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(() =>
    Promise.reject(new Error('fetch is stubbed: no answer was queued for this call')),
  );
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

describe('getCircleConfigFields lists the dynamic fields over Sui GraphQL first, JSON-RPC every page second', () => {
  it('finds and reads the CircleConfig when every JSON-RPC endpoint refuses and GraphQL answers', async () => {
    fetchMock.mockImplementation(async (_url: string, init: { body: string }) => {
      const { query } = JSON.parse(init.body) as { query: string };
      if (query.includes('dynamicFields(')) return okResponse(dynamicFieldsBody);
      if (query.includes('object(address:')) return okResponse(configObjectBody);
      throw new Error(`unexpected GraphQL query: ${query}`);
    });
    // NJA-2830: every configured JSON-RPC endpoint refuses JSON-RPC.
    const getDynamicFields = jest.fn().mockRejectedValue(new Error('Unexpected status code: 405'));
    const getObject = jest.fn().mockRejectedValue(new Error('Unexpected status code: 405'));
    const client = { getDynamicFields, getObject } as unknown as Parameters<typeof getCircleConfigFields>[0];

    await expect(getCircleConfigFields(client, CIRCLE_ID)).resolves.toMatchObject(GRAPHQL_VALUE);
    expect(fetchMock.mock.calls[0][0]).toBe(GRAPHQL_URL);
    expect(getObject).not.toHaveBeenCalled();
  });

  it('reads every JSON-RPC page when the network has no GraphQL URL, so a config past page one is found, never "no config"', async () => {
    mockGraphqlUrlForNetwork.mockReturnValue('');
    const getDynamicFields = jest.fn(async (args: { parentId: string; cursor?: string | null }) =>
      args.cursor === 'page-2'
        ? {
            data: [
              {
                objectId: CONFIG_FIELD_ID,
                objectType: CONFIG_TYPE,
                type: 'DynamicField',
                name: { type: '0x1::string::String', value: 'circle_config' },
              },
            ],
            hasNextPage: false,
            nextCursor: null,
          }
        : {
            data: [
              {
                objectId: OTHER_FIELD_ID,
                objectType: TABLE_TYPE,
                type: 'DynamicField',
                name: { type: '0x1::string::String', value: 'members' },
              },
            ],
            hasNextPage: true,
            nextCursor: 'page-2',
          },
    );
    const getObject = jest.fn().mockResolvedValue({
      data: {
        content: {
          dataType: 'moveObject',
          fields: { id: { id: CONFIG_FIELD_ID }, value: { fields: JSON_RPC_VALUE } },
        },
      },
    });
    const client = { getDynamicFields, getObject } as unknown as Parameters<typeof getCircleConfigFields>[0];

    await expect(getCircleConfigFields(client, CIRCLE_ID)).resolves.toMatchObject(JSON_RPC_VALUE);
    expect(getDynamicFields).toHaveBeenCalledTimes(2);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getObject).toHaveBeenCalledWith({ id: CONFIG_FIELD_ID, options: { showContent: true } });
  });
});
