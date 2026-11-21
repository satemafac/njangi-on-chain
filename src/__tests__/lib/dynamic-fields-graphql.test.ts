/**
 * src/lib/dynamic-fields-graphql.ts (NJA-3570): an object's dynamic-field list
 * read from Sui GraphQL across every page, or a throw; and the JSON-RPC
 * fallback, across every page, or a throw. A failed, malformed or partial read
 * never comes back as a shorter (or empty) list. fetch is stubbed: nothing here
 * reaches the network.
 */
import { getCircleConfigObjectId } from '../../lib/circle-config';
import {
  DYNAMIC_FIELDS_MAX_PAGES,
  readDynamicFieldsViaGraphql,
  readDynamicFieldsViaJsonRpc,
} from '../../lib/dynamic-fields-graphql';
import { getGraphqlUrlForNetwork, type NetworkType } from '../../services/network-config';

jest.mock('../../services/network-config', () => ({
  getCurrentNetwork: jest.fn(() => 'testnet'),
  getGraphqlUrlForNetwork: jest.fn(() => 'https://graphql.test/graphql'),
}));

const NETWORK: NetworkType = 'testnet';
const GRAPHQL_URL = 'https://graphql.test/graphql';
const PARENT = `0x${'1'.repeat(64)}`;
const FIELD_A = `0x${'a'.repeat(64)}`;
const FIELD_B = `0x${'b'.repeat(64)}`;
const CHILD = `0x${'c'.repeat(64)}`;
const PACKAGE = `0x${'d'.repeat(64)}`;
const CONFIG_TYPE = `${PACKAGE}::njangi_circles::CircleConfig`;
const COMPLETE = { hasNextPage: false, endCursor: null };

const graphqlUrlFor = getGraphqlUrlForNetwork as jest.MockedFunction<typeof getGraphqlUrlForNetwork>;
const realFetch = (globalThis as { fetch?: unknown }).fetch;
let fetchMock: jest.Mock;

beforeEach(() => {
  graphqlUrlFor.mockReturnValue(GRAPHQL_URL);
  fetchMock = jest.fn();
  fetchMock.mockImplementation(() => Promise.reject(new Error('fetch is stubbed: no answer was queued for this call')));
  (globalThis as { fetch?: unknown }).fetch = fetchMock;
});

afterAll(() => {
  (globalThis as { fetch?: unknown }).fetch = realFetch;
});

/** A Response-shaped answer to one GraphQL POST. */
function answer(body: unknown, status = 200): Promise<unknown> {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });
}

/** A GraphQL body with `nodes` as one page of `address.dynamicFields`. */
function connection(nodes: unknown[], pageInfo: unknown) {
  return { data: { address: { dynamicFields: { pageInfo, nodes } } } };
}

/** A dynamic field (not an object field) whose value has Move type `valueType`. */
function valueField(address: string, nameType: string, nameJson: unknown, valueType: string) {
  return {
    address,
    name: { type: { repr: nameType }, json: nameJson },
    value: { __typename: 'MoveValue', type: { repr: valueType } },
  };
}

/** The request body of the `call`-th GraphQL POST. */
function requestOf(call: number): { query: string; variables: unknown } {
  const init = fetchMock.mock.calls[call][1] as { body: string };
  return JSON.parse(init.body);
}

const CONFIG_FIELD = valueField(FIELD_A, '0x1::string::String', 'circle_config', CONFIG_TYPE);

