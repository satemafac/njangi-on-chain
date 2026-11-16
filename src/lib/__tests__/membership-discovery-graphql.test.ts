// NJA-2909 reproduction: isCurrentMemberOrAdmin must answer through Sui's
// GraphQL service when every JSON-RPC endpoint refuses JSON-RPC (NJA-2830),
// keeping its contract: true for the admin or a member, false only on a
// confirmed answer, null when nothing could be read. Today it reads JSON-RPC
// only, so a retired JSON-RPC client makes every receipt unverifiable (null)
// even though GraphQL answers. Fetch is stubbed: nothing here reaches the
// network.

jest.mock('@/services/network-config', () => ({
  getCurrentNetwork: () => 'testnet',
  getGraphqlUrlForNetwork: () => 'https://graphql.testnet.sui.io/graphql',
}));
jest.mock('@/services/sui-rpc-failover', () => ({
  getPooledSuiClient: () => ({
    getOwnedObjects: async () => {
      throw new Error('JSON-RPC retired');
    },
  }),
}));
jest.mock('@/lib/circle-chain', () => ({
  getPublishedPackageMetadata: () => ({
    originalId: '0x' + 'e5'.repeat(32),
    publishedAt: '0x' + 'e5'.repeat(32),
  }),
}));

import type { SuiClient } from '@mysten/sui/client';
import { isCurrentMemberOrAdmin } from '../membership-discovery';

const GRAPHQL_URL = 'https://graphql.testnet.sui.io/graphql';
const USER = `0x${'1a'.repeat(32)}`;
const ADMIN = `0x${'2b'.repeat(32)}`;
const CIRCLE = `0x${'3c'.repeat(32)}`;
const TABLE = `0x${'4d'.repeat(32)}`;
const PKG = `0x${'e5'.repeat(32)}`;

// Every configured JSON-RPC endpoint refuses JSON-RPC (NJA-2830).
const retired = () => Promise.reject(new Error('Unexpected status code: 405'));
const retiredClient = () =>
  ({ getObject: jest.fn(retired), getDynamicFieldObject: jest.fn(retired) }) as unknown as SuiClient;

// Shapes recorded 2026-11-16 against graphql.testnet.sui.io:
//   { object(address: <circle>) { asMoveObject { contents { type { repr } json } } } }
//   { object(address: <table>) { dynamicField(name: { type: "address", bcs: <b64> }) { name { json } } } }
const circleBody = (admin: string) => ({
  data: {
    object: {
      asMoveObject: {
        contents: {
          type: { repr: `${PKG}::njangi_circles::Circle` },
          json: {
            id: CIRCLE,
            name: 'Recorded circle',
            admin,
            members: { id: TABLE, size: '2' },
          },
        },
      },
    },
  },
});
const memberFound = { data: { object: { dynamicField: { name: { json: USER } } } } };
const memberAbsent = { data: { object: { dynamicField: null } } };

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

type FetchInit = { body?: unknown } | undefined;

