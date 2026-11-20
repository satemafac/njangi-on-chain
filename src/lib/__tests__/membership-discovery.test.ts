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

import { discoverMemberCircleIds, isCurrentMemberOrAdmin } from '@/lib/membership-discovery';
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

describe('isCurrentMemberOrAdmin', () => {
  const USER = '0xuser';
  const circle = (fields: Record<string, unknown>) => ({
    data: { content: { dataType: 'moveObject', fields } },
  });
  const withTable = { admin: '0xadmin', members: { fields: { id: { id: '0xtable' } } } };
  const clientWith = (
    getObject: () => Promise<unknown>,
    getDynamicFieldObject: () => Promise<unknown> = async () => ({ data: { content: {} } }),
  ) => ({ getObject: jest.fn(getObject), getDynamicFieldObject: jest.fn(getDynamicFieldObject) }) as never;

  it('confirms the admin without reading the members table', async () => {
    const client = clientWith(async () => circle({ ...withTable, admin: USER }));
    await expect(isCurrentMemberOrAdmin(client, '0xc', USER)).resolves.toBe(true);
  });

  it('confirms a member found in the live members table', async () => {
    const client = clientWith(async () => circle(withTable));
    await expect(isCurrentMemberOrAdmin(client, '0xc', USER)).resolves.toBe(true);
  });

  it('answers false for a member the table no longer holds (removed)', async () => {
    const client = clientWith(
      async () => circle(withTable),
      async () => ({ error: { code: 'dynamicFieldNotFound' } }),
    );
    await expect(isCurrentMemberOrAdmin(client, '0xc', USER)).resolves.toBe(false);
  });

  it('answers false for a circle that no longer exists', async () => {
    const client = clientWith(async () => ({ error: { code: 'deleted' } }));
    await expect(isCurrentMemberOrAdmin(client, '0xc', USER)).resolves.toBe(false);
  });

  // The swallow this replaces returned false for all of these, hiding the
  // user's circle whenever the RPC had a bad moment.
  it.each([
    ['the circle read throws', clientWith(async () => { throw new Error('Unexpected status code: 503'); })],
    ['the circle read errors without saying it is gone', clientWith(async () => ({ error: { code: 'unknown' } }))],
    ['the member lookup throws', clientWith(async () => circle(withTable), async () => { throw new Error('429'); })],
    ['the member lookup errors otherwise', clientWith(async () => circle(withTable), async () => ({ error: { code: 'unknown' } }))],
    ['the circle has no members table', clientWith(async () => circle({ admin: '0xadmin' }))],
  ])('is unknown (null) when %s', async (_label, client) => {
    await expect(isCurrentMemberOrAdmin(client, '0xc', USER)).resolves.toBeNull();
  });
});
