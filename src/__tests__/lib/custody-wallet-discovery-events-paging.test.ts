/**
 * NJA-4086: the events tier of custody wallet discovery must page through
 * CustodyWalletCreated (follow nextCursor while hasNextPage) rather than read
 * only the oldest 50. Since NJA-3967 the reading client honours `limit` as
 * JSON-RPC did, so once more than 50 custody wallets exist, a newer circle's
 * wallet is never found in this tier and discovery falls through to nothing.
 *
 * Nothing here reaches the network: the client and the event reader are stubs.
 */
import type { SuiClient } from '@mysten/sui/client';
import { resolveCustodyWalletId } from '../../lib/custody-wallet-discovery';

const PKG = '0x' + '11'.repeat(32);
const CIRCLE = '0x' + 'c1'.repeat(32);
const WALLET = '0x' + 'aa'.repeat(32);
const EVENT_TYPE = `${PKG}::njangi_custody::CustodyWalletCreated`;

type EventCursor = { txDigest: string; eventSeq: string };
type StubEvent = { id: EventCursor; parsedJson: { circle_id: string; wallet_id: string } };

const hex32 = (n: number) => '0x' + n.toString(16).padStart(64, '0');

// 60 CustodyWalletCreated events, oldest first; the target circle's is the 55th.
const TARGET_INDEX = 54;
const EVENTS: StubEvent[] = Array.from({ length: 60 }, (_, i) => ({
  id: { txDigest: `tx${i + 1}`, eventSeq: '0' },
  parsedJson:
    i === TARGET_INDEX
      ? { circle_id: CIRCLE, wallet_id: WALLET }
      : { circle_id: hex32(0x1000 + i), wallet_id: hex32(0x2000 + i) },
}));

/**
 * Pages the list by the requested limit, resuming after the cursor's event,
 * exactly as the reading client does since NJA-3967 (reading-sui-client.ts
 * pageOfEvents): nextCursor is the last event returned, hasNextPage says
 * whether more follow, and an unknown cursor is a failed read.
 */
function pagedEventReader(events: StubEvent[]) {
  return jest.fn(
    async (params: {
      query: { MoveEventType: string };
      limit?: number | null;
      cursor?: EventCursor | null;
    }) => {
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
    },
  );
}

const custodyWalletObject = {
  data: {
    type: `${PKG}::njangi_custody::CustodyWallet`,
    content: { dataType: 'moveObject', fields: { circle_id: CIRCLE } },
  },
};

/**
 * A client on which every tier before the events answers nothing: the
 * wallet_id field holds the create-flow placeholder (the circle's own id) and
 * carries no previousTransaction, and the circle has no v11 asset policy.
 */
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

describe('custody wallet discovery — the events tier pages past the oldest 50 (NJA-4086)', () => {
  it('finds the 55th of 60 CustodyWalletCreated events when the reader pages by the requested limit', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const queryEvents = pagedEventReader(EVENTS);
    const client = makeClient();

    const result = await resolveCustodyWalletId({ client, circleId: CIRCLE, packageId: PKG, queryEvents });

    expect(queryEvents).toHaveBeenCalled();
    expect(queryEvents.mock.calls[0][0].query).toEqual({ MoveEventType: EVENT_TYPE });
    // On this commit the tier reads one page of 50, never follows nextCursor,
    // and resolveCustodyWalletId returns null: the wallet is 'unresolved'.
    expect(result).toEqual({ walletId: WALLET, source: 'events' });
  });
});