function stubGraphql(answers: { circle: unknown; memberField: unknown }) {
  const fetchMock = jest.fn(async (_url: unknown, init?: FetchInit) => {
    const body = typeof init?.body === 'string' ? init.body : JSON.stringify(init?.body ?? null);
    // The members-table read names the table as the parent object; the
    // circle read names the circle. Either may carry the id in the query
    // text or in variables.
    if (body.includes(TABLE)) return jsonResponse(answers.memberField);
    if (body.includes(CIRCLE)) return jsonResponse(answers.circle);
    throw new Error(`unexpected GraphQL request: ${body}`);
  });
  (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
  return fetchMock;
}

const originalFetch = (globalThis as unknown as { fetch: unknown }).fetch;
afterEach(() => {
  (globalThis as unknown as { fetch: unknown }).fetch = originalFetch;
});

describe('isCurrentMemberOrAdmin answers over GraphQL when JSON-RPC is retired (NJA-2909)', () => {
  it('confirms a member found in the members table', async () => {
    const fetchMock = stubGraphql({ circle: circleBody(ADMIN), memberField: memberFound });
    const client = retiredClient();

    await expect(isCurrentMemberOrAdmin(client, CIRCLE, USER)).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalled();
    expect(fetchMock.mock.calls[0][0]).toBe(GRAPHQL_URL);
  });

  it('confirms the admin', async () => {
    stubGraphql({ circle: circleBody(USER), memberField: memberAbsent });

    await expect(isCurrentMemberOrAdmin(retiredClient(), CIRCLE, USER)).resolves.toBe(true);
  });

  it('answers false for a confirmed non-member (dynamicField: null, no errors)', async () => {
    stubGraphql({ circle: circleBody(ADMIN), memberField: memberAbsent });

    await expect(isCurrentMemberOrAdmin(retiredClient(), CIRCLE, USER)).resolves.toBe(false);
  });

  it('is unknown (null) when GraphQL cannot be reached either', async () => {
    const fetchMock = jest.fn(async () => {
      throw new Error('fetch failed');
    });
    (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;

    await expect(isCurrentMemberOrAdmin(retiredClient(), CIRCLE, USER)).resolves.toBeNull();
  });

  it('is unknown (null) when GraphQL answers with errors instead of the circle', async () => {
    stubGraphql({
      circle: { data: null, errors: [{ message: 'Internal error' }] },
      memberField: memberAbsent,
    });

    await expect(isCurrentMemberOrAdmin(retiredClient(), CIRCLE, USER)).resolves.toBeNull();
  });
});

describe('isCurrentMemberOrAdmin over GraphQL keeps its contract on every answer (NJA-2909)', () => {
  it('answers false when GraphQL confirms the circle no longer exists (object: null, no errors)', async () => {
    stubGraphql({ circle: { data: { object: null } }, memberField: memberAbsent });

    await expect(isCurrentMemberOrAdmin(retiredClient(), CIRCLE, USER)).resolves.toBe(false);
  });

  it('names the member by the base64 BCS of the address', async () => {
    const fetchMock = stubGraphql({ circle: circleBody(ADMIN), memberField: memberFound });

    await expect(isCurrentMemberOrAdmin(retiredClient(), CIRCLE, USER)).resolves.toBe(true);

    // USER is 32 bytes of 0x1a, whose base64 is 'Ghoa' ten times then 'Gho='.
    const memberRead = fetchMock.mock.calls
      .map(([, init]) => String(init?.body))
      .find((body) => body.includes(TABLE));
    expect(memberRead).toContain(`"${'Ghoa'.repeat(10)}Gho="`);
  });

  it.each<[string, unknown]>([
    ['the members table is not found', { data: { object: null } }],
    ['the members table answer has no dynamicField', { data: { object: {} } }],
    ['the members table answer has no data', {}],
  ])('is unknown (null) when %s', async (_label, memberField) => {
    stubGraphql({ circle: circleBody(ADMIN), memberField });

    await expect(isCurrentMemberOrAdmin(retiredClient(), CIRCLE, USER)).resolves.toBeNull();
  });

  it('is unknown (null) when the circle answer has no readable members table', async () => {
    stubGraphql({
      circle: { data: { object: { asMoveObject: { contents: { json: { id: CIRCLE, admin: ADMIN } } } } } },
      memberField: memberAbsent,
    });

    await expect(isCurrentMemberOrAdmin(retiredClient(), CIRCLE, USER)).resolves.toBeNull();
  });

  it('is unknown (null) when GraphQL answers with a non-2xx status', async () => {
    (globalThis as unknown as { fetch: unknown }).fetch = jest.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
      text: async () => 'Service Unavailable',
    }));

    await expect(isCurrentMemberOrAdmin(retiredClient(), CIRCLE, USER)).resolves.toBeNull();
  });

  it('falls back to JSON-RPC when GraphQL cannot answer', async () => {
    (globalThis as unknown as { fetch: unknown }).fetch = jest.fn(async () => {
      throw new Error('fetch failed');
    });
    const getObject = jest.fn(async () => ({
      data: {
        content: {
          dataType: 'moveObject',
          fields: { admin: ADMIN, members: { fields: { id: { id: TABLE } } } },
        },
      },
    }));
    const getDynamicFieldObject = jest.fn(async () => ({ data: { content: {} } }));
    const client = { getObject, getDynamicFieldObject } as unknown as SuiClient;

    await expect(isCurrentMemberOrAdmin(client, CIRCLE, USER)).resolves.toBe(true);
    expect(getDynamicFieldObject).toHaveBeenCalled();
  });
});
