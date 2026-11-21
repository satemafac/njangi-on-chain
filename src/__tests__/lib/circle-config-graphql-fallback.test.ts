/**
 * The Sui GraphQL step of getCircleConfigFieldsByObjectId
 * (src/lib/circle-config.ts) counts every answer that is not a fact as a
 * failed read: an error status, an `errors` body (even beside data), a null
 * object, a missing or non-object contents.json or value. Such a read falls
 * through to getObject and never yields a partial or default record; with
 * getObject failing too the read still throws. An empty `errors` array is no
 * error. The read asks the GraphQL service of the requested network, the
 * current one by default, and skips GraphQL when that network has none.
 */

const mockGraphqlUrlForNetwork = jest.fn();

jest.mock('@/services/network-config', () => ({
  getCurrentNetwork: () => 'testnet',
  getGraphqlUrlForNetwork: (network: string) => mockGraphqlUrlForNetwork(network),
}));

import { getCircleConfigFields, getCircleConfigFieldsByObjectId } from '../../lib/circle-config';

const GRAPHQL_URLS: Record<string, string> = {
  testnet: 'https://graphql.testnet.sui.io/graphql',
  mainnet: 'https://graphql.mainnet.sui.io/graphql',
};
const CONFIG_FIELD_ID = '0x' + 'cf'.repeat(32);
const FIELD_NAME = 'Y2lyY2xlX2NvbmZpZw==';

/** `value` as GraphQL renders it: u64 strings, a numeric recovery_state, a null Option. */
const GRAPHQL_VALUE = {
  contribution_amount: '1000000000',
  max_members: '5',
  recovery_state: 2,
  next_in_command: null,
};
const readableJson = { id: CONFIG_FIELD_ID, name: FIELD_NAME, value: GRAPHQL_VALUE };

const graphqlObject = (json: unknown) => ({
  address: CONFIG_FIELD_ID,
  asMoveObject: { contents: { json } },
});

/** The same field object as getObject returns it, with other values so the source shows. */
const JSON_RPC_VALUE = { contribution_amount: '7000000000', max_members: '9' };
const jsonRpcResponse = {
  data: {
    content: {
      dataType: 'moveObject',
      fields: { id: { id: CONFIG_FIELD_ID }, value: { fields: JSON_RPC_VALUE } },
    },
  },
};
/** What extractCircleConfigFieldsFromObjectContent makes of jsonRpcResponse. */
const JSON_RPC_RECORD = {
  id: { id: CONFIG_FIELD_ID },
  value: { fields: JSON_RPC_VALUE },
  ...JSON_RPC_VALUE,
};

