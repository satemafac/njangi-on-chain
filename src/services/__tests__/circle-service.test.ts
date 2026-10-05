const mockGetPooledSuiClient = jest.fn();

jest.mock('../network-config', () => ({
  getCurrentNetwork: () => 'testnet',
  getCurrentPackageId: () =>
    '0xc5aed33e4da2530d0f9b36a64d96d662b109ba2962bb6918bc3fa21be1622465',
  getCurrentRpcUrl: () => 'https://primary.rpc',
}));

jest.mock('../sui-rpc-failover', () => ({
  getPooledSuiClient: (...args: unknown[]) => mockGetPooledSuiClient(...args),
}));

jest.mock('@/lib/circle-chain', () => ({
  extractPackageIdFromMoveType: jest.fn(),
  getPackageLookupIds: jest.fn(() => [
    '0xc5aed33e4da2530d0f9b36a64d96d662b109ba2962bb6918bc3fa21be1622465',
  ]),
  normalizePackageId: (value: string | null | undefined) => value?.toLowerCase() ?? null,
  resolveUpgradeAwarePackageId: jest.fn(
    ({ objectPackageId, currentPackageId }: { objectPackageId?: string; currentPackageId: string }) =>
      objectPackageId ?? currentPackageId,
  ),
}));

import { batchQueryEvents, getUserPackageIds } from '../circle-service';

describe('circle-service discovery helpers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('paginates queryEvents results for a package instead of stopping at the first page', async () => {
    const queryEvents = jest
      .fn()
      .mockResolvedValueOnce({
        data: [{ id: { txDigest: '0xtx1', eventSeq: '0' } }],
        hasNextPage: true,
        nextCursor: { txDigest: '0xtx1', eventSeq: '0' },
      })
      .mockResolvedValueOnce({
        data: [{ id: { txDigest: '0xtx2', eventSeq: '1' } }],
        hasNextPage: false,
        nextCursor: null,
      });

    const events = await batchQueryEvents(
      ['0xpackage'],
      'CircleCreated',
      { queryEvents } as unknown as Parameters<typeof batchQueryEvents>[2],
      { maxConcurrent: 1, limit: 1000 },
    );

    expect(events).toHaveLength(2);
    expect(queryEvents).toHaveBeenCalledTimes(2);
    expect(queryEvents).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        query: { MoveEventType: '0xpackage::njangi_circles::CircleCreated' },
        cursor: undefined,
        limit: 1000,
        order: 'descending',
      }),
    );
    expect(queryEvents).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        query: { MoveEventType: '0xpackage::njangi_circles::CircleCreated' },
        cursor: { txDigest: '0xtx1', eventSeq: '0' },
      }),
    );
  });

  describe('a package that keeps failing', () => {
    // The retries back off 500ms then 1s; fake timers keep the test instant.
    beforeEach(() => {
      jest.useFakeTimers();
      jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      jest.spyOn(console, 'log').mockImplementation(() => undefined);
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    const queryEvents = () =>
      jest.fn(async ({ query }: { query: { MoveEventType: string } }) => {
        if (query.MoveEventType.startsWith('0xbad')) throw new Error('Unexpected status code: 429');
        return { data: [{ id: { txDigest: '0xok', eventSeq: '0' } }], hasNextPage: false, nextCursor: null };
      });

    it('still returns the other packages\' events by default', async () => {
      const pending = batchQueryEvents(
        ['0xgood', '0xbad'],
        'CircleCreated',
        { queryEvents: queryEvents() } as unknown as Parameters<typeof batchQueryEvents>[2],
        { maxConcurrent: 2 },
      );
      await jest.runAllTimersAsync();
      await expect(pending).resolves.toHaveLength(1);
    });

    it('throws with throwOnFailure, so a partial scan is never read as the whole', async () => {
      const pending = batchQueryEvents(
        ['0xgood', '0xbad'],
        'CircleCreated',
        { queryEvents: queryEvents() } as unknown as Parameters<typeof batchQueryEvents>[2],
        { maxConcurrent: 2, throwOnFailure: true },
      );
      const assertion = expect(pending).rejects.toThrow(/1 of 2 package/);
      await jest.runAllTimersAsync();
      await assertion;
    });
  });

  it('paginates user transaction history so older package IDs remain discoverable', async () => {
    const queryTransactionBlocks = jest
      .fn()
      .mockResolvedValueOnce({
        data: [
          {
            events: [{ type: '0xaaa::njangi_circles::CircleCreated' }],
            objectChanges: [],
          },
        ],
        hasNextPage: true,
        nextCursor: 'cursor-1',
      })
      .mockResolvedValueOnce({
        data: [
          {
            events: [],
            objectChanges: [
              {
                type: 'created',
                objectType: '0xbbb::njangi_circles::Circle',
              },
            ],
          },
        ],
        hasNextPage: false,
        nextCursor: null,
      });

    mockGetPooledSuiClient.mockReturnValue({ queryTransactionBlocks });

    const packageIds = await getUserPackageIds('0xuser');

    expect(queryTransactionBlocks).toHaveBeenCalledTimes(2);
    expect(queryTransactionBlocks).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        filter: { FromAddress: '0xuser' },
        cursor: undefined,
        limit: 1000,
        order: 'descending',
      }),
    );
    expect(queryTransactionBlocks).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        filter: { FromAddress: '0xuser' },
        cursor: 'cursor-1',
      }),
    );
    expect(packageIds).toEqual(
      expect.arrayContaining([
        '0xaaa',
        '0xbbb',
        '0xc5aed33e4da2530d0f9b36a64d96d662b109ba2962bb6918bc3fa21be1622465',
      ]),
    );
  });
});
