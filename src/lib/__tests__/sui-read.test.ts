// Tests for the L2 shared read layer: single-flight dedup, TTL cache, and
// microtask object-read batching. We mock the failover client so the only
// thing under test is the coalescing/caching logic.

const multiGetObjects = jest.fn();
const queryEvents = jest.fn();

jest.mock('@/services/sui-rpc-failover', () => ({
  getPooledSuiClient: () => ({ multiGetObjects, queryEvents }),
}));

jest.mock('@/services/network-config', () => ({
  getCurrentNetwork: () => 'testnet',
}));

import {
  readObject,
  readObjects,
  cachedRead,
  queryEventsCached,
  invalidateObject,
  invalidateSuiRead,
  clearSuiReadCache,
  DEFAULT_READ_TTL_MS,
} from '@/lib/sui-read';

const resp = (id: string) => ({ data: { objectId: id } });

beforeEach(() => {
  clearSuiReadCache();
  multiGetObjects.mockReset();
  multiGetObjects.mockImplementation(async ({ ids }: { ids: string[] }) =>
    ids.map((id) => resp(id)),
  );
  queryEvents.mockReset();
  queryEvents.mockImplementation(async () => ({ data: [{ id: 'e1' }], hasNextPage: false }));
});

describe('readObject batching + dedup', () => {
  it('coalesces concurrent reads of distinct ids into one multiGetObjects call', async () => {
    const [a, b, c] = await Promise.all([
      readObject('0xa'),
      readObject('0xb'),
      readObject('0xc'),
    ]);

    expect(multiGetObjects).toHaveBeenCalledTimes(1);
    expect(multiGetObjects.mock.calls[0][0].ids).toEqual(['0xa', '0xb', '0xc']);
    expect(a).toEqual(resp('0xa'));
    expect(b).toEqual(resp('0xb'));
    expect(c).toEqual(resp('0xc'));
  });

  it('single-flights concurrent reads of the SAME id (one entry in the batch)', async () => {
    const [a1, a2] = await Promise.all([readObject('0xa'), readObject('0xa')]);

    expect(multiGetObjects).toHaveBeenCalledTimes(1);
    expect(multiGetObjects.mock.calls[0][0].ids).toEqual(['0xa']);
    expect(a1).toBe(a2); // same shared promise result
  });

  it('serves a second read from the TTL cache without another RPC call', async () => {
    await readObject('0xa');
    await readObject('0xa');

    expect(multiGetObjects).toHaveBeenCalledTimes(1);
  });

  it('does not cache errors — the next read retries', async () => {
    multiGetObjects.mockRejectedValueOnce(new Error('rate limited'));

    await expect(readObject('0xa')).rejects.toThrow('rate limited');

    // Cache was not poisoned: a fresh attempt hits the RPC again and succeeds.
    const ok = await readObject('0xa');
    expect(ok).toEqual(resp('0xa'));
    expect(multiGetObjects).toHaveBeenCalledTimes(2);
  });

  it('chunks more than 50 ids across multiple multiGetObjects calls', async () => {
    const ids = Array.from({ length: 51 }, (_, i) => `0x${i}`);
    const results = await readObjects(ids);

    expect(multiGetObjects).toHaveBeenCalledTimes(2);
    expect(multiGetObjects.mock.calls[0][0].ids).toHaveLength(50);
    expect(multiGetObjects.mock.calls[1][0].ids).toHaveLength(1);
    expect(results).toHaveLength(51);
  });

  it('separates batches by object options', async () => {
    await Promise.all([
      readObject('0xa', { showContent: true }),
      readObject('0xa', { showContent: false }),
    ]);

    // Different option sets cannot share a multiGetObjects call.
    expect(multiGetObjects).toHaveBeenCalledTimes(2);
  });

  it('invalidateObject forces a refetch', async () => {
    await readObject('0xa');
    invalidateObject('0xa');
    await readObject('0xa');

    expect(multiGetObjects).toHaveBeenCalledTimes(2);
  });
});

describe('cachedRead', () => {
  it('single-flights and caches an arbitrary loader', async () => {
    const loader = jest.fn(async () => 'value');

    const [a, b] = await Promise.all([
      cachedRead('k', loader),
      cachedRead('k', loader),
    ]);
    const c = await cachedRead('k', loader);

    expect(loader).toHaveBeenCalledTimes(1);
    expect([a, b, c]).toEqual(['value', 'value', 'value']);
  });

  it('respects ttlMs = 0 (no caching)', async () => {
    const loader = jest.fn(async () => 'value');

    await cachedRead('k', loader, 0);
    await cachedRead('k', loader, 0);

    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('exposes a sane default TTL', () => {
    expect(DEFAULT_READ_TTL_MS).toBeGreaterThan(0);
  });
});

describe('queryEventsCached', () => {
  const filter = { MoveEventType: '0xpkg::njangi_circles::MemberJoined' };

  it('dedups identical concurrent event scans into one RPC call', async () => {
    const [a, b] = await Promise.all([
      queryEventsCached({ query: filter, limit: 50 }),
      queryEventsCached({ query: filter, limit: 50 }),
    ]);
    const c = await queryEventsCached({ query: filter, limit: 50 });

    expect(queryEvents).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(c.data).toHaveLength(1);
  });

  it('treats different filters / limits as distinct cache keys', async () => {
    await queryEventsCached({ query: filter, limit: 50 });
    await queryEventsCached({ query: filter, limit: 100 });
    await queryEventsCached({
      query: { MoveEventType: '0xpkg::njangi_custody::CustodyDeposited' },
      limit: 50,
    });

    expect(queryEvents).toHaveBeenCalledTimes(3);
  });

  it('invalidateSuiRead("events:") clears cached event scans', async () => {
    await queryEventsCached({ query: filter, limit: 50 });
    invalidateSuiRead('events:');
    await queryEventsCached({ query: filter, limit: 50 });

    expect(queryEvents).toHaveBeenCalledTimes(2);
  });
});
