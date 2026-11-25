/**
 * NJA-3968 (Sui reads 1b): what the reading client's getOwnedObjects answers
 * once it is served off JSON-RPC. The owned-object listing
 * (v2ListOwnedObjects, whose transports v2-sui-client-owned-objects.test.ts
 * exercises) and sui-read's readObjects are stubs; the pooled client's own
 * getOwnedObjects stands in for the retired JSON-RPC and is never to be
 * asked. Nothing here reaches the network.
 */

jest.mock('../../services/network-config', () => ({ getCurrentNetwork: () => 'testnet' }));
jest.mock('../../services/sui-rpc-failover', () => ({ getPooledSuiClient: jest.fn() }));
jest.mock('../../lib/v2-sui-client', () => ({
  v2TxTransports: jest.fn(),
  v2Reads: jest.fn(),
  v2ListOwnedObjects: jest.fn(),
}));
jest.mock('../../lib/sui-read', () => ({
  readObject: jest.fn(),
  readObjects: jest.fn(),
  listDynamicFields: jest.fn(),
  readDynamicFieldObject: jest.fn(),
  queryEventsCached: jest.fn(),
}));

import { getPooledSuiClient } from '../../services/sui-rpc-failover';
import { readObjects } from '../../lib/sui-read';
import { v2ListOwnedObjects } from '../../lib/v2-sui-client';
import { clearReadingSuiClients, getReadingSuiClient } from '../../lib/reading-sui-client';
import { attachV2ReadSource, type V2ReadSource } from '../../lib/v2-read-source';

const OWNER = `0x${'a1'.repeat(32)}`;
const CLAIM_TYPE = '0xcore::njangi_cycle_escrow::Claim<0x2::sui::SUI>';
const FILTER = { StructType: CLAIM_TYPE };

const idOf = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;

/** One entry of the listing, as v2ListOwnedObjects returns it. */
const listed = (n: number) => ({ objectId: idOf(n), version: String(10 + n), digest: `digest${n}`, type: CLAIM_TYPE });

/** One object as readObjects (multiGetObjects) returns it. */
const read = (n: number) => ({
  data: {
    objectId: idOf(n),
    version: String(10 + n),
    digest: `digest${n}`,
    type: CLAIM_TYPE,
    content: { dataType: 'moveObject', type: CLAIM_TYPE, hasPublicTransfer: true, fields: { cycle_no: String(n) } },
  },
});

const listing = v2ListOwnedObjects as jest.Mock;
const reading = readObjects as jest.Mock;
const client = () => getReadingSuiClient('testnet');
let jsonRpcGetOwnedObjects: jest.Mock;

beforeEach(() => {
  clearReadingSuiClients();
  listing.mockReset();
  reading.mockReset();
  // The retired JSON-RPC: every address refuses it.
  jsonRpcGetOwnedObjects = jest.fn().mockRejectedValue(new Error('JSON-RPC is no longer served on this endpoint'));
  (getPooledSuiClient as jest.Mock).mockReturnValue(
    attachV2ReadSource(
      { getObject: jest.fn(), getOwnedObjects: jsonRpcGetOwnedObjects },
      { network: 'testnet' } as V2ReadSource,
    ),
  );
});

afterEach(() => {
  // Whatever the reading client answered, it never asked the retired JSON-RPC.
  expect(jsonRpcGetOwnedObjects).not.toHaveBeenCalled();
});

