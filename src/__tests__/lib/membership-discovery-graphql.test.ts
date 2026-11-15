/**
 * NJA-2841 — membership-receipt discovery over Sui GraphQL.
 *
 * Recorded situation (2026-11-15): every JSON-RPC endpoint the app is
 * configured with refuses JSON-RPC (publicnode -32000, blockvision 404, Sui's
 * own fullnode -32601), while Sui's GraphQL service still lists an address's
 * objects by type:
 *
 *   { address(address: $owner) { objects(first: 50, filter: { type: "<receipt type>" })
 *       { nodes { address contents { type { repr } json } } } } }
 *
 * On this commit `discoverMemberCircleIds` lists the member's CircleMembership
 * receipts ONLY through `client.getOwnedObjects` (JSON-RPC), so it rejects, the
 * dashboard marks the scan incomplete and shows no circles, although the
 * receipts are readable over GraphQL. Expected: GraphQL first, JSON-RPC as the
 * fallback — and a failed GraphQL read is never turned into "no receipts".
 */

const getOwnedObjects = jest.fn();
const mockGraphqlUrl = 'https://graphql.testnet.example/graphql';

jest.mock('@/services/sui-rpc-failover', () => ({
  getPooledSuiClient: () => ({ getOwnedObjects }),
  withSuiRpcFailover: async (
    _network: unknown,
    _name: unknown,
    operation: (client: { getOwnedObjects: typeof getOwnedObjects }) => unknown,
  ) => operation({ getOwnedObjects }),
}));
jest.mock('@/services/network-config', () => ({
  getCurrentNetwork: () => 'testnet',
  getGraphqlUrlForNetwork: () => mockGraphqlUrl,
  getCurrentGraphqlUrl: () => mockGraphqlUrl,
  getNetworkConfig: () => ({ graphqlUrl: mockGraphqlUrl, rpcUrl: 'https://rpc.testnet.example' }),
  getCurrentNetworkConfig: () => ({ graphqlUrl: mockGraphqlUrl, rpcUrl: 'https://rpc.testnet.example' }),
}));
// Struct types stay anchored to the ORIGINAL package id across upgrades.
jest.mock('@/lib/circle-chain', () => ({
  getPublishedPackageMetadata: () => ({
    originalId: '0x' + '7f'.repeat(32),
    publishedAt: '0x' + '8e'.repeat(32),
  }),
}));

// A valid Sui address is 0x followed by exactly 64 hex digits.
const OWNER = '0x' + 'a1'.repeat(32);
const CIRCLE_ID = '0x' + 'c3'.repeat(32);
const RECEIPT_ID = '0x' + '5e'.repeat(32);
const ORIGINAL_PACKAGE_ID = '0x' + '7f'.repeat(32);
const RECEIPT_TYPE = `${ORIGINAL_PACKAGE_ID}::njangi_circles::CircleMembership`;

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

// Sui's own fullnode has retired JSON-RPC: every method answers -32601.
function jsonRpcRetired(): Error {
  return Object.assign(new Error('Method not found'), { code: -32601 });
}

// The receipt list as graphql.testnet.sui.io answers it (recorded 2026-11-15):
// one soulbound CircleMembership receipt owned by OWNER, pointing at CIRCLE_ID.
const recordedReceiptPage = {
  data: {
    address: {
      objects: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [
          {
            address: RECEIPT_ID,
            contents: {
              type: { repr: RECEIPT_TYPE },
              json: {
                id: RECEIPT_ID,
                circle_id: CIRCLE_ID,
                member: OWNER,
                joined_at: '1763164800000',
              },
            },
          },
        ],
      },
    },
  },
};

describe('discoverMemberCircleIds over Sui GraphQL (NJA-2841)', () => {
  beforeEach(() => {
    clearSuiReadCache();
    getOwnedObjects.mockReset();
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  it("finds the member's receipts through GraphQL when every JSON-RPC endpoint refuses JSON-RPC", async () => {
    fetchMock.mockResolvedValue(graphqlResponse(recordedReceiptPage));
    getOwnedObjects.mockRejectedValue(jsonRpcRetired());

    // Resolving with the receipt's circle (instead of rejecting, or answering
    // an empty list) is what stops the dashboard from marking the scan
    // incomplete and lets the circle be surfaced.
    await expect(discoverMemberCircleIds(OWNER, { network: 'testnet' })).resolves.toEqual([CIRCLE_ID]);

    // The list came from Sui's GraphQL service, asked for this owner's objects
    // of the receipt type anchored to the ORIGINAL package id.
    expect(fetchMock).toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0] as [unknown, { method?: string; body?: unknown }];
    expect(String(url)).toBe(mockGraphqlUrl);
    expect(init.method).toBe('POST');
    const sent = String(init.body);
    expect(sent).toContain(OWNER);
    expect(sent).toContain(RECEIPT_TYPE);
  });
});
