/**
 * NJA-2985 — verifying a membership receipt over Sui GraphQL.
 *
 * Live on the testnet dashboard (2026-11-16): receipt discovery lists the
 * member's circles over GraphQL, then `isCurrentMemberOrAdmin` verifies each
 * one ONLY through JSON-RPC (`client.getObject`, `client.getDynamicFieldObject`).
 * Every configured JSON-RPC endpoint refuses JSON-RPC (NJA-2830), so each
 * circle verifies as null (unknown), the dashboard counts it unverifiable and
 * none reaches the screen.
 *
 * Expected: GraphQL first, JSON-RPC as the fallback, the contract unchanged:
 * true for the admin or a member, false only on a confirmed answer, null when
 * nothing could be read.
 *
 * Shapes recorded against https://graphql.testnet.sui.io/graphql (2026-11-16):
 *  - the circle: { object(address: "<circle id>") { asMoveObject { contents { json } } } }
 *    answers json.admin (a 66-character address) and json.members as { id, size };
 *  - the members entry MUST be read with address(...): a Table's id is not an
 *    object, so object(address: "<table id>") answers `object: null` for every
 *    table (why PR #148 only ever verified the admin).
 *    { address(address: "<table id>") { dynamicField(name: { type: "address",
 *      bcs: "<base64 of the 32 address bytes>" }) { name { json } } } }
 *    a member answers the field; a non-member answers `dynamicField: null`
 *    with no errors. address(...) is never null.
 */

const mockGraphqlUrl = 'https://graphql.testnet.example/graphql';

// Sui's own fullnode has retired JSON-RPC: every method answers -32601.
const jsonRpcRetired = () => Object.assign(new Error('Method not found'), { code: -32601 });
const retiredClient = () => ({
  getObject: jest.fn().mockRejectedValue(jsonRpcRetired()),
  getDynamicFieldObject: jest.fn().mockRejectedValue(jsonRpcRetired()),
  getOwnedObjects: jest.fn().mockRejectedValue(jsonRpcRetired()),
});

jest.mock('@/services/sui-rpc-failover', () => ({
  getPooledSuiClient: () => retiredClient(),
  withSuiRpcFailover: async (_network: unknown, _name: unknown, operation: (client: unknown) => unknown) =>
    operation(retiredClient()),
}));
jest.mock('@/services/network-config', () => ({
  getCurrentNetwork: () => 'testnet',
  getGraphqlUrlForNetwork: () => mockGraphqlUrl,
  getCurrentGraphqlUrl: () => mockGraphqlUrl,
}));
jest.mock('@/lib/circle-chain', () => ({
  getPublishedPackageMetadata: () => ({
    originalId: '0x' + '7f'.repeat(32),
    publishedAt: '0x' + '8e'.repeat(32),
  }),
}));

import type { SuiClient } from '@mysten/sui/client';
import { isCurrentMemberOrAdmin } from '../../lib/membership-discovery';
import { clearSuiReadCache } from '../../lib/sui-read';

// Valid Sui ids and addresses only: 0x followed by exactly 64 hex digits.
const CIRCLE = '0x' + 'c3'.repeat(32);
const MEMBERS_TABLE = '0x' + '7a'.repeat(32);
const ADMIN = '0x' + 'a1'.repeat(32);
const MEMBER = '0x' + 'b2'.repeat(32);
const STRANGER = '0x' + 'd4'.repeat(32);

/** An address's BCS bytes (its 32 bytes) base64-encoded: the `bcs` of a dynamicField name. */
const addressBcsBase64 = (address: string) => Buffer.from(address.slice(2), 'hex').toString('base64');

const fetchMock = jest.fn();

function graphqlResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** The circle, as object(address: CIRCLE) { asMoveObject { contents { json } } } answers it. */
const circleAnswer = {
  data: {
    object: {
      asMoveObject: {
        contents: {
          json: {
            id: CIRCLE,
            name: 'Village Savings',
            admin: ADMIN,
            members: { id: MEMBERS_TABLE, size: '2' },
          },
        },
      },
    },
  },
};

/** The members entry, as address(address: MEMBERS_TABLE) { dynamicField(...) { name { json } } } answers it. */
const memberEntry = (address: string) => ({ data: { address: { dynamicField: { name: { json: address } } } } });
const noMemberEntry = { data: { address: { dynamicField: null } } };

/**
 * Answer as the live service does: the circle through object(...); the
 * members entry through address(...) on the table id, found by the member's
 * BCS bytes; object(...) on the table id answers `object: null` (a Table's id
 * is not an object); anything else is an unmodelled query and gets errors.
 */
function serveGraphql(members: string[]): void {
  fetchMock.mockImplementation(async (_url: unknown, init?: { body?: unknown }) => {
    const sent = String(init?.body ?? '').replace(/\\"/g, '"');
    if (sent.includes('object(') && sent.includes(CIRCLE)) return graphqlResponse(circleAnswer);
    if (sent.includes('object(') && sent.includes(MEMBERS_TABLE)) return graphqlResponse({ data: { object: null } });
    if (sent.includes('address(') && sent.includes(MEMBERS_TABLE) && sent.includes('"address"')) {
      const found = members.find((member) => sent.includes(addressBcsBase64(member)));
      return graphqlResponse(found ? memberEntry(found) : noMemberEntry);
    }
    return graphqlResponse({ data: null, errors: [{ message: 'unmodelled query' }] });
  });
}

const client = () => retiredClient() as unknown as SuiClient;

const graphqlUnreadable: Array<[string, () => void]> = [
  ['GraphQL is unreachable', () => { fetchMock.mockRejectedValue(new TypeError('fetch failed')); }],
  ['GraphQL answers 503', () => { fetchMock.mockResolvedValue(graphqlResponse({}, 503)); }],
  ['GraphQL answers an errors body', () => { fetchMock.mockResolvedValue(graphqlResponse({ data: null, errors: [{ message: 'boom' }] })); }],
];

describe('isCurrentMemberOrAdmin over Sui GraphQL when JSON-RPC is retired (NJA-2985)', () => {
  beforeEach(() => {
    clearSuiReadCache();
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('confirms the admin from the circle read through object(...)', async () => {
    serveGraphql([MEMBER]);

    // Resolving true (not null) is what lets the dashboard surface the circle
    // instead of counting it unverifiable.
    await expect(isCurrentMemberOrAdmin(client(), CIRCLE, ADMIN)).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(mockGraphqlUrl, expect.objectContaining({ method: 'POST' }));
  });

  it('confirms a non-admin member through the members entry read with address(...)', async () => {
    serveGraphql([MEMBER]);

    await expect(isCurrentMemberOrAdmin(client(), CIRCLE, MEMBER)).resolves.toBe(true);

    // The entry was asked of the table's ADDRESS, by the member's BCS bytes.
    const bodies = fetchMock.mock.calls.map((call) => String((call as [unknown, { body?: unknown }])[1]?.body ?? ''));
    expect(
      bodies.some((body) => body.includes('address(') && body.includes(MEMBERS_TABLE) && body.includes(addressBcsBase64(MEMBER))),
    ).toBe(true);
  });

  it('answers false for a non-member: address(...) answers dynamicField: null, a confirmed absence', async () => {
    serveGraphql([MEMBER]);

    await expect(isCurrentMemberOrAdmin(client(), CIRCLE, STRANGER)).resolves.toBe(false);
  });

  it.each(graphqlUnreadable)('is unknown (null), never false, when %s and JSON-RPC is retired', async (_label, arrange) => {
    arrange();

    await expect(isCurrentMemberOrAdmin(client(), CIRCLE, MEMBER)).resolves.toBeNull();
  });
});