describe("the reading client's getOwnedObjects, served off JSON-RPC (NJA-3968)", () => {
  it('lists by type off the 2.x layer and reads the listed objects as multiGetObjects reads them', async () => {
    listing.mockResolvedValue([listed(1), listed(2)]);
    reading.mockResolvedValue([read(1), read(2)]);
    const options = { showType: true, showContent: true };

    const page = await client().getOwnedObjects({ owner: OWNER, filter: FILTER, options });

    expect(listing).toHaveBeenCalledWith('testnet', OWNER, CLAIM_TYPE);
    expect(reading).toHaveBeenCalledWith([idOf(1), idOf(2)], options, { network: 'testnet' });
    expect(page.data).toEqual([read(1), read(2)]);
    expect(page.hasNextPage).toBe(false);
  });

  it('answers from the listing alone when no more than ids, versions, digests and types are asked for', async () => {
    listing.mockResolvedValue([listed(1), listed(2)]);

    const bare = await client().getOwnedObjects({ owner: OWNER, filter: FILTER, options: { showContent: false } });
    const typed = await client().getOwnedObjects({ owner: OWNER, filter: FILTER, options: { showType: true } });

    expect(reading).not.toHaveBeenCalled();
    expect(bare.data).toEqual([
      { data: { objectId: idOf(1), version: '11', digest: 'digest1' } },
      { data: { objectId: idOf(2), version: '12', digest: 'digest2' } },
    ]);
    expect(typed.data.map((item) => item.data?.type)).toEqual([CLAIM_TYPE, CLAIM_TYPE]);
  });

  it('answers no objects only when the listing says there are none', async () => {
    listing.mockResolvedValue([]);

    const page = await client().getOwnedObjects({ owner: OWNER, filter: FILTER, options: { showContent: true } });

    expect(page.data).toEqual([]);
    expect(page.hasNextPage).toBe(false);
    expect(reading).not.toHaveBeenCalled();
  });

  it('throws, never an empty page, when the listing cannot be read', async () => {
    listing.mockRejectedValue(new Error('[v2-read:graphql] a next page without a new cursor'));

    await expect(
      client().getOwnedObjects({ owner: OWNER, filter: FILTER, options: { showContent: true } }),
    ).rejects.toThrow('a next page without a new cursor');
    expect(reading).not.toHaveBeenCalled();
  });

  it.each([
    ['an error', [read(1), { error: { code: 'notExists', object_id: idOf(2) } }]],
    ['an entry without data', [read(1), {}]],
    ['another object', [read(1), read(3)]],
    ['a shorter list', [read(1)]],
  ])('throws when a listed object comes back as %s, rather than drop it', async (_what, answer) => {
    listing.mockResolvedValue([listed(1), listed(2)]);
    reading.mockResolvedValue(answer);

    await expect(
      client().getOwnedObjects({ owner: OWNER, filter: FILTER, options: { showType: true, showContent: true } }),
    ).rejects.toThrow(/listed/);
  });

  it('serves only a { StructType } filter, and throws for any other rather than ignore it', async () => {
    await expect(client().getOwnedObjects({ owner: OWNER, filter: { MatchAll: [FILTER] } })).rejects.toThrow(
      /StructType/,
    );
    await expect(client().getOwnedObjects({ owner: OWNER })).rejects.toThrow(/StructType/);
    expect(listing).not.toHaveBeenCalled();
  });

  it('pages over the whole listing for a cursor or a limit, and throws for a cursor the listing does not hold', async () => {
    listing.mockResolvedValue([listed(1), listed(2), listed(3)]);
    const bare = { owner: OWNER, filter: FILTER, options: { showContent: false } };

    const first = await client().getOwnedObjects({ ...bare, limit: 2 });
    expect(first.data.map((item) => item.data?.objectId)).toEqual([idOf(1), idOf(2)]);
    expect(first.hasNextPage).toBe(true);
    expect(first.nextCursor).toBe(idOf(2));

    const rest = await client().getOwnedObjects({ ...bare, cursor: first.nextCursor, limit: 2 });
    expect(rest.data.map((item) => item.data?.objectId)).toEqual([idOf(3)]);
    expect(rest.hasNextPage).toBe(false);
    expect(rest.nextCursor).toBe(idOf(3));

    await expect(client().getOwnedObjects({ ...bare, cursor: idOf(9) })).rejects.toThrow(/cursor/);
    await expect(client().getOwnedObjects({ ...bare, limit: 0 })).rejects.toThrow(/limit/);
  });

  it('reads only the page asked for when content is wanted', async () => {
    listing.mockResolvedValue([listed(1), listed(2), listed(3)]);
    reading.mockResolvedValue([read(2)]);

    const page = await client().getOwnedObjects({
      owner: OWNER,
      filter: FILTER,
      options: { showContent: true },
      cursor: idOf(1),
      limit: 1,
    });

    expect(reading).toHaveBeenCalledWith([idOf(2)], { showContent: true }, { network: 'testnet' });
    expect(page.data).toEqual([read(2)]);
    expect(page.hasNextPage).toBe(true);
    expect(page.nextCursor).toBe(idOf(2));
  });
});