const okResponse = (body: unknown) => ({
  ok: true,
  status: 200,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

const fetchMock = jest.fn();
const globalWithFetch = globalThis as unknown as { fetch: unknown };
const originalFetch = globalWithFetch.fetch;

const makeClient = (getObject: jest.Mock) =>
  ({
    getObject,
    // A complete JSON-RPC page, as the endpoint returns it: getCircleConfigFields now reads every page and refuses
    // a page that does not say whether more follow (it could be partial).
    getDynamicFields: jest.fn().mockResolvedValue({
      data: [{ objectId: CONFIG_FIELD_ID, objectType: '0x1::njangi_circle_config::CircleConfig' }],
      hasNextPage: false,
      nextCursor: null,
    }),
  }) as unknown as Parameters<typeof getCircleConfigFields>[0];

const retiredJsonRpc = () => jest.fn().mockRejectedValue(new Error('Unexpected status code: 405'));

beforeEach(() => {
  fetchMock.mockReset();
  globalWithFetch.fetch = fetchMock;
  mockGraphqlUrlForNetwork.mockReset();
  mockGraphqlUrlForNetwork.mockImplementation((network: string) => GRAPHQL_URLS[network]);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterAll(() => {
  globalWithFetch.fetch = originalFetch;
});

describe('getCircleConfigFieldsByObjectId: a GraphQL answer that is not a fact', () => {
  it.each([
    [
      'an errors array beside a full object',
      okResponse({ errors: [{ message: 'boom' }], data: { object: graphqlObject(readableJson) } }),
    ],
    [
      'an errors value that is not an array',
      okResponse({ errors: { message: 'boom' }, data: { object: graphqlObject(readableJson) } }),
    ],
    ['a null object', okResponse({ data: { object: null } })],
    ['no data', okResponse({ data: null })],
    [
      'no contents.json',
      okResponse({ data: { object: { address: CONFIG_FIELD_ID, asMoveObject: { contents: {} } } } }),
    ],
    ['a contents.json that is not an object', okResponse({ data: { object: graphqlObject([readableJson]) } })],
    [
      'a json without value',
      okResponse({ data: { object: graphqlObject({ id: CONFIG_FIELD_ID, name: FIELD_NAME }) } }),
    ],
    [
      'a value that is not an object',
      okResponse({ data: { object: graphqlObject({ ...readableJson, value: '5' }) } }),
    ],
    [
      'an error status',
      {
        ok: false,
        status: 503,
        json: async () => ({ data: { object: graphqlObject(readableJson) } }),
        text: async () => '',
      },
    ],
  ])('falls back to getObject on %s and never returns the GraphQL record', async (_case, response) => {
    fetchMock.mockResolvedValue(response);
    const getObject = jest.fn().mockResolvedValue(jsonRpcResponse);

    await expect(getCircleConfigFieldsByObjectId(makeClient(getObject), CONFIG_FIELD_ID)).resolves.toEqual(
      JSON_RPC_RECORD,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getObject).toHaveBeenCalledWith({ id: CONFIG_FIELD_ID, options: { showContent: true } });
  });

  it('still throws when the GraphQL answer has errors and getObject fails too (never a partial record)', async () => {
    fetchMock.mockResolvedValue(
      okResponse({ errors: [{ message: 'boom' }], data: { object: graphqlObject(readableJson) } }),
    );

    await expect(
      getCircleConfigFieldsByObjectId(makeClient(retiredJsonRpc()), CONFIG_FIELD_ID),
    ).rejects.toThrow('Unexpected status code: 405');
  });

  it('takes an empty errors array as no error and keeps every value as GraphQL renders it', async () => {
    fetchMock.mockResolvedValue(okResponse({ errors: [], data: { object: graphqlObject(readableJson) } }));
    const getObject = jest.fn().mockResolvedValue(jsonRpcResponse);

    await expect(getCircleConfigFieldsByObjectId(makeClient(getObject), CONFIG_FIELD_ID)).resolves.toEqual({
      ...readableJson,
      ...GRAPHQL_VALUE,
    });
    expect(getObject).not.toHaveBeenCalled();
  });
});

describe('which Sui GraphQL service a CircleConfig read asks', () => {
  it('asks the GraphQL service of the current network by default', async () => {
    fetchMock.mockResolvedValue(okResponse({ data: { object: graphqlObject(readableJson) } }));

    await expect(
      getCircleConfigFieldsByObjectId(makeClient(retiredJsonRpc()), CONFIG_FIELD_ID),
    ).resolves.toMatchObject(GRAPHQL_VALUE);
    expect(mockGraphqlUrlForNetwork).toHaveBeenCalledWith('testnet');
    expect(fetchMock).toHaveBeenCalledWith(GRAPHQL_URLS.testnet, expect.objectContaining({ method: 'POST' }));
  });

  it("asks the requested network's GraphQL service through getCircleConfigFields", async () => {
    fetchMock.mockResolvedValue(okResponse({ data: { object: graphqlObject(readableJson) } }));

    await expect(
      getCircleConfigFields(makeClient(retiredJsonRpc()), '0xcircle', { network: 'mainnet' }),
    ).resolves.toMatchObject(GRAPHQL_VALUE);
    expect(mockGraphqlUrlForNetwork).toHaveBeenCalledWith('mainnet');
    expect(fetchMock).toHaveBeenCalledWith(GRAPHQL_URLS.mainnet, expect.objectContaining({ method: 'POST' }));
    // getCircleConfigFields now lists the circle's dynamic fields over GraphQL first (circles step 4b part 2), so
    // the config read is not the first request any more; one of the requests reads the config object. Changed
    // with the founder's OK (2026-11-21).
    const bodies = fetchMock.mock.calls.map((call) => String((call as [string, { body?: unknown }])[1]?.body));
    expect(bodies.some((body) => body.includes(CONFIG_FIELD_ID))).toBe(true);
  });

  it('reads with getObject only, and never fetches, when the network has no GraphQL URL', async () => {
    mockGraphqlUrlForNetwork.mockReturnValue('');
    const getObject = jest.fn().mockResolvedValue(jsonRpcResponse);

    await expect(getCircleConfigFieldsByObjectId(makeClient(getObject), CONFIG_FIELD_ID)).resolves.toEqual(
      JSON_RPC_RECORD,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
