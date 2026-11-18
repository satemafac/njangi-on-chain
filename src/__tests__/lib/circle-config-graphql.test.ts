/**
 * getCircleConfigFieldsByObjectId (src/lib/circle-config.ts) is how
 * processCircleObject (dashboard.tsx :2452-2461) and about ten other callers
 * read a circle's CircleConfig. On this commit it reads the config field
 * object with JSON-RPC getObject only (circle-config.ts :83-88); since every
 * configured endpoint refuses JSON-RPC (NJA-2830) the read rejects, the
 * dashboard throws 'CircleConfig ... could not be read' and the circle is
 * dropped from the screen.
 *
 * Expected (NJA-3125, step 1): the field object is read first from Sui
 * GraphQL ({ object(address) { asMoveObject { contents { json } } } }, whose
 * json is { id, name, value } with value the flat config record), merged as
 * extractCircleConfigFieldsFromObjectContent merges today (root keys plus
 * value's keys), with JSON-RPC getObject as the fallback. The result stays a
 * flat record whose keys include contribution_amount, contribution_amount_local,
 * security_deposit, security_deposit_local, cycle_length, cycle_day and
 * max_members. When both sources fail the read still throws, never [] or
 * default values.
 *
 * Fails on this commit: the promise rejects with the JSON-RPC error and
 * fetch is never called.
 */

jest.mock('@/services/network-config', () => ({
  getCurrentNetwork: () => 'testnet',
  getCurrentRpcUrl: () => 'https://primary.rpc.invalid',
  getCurrentGraphqlUrl: () => 'https://graphql.testnet.sui.io/graphql',
  getGraphqlUrlForNetwork: () => 'https://graphql.testnet.sui.io/graphql',
  getNetworkConfig: () => ({
    rpcUrl: 'https://primary.rpc.invalid',
    graphqlUrl: 'https://graphql.testnet.sui.io/graphql',
  }),
}));

import { getCircleConfigFieldsByObjectId } from '../../lib/circle-config';

const GRAPHQL_URL = 'https://graphql.testnet.sui.io/graphql';
const PKG = '0x89cddf4dfe654e7c7b16333096d9e750cf04bb96f7de934403a512d460594f02';
const CONFIG_FIELD_ID = '0x' + 'cf'.repeat(32);

/**
 * `value` as GraphQL renders the CircleConfig record (verified 2026-11-17
 * against testnet GraphQL): u64s as strings, bools as bools, recovery_state a
 * number, Options as null or the plain value.
 */
const CONFIG_VALUE = {
  contribution_amount: '1000000000',
  contribution_amount_local: '1500',
  security_deposit: '2000000000',
  security_deposit_local: '3000',
  cycle_length: '1',
  cycle_day: '2',
  max_members: '5',
  auto_swap_enabled: false,
  recovery_state: 0,
  next_in_command: null,
  recovery_proposal: null,
};

/** The live `object(address) { asMoveObject { contents { json } } }` answer shape. */
const graphqlBody = {
  data: {
    object: {
      address: CONFIG_FIELD_ID,
      asMoveObject: {
        contents: {
          type: {
            repr: `0x2::dynamic_field::Field<vector<u8>, ${PKG}::njangi_circle_config::CircleConfig>`,
          },
          json: {
            id: CONFIG_FIELD_ID,
            // vector<u8> name: base64 of the bytes 'circle_config'
            name: 'Y2lyY2xlX2NvbmZpZw==',
            value: CONFIG_VALUE,
          },
        },
      },
    },
  },
};

const fetchMock = jest.fn();
const globalWithFetch = globalThis as unknown as { fetch: unknown };
const originalFetch = globalWithFetch.fetch;

/** Every configured JSON-RPC endpoint refuses JSON-RPC (NJA-2830). */
const retiredJsonRpcClient = () =>
  ({
    getObject: jest.fn().mockRejectedValue(new Error('Unexpected status code: 405')),
  }) as unknown as Parameters<typeof getCircleConfigFieldsByObjectId>[0];

beforeEach(() => {
  fetchMock.mockReset();
  globalWithFetch.fetch = fetchMock;
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterAll(() => {
  globalWithFetch.fetch = originalFetch;
});

describe('getCircleConfigFieldsByObjectId over Sui GraphQL', () => {
  it('returns the flat CircleConfig record from GraphQL when every JSON-RPC endpoint is retired', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => graphqlBody,
      text: async () => JSON.stringify(graphqlBody),
    });
    const client = retiredJsonRpcClient();

    // On this commit: rejects with the getObject error; no GraphQL read exists.
    await expect(getCircleConfigFieldsByObjectId(client, CONFIG_FIELD_ID)).resolves.toMatchObject({
      // the dashboard reads these with ('key' in fields) and Number(...)
      contribution_amount: '1000000000',
      contribution_amount_local: '1500',
      security_deposit: '2000000000',
      security_deposit_local: '3000',
      cycle_length: '1',
      cycle_day: '2',
      max_members: '5',
      // root keys of the Field object are merged in, as today
      id: CONFIG_FIELD_ID,
    });

    // The read went to the GraphQL service of the configured network, for this field object.
    expect(fetchMock).toHaveBeenCalledWith(GRAPHQL_URL, expect.objectContaining({ method: 'POST' }));
    const firstCall = fetchMock.mock.calls[0] as [string, { body?: unknown }];
    expect(String(firstCall[1]?.body)).toContain(CONFIG_FIELD_ID);
  });

  it('still throws when GraphQL and JSON-RPC both fail (never [] or default values)', async () => {
    fetchMock.mockRejectedValue(new Error('fetch failed'));
    const client = retiredJsonRpcClient();

    // Unchanged failure contract (dashboard.tsx :2456-2461, :3931-3933): a read
    // that cannot be completed is an error, not an absent config.
    await expect(getCircleConfigFieldsByObjectId(client, CONFIG_FIELD_ID)).rejects.toThrow();
  });
});
