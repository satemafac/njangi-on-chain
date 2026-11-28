/**
 * NJA-4086: the events tier of custody wallet discovery reads CustodyWalletCreated
 * to its last page, and never lets a partial read pass for an answer. Only the
 * last page, searched without a hit, means "not in the events"; a page that fails
 * or a next page without a new cursor is a read failure — warned, and the wallet
 * stays unresolved (null) so the later tiers still try.
 *
 * Nothing here reaches the network: the client and the event reader are stubs.
 */
import type { SuiClient } from '@mysten/sui/client';
import { resolveCustodyWalletId } from '../../lib/custody-wallet-discovery';

const PKG = '0x' + '11'.repeat(32);
const CIRCLE = '0x' + 'c1'.repeat(32);
const WALLET = '0x' + 'aa'.repeat(32);
const EVENTS_WARNING = '[custody-discovery] events read failed; wallet unresolved';

type EventCursor = { txDigest: string; eventSeq: string };
type StubEvent = { id: EventCursor; parsedJson: { circle_id: string; wallet_id: string } };
type ReaderParams = {
  query: { MoveEventType: string };
  limit?: number | null;
  cursor?: EventCursor | null;
};

const hex32 = (n: number) => '0x' + n.toString(16).padStart(64, '0');

/** `count` events, oldest first; the target circle's is at `targetIndex` (null: none). */
function makeEvents(count: number, targetIndex: number | null): StubEvent[] {
  return Array.from({ length: count }, (_, i) => ({
    id: { txDigest: `tx${i + 1}`, eventSeq: '0' },
    parsedJson:
      i === targetIndex
        ? { circle_id: CIRCLE, wallet_id: WALLET }
        : { circle_id: hex32(0x1000 + i), wallet_id: hex32(0x2000 + i) },
  }));
}

/** Pages by the requested limit, resuming after the cursor, as pageOfEvents does. */
function pagedEventReader(events: StubEvent[]) {
  return jest.fn(async (params: ReaderParams) => {
    const cursor = params.cursor ?? null;
    let start = 0;
    if (cursor !== null) {
      const at = events.findIndex(
        (e) => e.id.txDigest === cursor.txDigest && e.id.eventSeq === cursor.eventSeq,
      );
      if (at < 0) throw new Error(`cursor ${cursor.txDigest}#${cursor.eventSeq} is not among the events`);
      start = at + 1;
    }
    const limit = params.limit ?? events.length;
    const end = Math.min(events.length, start + limit);
    const data = events.slice(start, end);
    const last = data[data.length - 1];
    return { data, hasNextPage: end < events.length, nextCursor: last ? last.id : cursor };
  });
}

const custodyWalletObject = {
  data: {
    type: `${PKG}::njangi_custody::CustodyWallet`,
    content: { dataType: 'moveObject', fields: { circle_id: CIRCLE } },
  },
};

/** A client on which every tier before the events answers nothing. */
function makeClient(): SuiClient {
  return {
    getObject: jest.fn(async ({ id }: { id: string }) =>
      id === WALLET ? custodyWalletObject : { error: { code: 'notExists', object_id: id } },
    ),
    getDynamicFieldObject: jest.fn(async () => ({
      data: { content: { dataType: 'moveObject', fields: { name: 'wallet_id', value: CIRCLE } } },
    })),
    getDynamicFields: jest.fn(async () => ({ data: [], hasNextPage: false, nextCursor: null })),
    getTransactionBlock: jest.fn().mockRejectedValue(new Error('must not be reached: no creation digest')),
    queryEvents: jest.fn().mockRejectedValue(new Error('must not be reached: the injected reader serves events')),
    queryTransactionBlocks: jest.fn(async () => ({ data: [] })),
  } as unknown as SuiClient;
}

type InjectedReader = Parameters<typeof resolveCustodyWalletId>[0]['queryEvents'];

const resolve = (queryEvents: InjectedReader) =>
  resolveCustodyWalletId({ client: makeClient(), circleId: CIRCLE, packageId: PKG, queryEvents });

const silenceWarnings = () => jest.spyOn(console, 'warn').mockImplementation(() => undefined);

describe('custody wallet discovery — the events tier reads to the last page or fails honestly (NJA-4086)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('stops reading as soon as the circle is found', async () => {
    silenceWarnings();
    const queryEvents = pagedEventReader(makeEvents(60, 3));

    const result = await resolve(queryEvents);

    expect(result).toEqual({ walletId: WALLET, source: 'events' });
    expect(queryEvents).toHaveBeenCalledTimes(1);
  });

  it('searches every page before answering that the events do not name the circle', async () => {
    const warn = silenceWarnings();
    const queryEvents = pagedEventReader(makeEvents(120, null));

    const result = await resolve(queryEvents);

    expect(result).toBeNull();
    expect(queryEvents.mock.calls.map(([params]) => params.cursor ?? null)).toEqual([
      null,
      { txDigest: 'tx50', eventSeq: '0' },
      { txDigest: 'tx100', eventSeq: '0' },
    ]);
    expect(warn).not.toHaveBeenCalledWith(EVENTS_WARNING, expect.anything());
  });

  it('treats a next page without a new cursor as a failed read, not as absent', async () => {
    const warn = silenceWarnings();
    const page = makeEvents(50, null);
    const queryEvents = jest.fn(async (params: ReaderParams) => ({
      data: page,
      hasNextPage: true,
      nextCursor: params.cursor ?? page[page.length - 1].id,
    }));

    const result = await resolve(queryEvents);

    expect(result).toBeNull();
    expect(queryEvents).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(EVENTS_WARNING, expect.objectContaining({ circleId: CIRCLE }));
  });

  it('treats a failed later page as a failed read, not as absent', async () => {
    const warn = silenceWarnings();
    const paged = pagedEventReader(makeEvents(60, 54));
    const queryEvents = jest.fn(async (params: ReaderParams) => {
      if (params.cursor) throw new Error('429 Too Many Requests');
      return paged(params);
    });

    const result = await resolve(queryEvents);

    expect(result).toBeNull();
    expect(queryEvents).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(EVENTS_WARNING, expect.objectContaining({ circleId: CIRCLE }));
  });
});
