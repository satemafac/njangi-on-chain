/**
 * NJA-2841 — the failure paths of membership-receipt discovery over GraphQL.
 * A failed or partial GraphQL read goes to the JSON-RPC fallback and is never
 * "no receipts"; when neither source answers the call rejects; pagination
 * follows `pageInfo.endCursor`; partial GraphQL pages are never merged with
 * the JSON-RPC answer.
 */

const mockGetOwnedObjects = jest.fn();
const mockGraphqlUrl = 'https://graphql.testnet.example/graphql';

jest.mock('@/services/sui-rpc-failover', () => ({
  getPooledSuiClient: () => ({ getOwnedObjects: mockGetOwnedObjects }),
}));
jest.mock('@/services/network-config', () => ({
  getCurrentNetwork: () => 'testnet',
  getGraphqlUrlForNetwork: () => mockGraphqlUrl,
}));
jest.mock('@/lib/circle-chain', () => ({
  getPublishedPackageMetadata: () => ({
    originalId: '0x' + '7f'.repeat(32),
    publishedAt: '0x' + '8e'.repeat(32),
  }),
}));

const OWNER = '0x' + 'a1'.repeat(32);
const CIRCLE_A = '0x' + 'c3'.repeat(32);
const CIRCLE_B = '0x' + 'd4'.repeat(32);
const CIRCLE_RPC = '0x' + 'e5'.repeat(32);
const RECEIPT_TYPE = `${'0x' + '7f'.repeat(32)}::njangi_circles::CircleMembership`;

import { discoverMemberCircleIds } from '../../lib/membership-discovery';
import { clearSuiReadCache } from '../../lib/sui-read';

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

function receiptPage(circleIds: string[], endCursor: string | null): unknown {
  return {
    data: {
      address: {
        objects: {
          pageInfo: { hasNextPage: endCursor !== null, endCursor },
          nodes: circleIds.map((circleId, i) => ({
            address: '0x' + String(i).padStart(64, '0'),
            contents: { type: { repr: RECEIPT_TYPE }, json: { circle_id: circleId } },
          })),
        },
      },
    },
  };
}

function rpcPage(circleIds: string[]): unknown {
  return {
    data: circleIds.map((circleId) => ({
      data: { content: { dataType: 'moveObject', fields: { circle_id: circleId } } },
    })),
    hasNextPage: false,
    nextCursor: null,
  };
}

function jsonRpcRetired(): Error {
  return Object.assign(new Error('Method not found'), { code: -32601 });
}

describe('discoverMemberCircleIds GraphQL failure paths (NJA-2841)', () => {
  beforeEach(() => {
    clearSuiReadCache();
    mockGetOwnedObjects.mockReset();
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('follows endCursor across GraphQL pages instead of stopping at the first', async () => {
    fetchMock
      .mockResolvedValueOnce(graphqlResponse(receiptPage([CIRCLE_A], 'cursor-1')))
      .mockResolvedValueOnce(graphqlResponse(receiptPage([CIRCLE_B], null)));

    await expect(discoverMemberCircleIds(OWNER, { network: 'testnet' })).resolves.toEqual([CIRCLE_A, CIRCLE_B]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String((fetchMock.mock.calls[1] as [unknown, { body?: unknown }])[1].body)).toContain('cursor-1');
    expect(mockGetOwnedObjects).not.toHaveBeenCalled();
  });

  it('treats a GraphQL errors body as a failed read and asks JSON-RPC', async () => {
    fetchMock.mockResolvedValue(graphqlResponse({ data: null, errors: [{ message: 'boom' }] }));
    mockGetOwnedObjects.mockResolvedValue(rpcPage([CIRCLE_RPC]));

    await expect(discoverMemberCircleIds(OWNER, { network: 'testnet' })).resolves.toEqual([CIRCLE_RPC]);
    expect(mockGetOwnedObjects).toHaveBeenCalled();
  });

  it('never merges a partial GraphQL list with the JSON-RPC answer', async () => {
    fetchMock
      .mockResolvedValueOnce(graphqlResponse(receiptPage([CIRCLE_A], 'cursor-1')))
      .mockResolvedValueOnce(graphqlResponse({}, 503));
    mockGetOwnedObjects.mockResolvedValue(rpcPage([CIRCLE_RPC]));

    await expect(discoverMemberCircleIds(OWNER, { network: 'testnet' })).resolves.toEqual([CIRCLE_RPC]);
  });

  it('rejects instead of answering [] when GraphQL lacks the object list and JSON-RPC fails', async () => {
    fetchMock.mockResolvedValue(graphqlResponse({ data: { address: null } }));
    mockGetOwnedObjects.mockRejectedValue(jsonRpcRetired());

    await expect(discoverMemberCircleIds(OWNER, { network: 'testnet' })).rejects.toThrow(/GraphQL.*JSON-RPC/);
  });

  it('rejects when a GraphQL receipt has no readable circle_id and JSON-RPC fails', async () => {
    fetchMock.mockResolvedValue(
      graphqlResponse({
        data: {
          address: {
            objects: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ address: '0x' + '5e'.repeat(32), contents: { json: {} } }],
            },
          },
        },
      }),
    );
    mockGetOwnedObjects.mockRejectedValue(jsonRpcRetired());

    await expect(discoverMemberCircleIds(OWNER, { network: 'testnet' })).rejects.toThrow();
  });
});