describe('readDynamicFieldsViaGraphql', () => {
  it('lists the fields through address(...).dynamicFields and joins every page in order, following endCursor', async () => {
    const balanceType = '0x2::balance::Balance<0x2::sui::SUI>';
    fetchMock
      .mockReturnValueOnce(answer(connection([CONFIG_FIELD], { hasNextPage: true, endCursor: 'cursor-1' })))
      .mockReturnValueOnce(answer(connection([valueField(FIELD_B, 'u64', '7', balanceType)], COMPLETE)));

    await expect(readDynamicFieldsViaGraphql(NETWORK, PARENT)).resolves.toEqual([
      { objectId: FIELD_A, objectType: CONFIG_TYPE, type: 'DynamicField', name: { type: '0x1::string::String', value: 'circle_config' } },
      { objectId: FIELD_B, objectType: balanceType, type: 'DynamicField', name: { type: 'u64', value: '7' } },
    ]);
    expect(graphqlUrlFor).toHaveBeenCalledWith(NETWORK);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe(GRAPHQL_URL);
    expect(requestOf(0).variables).toEqual({ parent: PARENT, after: null });
    expect(requestOf(1).variables).toEqual({ parent: PARENT, after: 'cursor-1' });
    expect(requestOf(0).query).toMatch(/address\(address: \$parent\) \{ dynamicFields\(first: 50, after: \$after\)/);
  });

  it('decodes a vector<u8> name from base64, so the CircleConfig field is still found by its name', async () => {
    fetchMock.mockReturnValueOnce(
      answer(
        connection(
          [
            valueField(FIELD_A, 'vector<u8>', 'bWVtYmVy', '0x2::table::Table<address, u64>'),
            valueField(FIELD_B, 'vector<u8>', 'Y2lyY2xlX2NvbmZpZw==', `${PACKAGE}::njangi_circles::Settings`),
          ],
          COMPLETE,
        ),
      ),
    );

    const fields = await readDynamicFieldsViaGraphql(NETWORK, PARENT);
    expect(fields.map((field) => field.name)).toEqual([
      { type: 'vector<u8>', value: 'member' },
      { type: 'vector<u8>', value: 'circle_config' },
    ]);
    expect(getCircleConfigObjectId(fields)).toBe(FIELD_B);
  });

  it('keeps a vector<u8> name that is not UTF-8 as its byte list, as JSON-RPC shows it', async () => {
    fetchMock.mockReturnValueOnce(answer(connection([valueField(FIELD_A, 'vector<u8>', '//4=', CONFIG_TYPE)], COMPLETE)));

    const fields = await readDynamicFieldsViaGraphql(NETWORK, PARENT);
    expect(fields[0].name).toEqual({ type: 'vector<u8>', value: [255, 254] });
  });

  it('reads a dynamic object field as JSON-RPC lists it: the child object id and type', async () => {
    const walletType = `${PACKAGE}::circle_wallet::CircleWallet`;
    fetchMock.mockReturnValueOnce(
      answer(
        connection(
          [
            {
              address: FIELD_A,
              name: { type: { repr: '0x1::string::String' }, json: 'wallet' },
              value: { __typename: 'MoveObject', address: CHILD, contents: { type: { repr: walletType } } },
            },
          ],
          COMPLETE,
        ),
      ),
    );

    await expect(readDynamicFieldsViaGraphql(NETWORK, PARENT)).resolves.toEqual([
      { objectId: CHILD, objectType: walletType, type: 'DynamicObject', name: { type: '0x1::string::String', value: 'wallet' } },
    ]);
  });

  it('returns an empty list only when GraphQL answers, completely, that there are no fields', async () => {
    fetchMock.mockReturnValueOnce(answer(connection([], COMPLETE)));

    await expect(readDynamicFieldsViaGraphql(NETWORK, PARENT)).resolves.toEqual([]);
  });

  it.each<[string, () => Promise<unknown>]>([
    ['a non-2xx status', () => answer(connection([CONFIG_FIELD], COMPLETE), 503)],
    ['a body that is not an object', () => answer('upstream timed out')],
    ['an errors entry', () => answer({ errors: [{ message: 'Query is too complex' }], data: null })],
    ['an errors entry beside data', () => answer({ ...connection([CONFIG_FIELD], COMPLETE), errors: [{ message: 'partial' }] })],
    ['no address', () => answer({ data: { address: null } })],
    ['no dynamicFields connection', () => answer({ data: { address: {} } })],
    ['no nodes list', () => answer({ data: { address: { dynamicFields: { pageInfo: COMPLETE, nodes: null } } } })],
    ['no page info', () => answer({ data: { address: { dynamicFields: { nodes: [CONFIG_FIELD] } } } })],
    ['more pages without an endCursor', () => answer(connection([CONFIG_FIELD], { hasNextPage: true, endCursor: null }))],
    ['a node without an address', () => answer(connection([{ ...CONFIG_FIELD, address: null }], COMPLETE))],
    ['an unreadable node after a readable one', () => answer(connection([CONFIG_FIELD, { address: FIELD_B }], COMPLETE))],
    ['a node without a name type', () => answer(connection([{ ...CONFIG_FIELD, name: { json: 'circle_config' } }], COMPLETE))],
    ['a node without a name value', () => answer(connection([{ ...CONFIG_FIELD, name: { type: { repr: '0x1::string::String' } } }], COMPLETE))],
    ['a vector<u8> name that is not base64', () => answer(connection([valueField(FIELD_A, 'vector<u8>', 'not base64!', CONFIG_TYPE)], COMPLETE))],
    ['a node without a value', () => answer(connection([{ ...CONFIG_FIELD, value: null }], COMPLETE))],
    ['a value without a Move type', () => answer(connection([{ ...CONFIG_FIELD, value: { __typename: 'MoveValue' } }], COMPLETE))],
    [
      'an object field without its object id',
      () => answer(connection([{ ...CONFIG_FIELD, value: { __typename: 'MoveObject', contents: { type: { repr: CONFIG_TYPE } } } }], COMPLETE)),
    ],
    ['a fetch that rejects (the timeout aborting it, or no network)', () => Promise.reject(new Error('The operation was aborted'))],
  ])('throws on %s, never returning a shorter list', async (_label, respond) => {
    fetchMock.mockImplementationOnce(respond);

    await expect(readDynamicFieldsViaGraphql(NETWORK, PARENT)).rejects.toThrow();
  });

  it('throws when a later page fails, never returning the first page as the list', async () => {
    fetchMock
      .mockReturnValueOnce(answer(connection([CONFIG_FIELD], { hasNextPage: true, endCursor: 'cursor-1' })))
      .mockReturnValueOnce(answer({ errors: [{ message: 'rate limited' }], data: null }));

    await expect(readDynamicFieldsViaGraphql(NETWORK, PARENT)).rejects.toThrow('rate limited');
  });

  it(`throws past ${DYNAMIC_FIELDS_MAX_PAGES} pages rather than returning a partial list`, async () => {
    fetchMock.mockImplementation(() => answer(connection([CONFIG_FIELD], { hasNextPage: true, endCursor: 'more' })));

    await expect(readDynamicFieldsViaGraphql(NETWORK, PARENT)).rejects.toThrow(`more than ${DYNAMIC_FIELDS_MAX_PAGES} pages`);
    expect(fetchMock).toHaveBeenCalledTimes(DYNAMIC_FIELDS_MAX_PAGES);
  });

  it('throws when no GraphQL URL is configured, without fetching', async () => {
    graphqlUrlFor.mockReturnValueOnce('');

    await expect(readDynamicFieldsViaGraphql(NETWORK, PARENT)).rejects.toThrow('No Sui GraphQL URL');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('readDynamicFieldsViaJsonRpc', () => {
  const info = (objectId: string, name: string) => ({
    name: { type: '0x1::string::String', value: name },
    bcsName: name,
    objectId,
    objectType: CONFIG_TYPE,
    type: 'DynamicField',
    version: '7',
    digest: 'digest',
  });

  it('follows nextCursor to the last page and keeps every field as JSON-RPC lists it', async () => {
    const getDynamicFields = jest
      .fn()
      .mockResolvedValueOnce({ data: [info(FIELD_A, 'circle_config')], hasNextPage: true, nextCursor: 'cursor-1' })
      .mockResolvedValueOnce({ data: [info(FIELD_B, 'members')], hasNextPage: false, nextCursor: null });

    await expect(readDynamicFieldsViaJsonRpc({ getDynamicFields }, PARENT)).resolves.toEqual([
      info(FIELD_A, 'circle_config'),
      info(FIELD_B, 'members'),
    ]);
    expect(getDynamicFields.mock.calls).toEqual([
      [{ parentId: PARENT, cursor: null }],
      [{ parentId: PARENT, cursor: 'cursor-1' }],
    ]);
  });

  it('throws when a later page fails, never returning the first page as the list', async () => {
    const getDynamicFields = jest
      .fn()
      .mockResolvedValueOnce({ data: [info(FIELD_A, 'circle_config')], hasNextPage: true, nextCursor: 'cursor-1' })
      .mockRejectedValueOnce(new Error('every endpoint refused JSON-RPC'));

    await expect(readDynamicFieldsViaJsonRpc({ getDynamicFields }, PARENT)).rejects.toThrow('every endpoint refused JSON-RPC');
  });

  it('throws when more fields are reported without a cursor to read them', async () => {
    const getDynamicFields = jest
      .fn()
      .mockResolvedValueOnce({ data: [info(FIELD_A, 'circle_config')], hasNextPage: true, nextCursor: null });

    await expect(readDynamicFieldsViaJsonRpc({ getDynamicFields }, PARENT)).rejects.toThrow('without a cursor');
  });

  it('throws on a page without a data list', async () => {
    const getDynamicFields = jest.fn().mockResolvedValueOnce({ data: null, hasNextPage: false, nextCursor: null });

    await expect(readDynamicFieldsViaJsonRpc({ getDynamicFields }, PARENT)).rejects.toThrow('unreadable page');
  });

  it(`throws past ${DYNAMIC_FIELDS_MAX_PAGES} pages rather than returning a partial list`, async () => {
    const getDynamicFields = jest
      .fn()
      .mockResolvedValue({ data: [info(FIELD_A, 'circle_config')], hasNextPage: true, nextCursor: 'more' });

    await expect(readDynamicFieldsViaJsonRpc({ getDynamicFields }, PARENT)).rejects.toThrow(
      `more than ${DYNAMIC_FIELDS_MAX_PAGES} pages`,
    );
    expect(getDynamicFields).toHaveBeenCalledTimes(DYNAMIC_FIELDS_MAX_PAGES);
  });
});
