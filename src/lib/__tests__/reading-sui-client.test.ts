// getReadingSuiClient (reading-sui-client.ts): a SuiClient for read-only
// helpers whose read methods go through the shared read layer (off
// JSON-RPC) when the pooled client carries a 2.x source, and whose other
// methods stay the pooled client's own. The read layer and the pooled
// client are stubs; nothing here reaches the network.

jest.mock('@/services/network-config', () => ({ getCurrentNetwork: () => 'testnet' }));
jest.mock('@/services/sui-rpc-failover', () => ({ getPooledSuiClient: jest.fn() }));
jest.mock('@/lib/sui-read', () => ({
  readObject: jest.fn(),
  readObjects: jest.fn(),
  listDynamicFields: jest.fn(),
  readDynamicFieldObject: jest.fn(),
  queryEventsCached: jest.fn(),
}));

import { getPooledSuiClient } from '@/services/sui-rpc-failover';
import { listDynamicFields, queryEventsCached, readDynamicFieldObject, readObject } from '@/lib/sui-read';
import { clearReadingSuiClients, getReadingSuiClient } from '@/lib/reading-sui-client';
import { attachV2ReadSource, type V2ReadSource } from '@/lib/v2-read-source';
import { attachedV2Reads } from '@/lib/tx-transport';

const CIRCLE = `0x${'c1'.repeat(32)}`;

function pooledClient(withSource: boolean) {
  const client = {
    getObject: jest.fn(async () => ({ data: { objectId: 'json-rpc' } })),
    getDynamicFields: jest.fn(),
    getTransactionBlock: jest.fn(async () => ({ digest: 'from-json-rpc' })),
  };
  return withSource ? attachV2ReadSource(client, { network: 'testnet' } as V2ReadSource) : client;
}

beforeEach(() => {
  clearReadingSuiClients();
});

describe('getReadingSuiClient', () => {
  it('routes reads through the shared read layer when the pooled client has a 2.x source', async () => {
    const pooled = pooledClient(true);
    (getPooledSuiClient as jest.Mock).mockReturnValue(pooled);
    (readObject as jest.Mock).mockResolvedValue({ data: { objectId: CIRCLE } });
    (listDynamicFields as jest.Mock).mockResolvedValue([{ objectId: '0xf' }]);
    (readDynamicFieldObject as jest.Mock).mockResolvedValue({ error: { code: 'dynamicFieldNotFound' } });
    (queryEventsCached as jest.Mock).mockResolvedValue({ data: [], hasNextPage: false, nextCursor: null });

    const client = getReadingSuiClient('testnet');
    await expect(client.getObject({ id: CIRCLE, options: { showContent: true } })).resolves.toEqual({ data: { objectId: CIRCLE } });
    expect(readObject).toHaveBeenCalledWith(CIRCLE, { showContent: true }, { network: 'testnet' });
    expect(pooled.getObject).not.toHaveBeenCalled();

    await expect(client.getDynamicFields({ parentId: CIRCLE, cursor: null })).resolves.toEqual({
      data: [{ objectId: '0xf' }],
      hasNextPage: false,
      nextCursor: null,
    });
    await client.getDynamicFieldObject({ parentId: CIRCLE, name: { type: 'address', value: CIRCLE } });
    expect(readDynamicFieldObject).toHaveBeenCalledWith(CIRCLE, { type: 'address', value: CIRCLE }, { network: 'testnet' });
    await client.queryEvents({ query: { MoveEventType: '0x1::m::E' }, limit: 5, order: 'descending' });
    expect(queryEventsCached).toHaveBeenCalledWith({ query: { MoveEventType: '0x1::m::E' }, order: 'descending' }, { network: 'testnet' });
  });

  it('carries the 2.x reads v11 helpers look for', () => {
    (getPooledSuiClient as jest.Mock).mockReturnValue(pooledClient(true));
    expect(attachedV2Reads(getReadingSuiClient('testnet'))).toBeDefined();
  });

  it('leaves every other method to the pooled client', async () => {
    const pooled = pooledClient(true);
    (getPooledSuiClient as jest.Mock).mockReturnValue(pooled);
    await expect(getReadingSuiClient('testnet').getTransactionBlock({ digest: 'D' })).resolves.toEqual({ digest: 'from-json-rpc' });
    expect(pooled.getTransactionBlock).toHaveBeenCalledWith({ digest: 'D' });
  });

  it('is the pooled client itself when that client has no 2.x source', () => {
    const pooled = pooledClient(false);
    (getPooledSuiClient as jest.Mock).mockReturnValue(pooled);
    expect(getReadingSuiClient('testnet')).toBe(pooled);
  });

  it('wraps a new pooled client anew', () => {
    const first = pooledClient(true);
    const second = pooledClient(true);
    (getPooledSuiClient as jest.Mock).mockReturnValueOnce(first).mockReturnValueOnce(first).mockReturnValueOnce(second);
    const a = getReadingSuiClient('testnet');
    expect(getReadingSuiClient('testnet')).toBe(a);
    expect(getReadingSuiClient('testnet')).not.toBe(a);
  });
});
