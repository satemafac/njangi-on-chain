// Tests for getOwnedObjects-based member-circle discovery.

const getOwnedObjects = jest.fn();
let mockOriginalId: string | null = '0xpkg';

jest.mock('@/services/sui-rpc-failover', () => ({
  getPooledSuiClient: () => ({ getOwnedObjects }),
}));
jest.mock('@/services/network-config', () => ({
  getCurrentNetwork: () => 'testnet',
}));
jest.mock('@/lib/circle-chain', () => ({
  getPublishedPackageMetadata: () => ({ originalId: mockOriginalId, publishedAt: '0xnew' }),
}));

import { discoverMemberCircleIds } from '@/lib/membership-discovery';
import { clearSuiReadCache } from '@/lib/sui-read';

const receipt = (circleId: string) => ({ data: { content: { fields: { circle_id: circleId } } } });

beforeEach(() => {
  clearSuiReadCache();
  getOwnedObjects.mockReset();
  mockOriginalId = '0xpkg';
});

it('returns the circle ids from owned membership receipts', async () => {
  getOwnedObjects.mockResolvedValueOnce({
    data: [receipt('0xc1'), receipt('0xc2')],
    hasNextPage: false,
    nextCursor: null,
  });

  const ids = await discoverMemberCircleIds('0xuser');
  expect(ids.sort()).toEqual(['0xc1', '0xc2']);
});

it('filters by the ORIGINAL package id struct type (anchored across upgrades)', async () => {
  getOwnedObjects.mockResolvedValueOnce({ data: [], hasNextPage: false, nextCursor: null });
  await discoverMemberCircleIds('0xuser');

  expect(getOwnedObjects).toHaveBeenCalledWith(
    expect.objectContaining({
      owner: '0xuser',
      filter: { StructType: '0xpkg::njangi_circles::CircleMembership' },
    }),
  );
});

it('paginates via cursor and dedups circle ids', async () => {
  getOwnedObjects
    .mockResolvedValueOnce({ data: [receipt('0xc1')], hasNextPage: true, nextCursor: 'cur1' })
    .mockResolvedValueOnce({ data: [receipt('0xc1'), receipt('0xc2')], hasNextPage: false, nextCursor: null });

  const ids = await discoverMemberCircleIds('0xuser');
  expect(getOwnedObjects).toHaveBeenCalledTimes(2);
  expect(getOwnedObjects.mock.calls[1][0].cursor).toBe('cur1');
  expect(ids.sort()).toEqual(['0xc1', '0xc2']);
});

it('returns empty when the package lineage is unknown (no RPC call)', async () => {
  mockOriginalId = null;
  const ids = await discoverMemberCircleIds('0xuser');
  expect(ids).toEqual([]);
  expect(getOwnedObjects).not.toHaveBeenCalled();
});
