/**
 * NJA-3600 — src/lib/object-graphql.ts, the shared single-object reader that
 * the circle page asks before JSON-RPC. A read that fails is not a fact:
 * every answer that is not whole throws, and only `object: null` with no
 * `errors` is "gone". fetch is stubbed; nothing here reaches the network.
 */
jest.mock('../../services/network-config', () => ({
  getCurrentNetwork: () => 'testnet',
  getGraphqlUrlForNetwork: (network: string) => `https://graphql.${network}.sui.invalid/graphql`,
}));

import { moveJsonToRpcFields, readObjectViaGraphql } from '../../lib/object-graphql';

const CIRCLE_ID = `0x${'ab'.repeat(32)}`;
const ADMIN = `0x${'ef'.repeat(32)}`;
const TABLE_ID = `0x${'cd'.repeat(32)}`;
const CIRCLE_TYPE = `0x${'12'.repeat(32)}::njangi_circles::Circle`;
const CIRCLE_JSON = { id: CIRCLE_ID, admin: ADMIN, name: 'Family circle', members: { id: TABLE_ID, size: '3' } };

/** A readable `data` for the circle, with `json` swapped in when given. */
const readable = (json: unknown = CIRCLE_JSON) => ({
  object: { version: 42, asMoveObject: { contents: { type: { repr: CIRCLE_TYPE }, json } } },
});

const realFetch = (globalThis as { fetch?: unknown }).fetch;
let fetchStub: jest.Mock;

/** Queues one HTTP answer for the next fetch. */
function answer(body: unknown, status = 200): void {
  fetchStub.mockImplementationOnce(() =>
    Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) }),
  );
}

beforeEach(() => {
  fetchStub = jest.fn(() => Promise.reject(new Error('fetch is stubbed: no answer was queued')));
  (globalThis as { fetch?: unknown }).fetch = fetchStub;
});

afterAll(() => {
  (globalThis as { fetch?: unknown }).fetch = realFetch;
});

describe('readObjectViaGraphql (src/lib/object-graphql.ts)', () => {
  it('posts object(address: $id) { version asMoveObject { contents { type { repr } json } } } to the current network and returns version, type and json', async () => {
    answer({ data: readable() });

    await expect(readObjectViaGraphql(CIRCLE_ID)).resolves.toEqual({
      version: '42',
      type: CIRCLE_TYPE,
      json: CIRCLE_JSON,
    });

    expect(fetchStub).toHaveBeenCalledTimes(1);
    const [url, init] = fetchStub.mock.calls[0];
    expect(url).toBe('https://graphql.testnet.sui.invalid/graphql');
    expect(init.method).toBe('POST');
    const request = JSON.parse(init.body);
    expect(request.variables).toEqual({ id: CIRCLE_ID });
    expect(request.query).toMatch(
      /object\s*\(\s*address\s*:\s*\$id\s*\)\s*\{\s*version\s+asMoveObject\s*\{\s*contents\s*\{\s*type\s*\{\s*repr\s*\}\s*json\s*\}\s*\}\s*\}/,
    );
  });

  it('answers null only for object: null with no errors entry (a confirmed gone object)', async () => {
    answer({ data: { object: null } });
    await expect(readObjectViaGraphql(CIRCLE_ID)).resolves.toBeNull();

    answer({ data: { object: null }, errors: [] });
    await expect(readObjectViaGraphql(CIRCLE_ID)).resolves.toBeNull();
  });

  it('throws on an errors entry, even beside data', async () => {
    answer({ data: readable(), errors: [{ message: 'partial result' }] });
    await expect(readObjectViaGraphql(CIRCLE_ID)).rejects.toThrow(/returned errors.*partial result/);

    answer({ data: { object: null }, errors: [{ message: 'object lookup timed out' }] });
    await expect(readObjectViaGraphql(CIRCLE_ID)).rejects.toThrow(/returned errors/);
  });

  it('throws on a non-2xx status', async () => {
    answer({ data: readable() }, 503);
    await expect(readObjectViaGraphql(CIRCLE_ID)).rejects.toThrow(/answered 503/);
  });

  it('throws on a body that does not parse', async () => {
    fetchStub.mockImplementationOnce(() =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.reject(new SyntaxError('Unexpected token <')) }),
    );
    await expect(readObjectViaGraphql(CIRCLE_ID)).rejects.toThrow(/unreadable body/);
  });

  it('throws when the request fails or is aborted', async () => {
    fetchStub.mockImplementationOnce(() => Promise.reject(new Error('The operation was aborted')));
    await expect(readObjectViaGraphql(CIRCLE_ID)).rejects.toThrow(/did not answer/);
  });

  it.each<[string, unknown]>([
    ['a body without data', {}],
    ['data: null', { data: null }],
    ['data without an object field', { data: {} }],
    ['an object that is not a Move object', { data: { object: { version: 42, asMoveObject: null } } }],
    ['contents without json', { data: { object: { version: 42, asMoveObject: { contents: { type: { repr: CIRCLE_TYPE } } } } } }],
    ['json that is not an object', { data: readable('not an object') }],
    ['a type without a string repr', { data: { object: { version: 42, asMoveObject: { contents: { type: {}, json: CIRCLE_JSON } } } } }],
    ['an unreadable version', { data: { object: { ...readable().object, version: 'latest' } } }],
  ])('throws on %s', async (_what, body) => {
    answer(body);
    await expect(readObjectViaGraphql(CIRCLE_ID)).rejects.toThrow(/\[object-graphql\]/);
  });
});

describe('moveJsonToRpcFields', () => {
  it('gives the JSON-RPC content.fields shape: a UID as { id }, a nested struct under fields, the rest as it is', () => {
    const fields = moveJsonToRpcFields({
      ...CIRCLE_JSON,
      next_payout_time: '1700000000000',
      is_active: true,
      payout_order: [ADMIN],
      pending_swap: null,
      goal: { target: '500', reached: false },
    });

    expect(fields).toEqual({
      id: { id: CIRCLE_ID },
      admin: ADMIN,
      name: 'Family circle',
      members: { fields: { id: { id: TABLE_ID }, size: '3' } },
      next_payout_time: '1700000000000',
      is_active: true,
      payout_order: [ADMIN],
      pending_swap: null,
      goal: { fields: { target: '500', reached: false } },
    });
    expect((fields.members as { fields: { id: { id: string } } }).fields.id.id).toBe(TABLE_ID);
  });
});
