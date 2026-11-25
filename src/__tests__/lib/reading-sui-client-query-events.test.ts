/**
 * NJA-3967 (Sui reads 1a): getReadingSuiClient().queryEvents must honour
 * order, then cursor (start after the event whose id equals the cursor), then
 * limit, and report nextCursor / hasNextPage. The crons (cycle-finalized,
 * whatsapp-circle-events, founding-badges) resume from a stored
 * {txDigest, eventSeq}; a client that ignores it hands back the whole list and
 * the cron re-processes old events (and resends old WhatsApp messages).
 *
 * The read layer (sui-read.ts queryEventsCached) is a stub that, like the real
 * one on the 2.x path, serves the WHOLE list as one page, oldest first (newest
 * first for 'descending'). The pooled client is a stub carrying a 2.x read
 * source. Nothing here reaches the network.
 */

jest.mock('../../services/network-config', () => ({ getCurrentNetwork: () => 'testnet' }));
jest.mock('../../services/sui-rpc-failover', () => ({ getPooledSuiClient: jest.fn() }));
jest.mock('../../lib/v2-sui-client', () => ({ v2TxTransports: jest.fn(), v2Reads: jest.fn() }));
jest.mock('../../lib/sui-read', () => ({
  readObject: jest.fn(),
  readObjects: jest.fn(),
  listDynamicFields: jest.fn(),
  readDynamicFieldObject: jest.fn(),
  queryEventsCached: jest.fn(),
}));

import { getPooledSuiClient } from '../../services/sui-rpc-failover';
import { queryEventsCached } from '../../lib/sui-read';
import { clearReadingSuiClients, getReadingSuiClient } from '../../lib/reading-sui-client';
import { attachV2ReadSource, type V2ReadSource } from '../../lib/v2-read-source';

const EVENT_TYPE = '0xcore::njangi_cycle_escrow::ContributionRecorded';
const QUERY = { MoveEventType: EVENT_TYPE };

/** The JSON-RPC-style id the crons store as their cursor. */
const idOf = (n: number) => ({ txDigest: `tx${n}`, eventSeq: '0' });

function stubEvent(n: number) {
  return {
    id: idOf(n),
    packageId: '0xcore',
    transactionModule: 'njangi_cycle_escrow',
    sender: '0x' + 'a1'.repeat(32),
    type: EVENT_TYPE,
    parsedJson: { n: String(n) },
    bcs: '',
    bcsEncoding: 'base64',
    timestampMs: String(1_000 * n),
  };
}

// Five events, oldest first.
const EVENTS = [1, 2, 3, 4, 5].map(stubEvent);

const client = () => getReadingSuiClient('testnet');

beforeEach(() => {
  clearReadingSuiClients();
  (getPooledSuiClient as jest.Mock).mockReturnValue(
    attachV2ReadSource(
      { getObject: jest.fn(), getTransactionBlock: jest.fn() },
      { network: 'testnet' } as V2ReadSource,
    ),
  );
  // As sui-read.ts does on the 2.x path: the whole list as one page, in the
  // order asked for, with no paging of its own.
  (queryEventsCached as jest.Mock).mockImplementation(
    async (params: { order?: 'ascending' | 'descending' }) => ({
      data: params.order === 'descending' ? [...EVENTS].reverse() : [...EVENTS],
      hasNextPage: false,
      nextCursor: null,
    }),
  );
});

describe("the reading client's queryEvents honours cursor, limit and order (NJA-3967)", () => {
  it('resumes after the cursor and stops at the limit: cursor = event 3, limit 2 -> events 4 and 5', async () => {
    const page = await client().queryEvents({ query: QUERY, cursor: idOf(3), limit: 2, order: 'ascending' });

    expect(page.data.map((e) => e.id)).toEqual([idOf(4), idOf(5)]);
    expect(page.nextCursor).toEqual(idOf(5));
    expect(page.hasNextPage).toBe(false);
  });

  it('says more follow when the limit stops short: cursor = event 3, limit 1 -> event 4, hasNextPage true', async () => {
    const page = await client().queryEvents({ query: QUERY, cursor: idOf(3), limit: 1, order: 'ascending' });

    expect(page.data.map((e) => e.id)).toEqual([idOf(4)]);
    expect(page.nextCursor).toEqual(idOf(4));
    expect(page.hasNextPage).toBe(true);
  });

  it('honours descending order: cursor = event 3, limit 2 -> events 2 and 1', async () => {
    const page = await client().queryEvents({ query: QUERY, cursor: idOf(3), limit: 2, order: 'descending' });

    expect(page.data.map((e) => e.id)).toEqual([idOf(2), idOf(1)]);
    expect(page.nextCursor).toEqual(idOf(1));
    expect(page.hasNextPage).toBe(false);
  });

  it('throws for a cursor that is not among the events the source returned: a failed read, never "no new events"', async () => {
    await expect(
      client().queryEvents({
        query: QUERY,
        cursor: { txDigest: 'tx-not-there', eventSeq: '0' },
        limit: 2,
        order: 'ascending',
      }),
    ).rejects.toThrow();
  });

  it('returns the whole list, as before, with no cursor and no limit', async () => {
    const page = await client().queryEvents({ query: QUERY });

    expect(page.data.map((e) => e.id)).toEqual(EVENTS.map((e) => e.id));
    expect(page.hasNextPage).toBe(false);
  });
});
