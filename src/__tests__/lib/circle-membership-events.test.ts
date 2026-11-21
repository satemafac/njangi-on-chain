/**
 * The circle page's fallback membership check from MemberJoined / MemberRemoved events (circle page part 1,
 * NJA-3600; the independent review's finding): a join or a removal on a later page is found, and a list that
 * could not be read to its end, or an event that cannot be read, is unknown (null), never "not a member".
 */
import {
  MAX_EVENT_PAGES,
  memberEventTimes,
  membershipFromEventTimes,
  readEveryEvent,
  type CircleEvent,
  type CircleEventPage,
} from '@/lib/circle-membership-events';

jest.mock('@/lib/sui-read', () => ({ queryEventsCached: jest.fn() }));

const CIRCLE = '0x' + 'c1'.repeat(32);
const OTHER_CIRCLE = '0x' + 'c2'.repeat(32);
const ME = '0x' + 'a1'.repeat(32);
const SOMEONE = '0x' + 'b2'.repeat(32);
const JOINED = '0xpkg::njangi_circles::MemberJoined';

const event = (circleId: string, member: string, timestampMs: string | null = '1000'): CircleEvent =>
  ({ parsedJson: { circle_id: circleId, member }, ...(timestampMs === null ? {} : { timestampMs }) }) as unknown as CircleEvent;

const page = (data: CircleEvent[], hasNextPage: boolean, nextCursor: CircleEventPage['nextCursor'] = null): CircleEventPage => ({
  data,
  hasNextPage,
  nextCursor,
});

beforeEach(() => jest.spyOn(console, 'warn').mockImplementation(() => undefined));
afterEach(() => jest.restoreAllMocks());

describe('readEveryEvent', () => {
  it('reads every page, so a join on a later page is in the list', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce(page([event(OTHER_CIRCLE, SOMEONE)], true, { txDigest: 'a', eventSeq: '1' }))
      .mockResolvedValueOnce(page([event(OTHER_CIRCLE, SOMEONE)], true, { txDigest: 'b', eventSeq: '1' }))
      .mockResolvedValueOnce(page([event(CIRCLE, ME, '3000')], false));

    const events = await readEveryEvent(JOINED, query);

    expect(events).toHaveLength(3);
    expect(memberEventTimes(events!, CIRCLE, ME)).toEqual([3000]);
    expect(query.mock.calls.map(([params]) => params.cursor ?? null)).toEqual([
      null,
      { txDigest: 'a', eventSeq: '1' },
      { txDigest: 'b', eventSeq: '1' },
    ]);
    expect(query.mock.calls[0]![0]).toEqual({ query: { MoveEventType: JOINED }, limit: 100 });
  });

  it('is unknown (null) when a page says more follow but gives no cursor', async () => {
    const query = jest.fn().mockResolvedValueOnce(page([event(CIRCLE, SOMEONE)], true, null));
    await expect(readEveryEvent(JOINED, query)).resolves.toBeNull();
  });

  it('is unknown (null) when the next cursor repeats the last one', async () => {
    const cursor = { txDigest: 'a', eventSeq: '1' };
    const query = jest
      .fn()
      .mockResolvedValueOnce(page([event(CIRCLE, SOMEONE)], true, cursor))
      .mockResolvedValueOnce(page([event(CIRCLE, SOMEONE)], true, cursor));
    await expect(readEveryEvent(JOINED, query)).resolves.toBeNull();
  });

  it('is unknown (null) when the page bound is reached before the end', async () => {
    let n = 0;
    const query = jest.fn(async () => page([event(OTHER_CIRCLE, SOMEONE)], true, { txDigest: `t${(n += 1)}`, eventSeq: '1' }));
    await expect(readEveryEvent(JOINED, query)).resolves.toBeNull();
    expect(query).toHaveBeenCalledTimes(MAX_EVENT_PAGES);
  });

  it('throws when a later page fails or carries no event list, never returning the pages before it', async () => {
    const failing = jest
      .fn()
      .mockResolvedValueOnce(page([event(CIRCLE, ME)], true, { txDigest: 'a', eventSeq: '1' }))
      .mockRejectedValueOnce(new Error('Sui JSON-RPC endpoint has been deprecated'));
    await expect(readEveryEvent(JOINED, failing)).rejects.toThrow('deprecated');

    const empty = jest
      .fn()
      .mockResolvedValueOnce(page([event(CIRCLE, ME)], true, { txDigest: 'a', eventSeq: '1' }))
      .mockResolvedValueOnce({ hasNextPage: false, nextCursor: null });
    await expect(readEveryEvent(JOINED, empty)).rejects.toThrow('carried no event list');
  });
});

describe('memberEventTimes', () => {
  it("keeps only the member's events in the circle", () => {
    const events = [event(CIRCLE, ME, '1000'), event(CIRCLE, SOMEONE, '1500'), event(OTHER_CIRCLE, ME, '1700'), event(CIRCLE, ME, '2000')];
    expect(memberEventTimes(events, CIRCLE, ME)).toEqual([1000, 2000]);
    expect(memberEventTimes([event(CIRCLE, SOMEONE)], CIRCLE, ME)).toEqual([]);
  });

  it('is unknown (null) when any event has no readable circle_id and member', () => {
    const unreadable = { parsedJson: { circle_id: CIRCLE } } as unknown as CircleEvent;
    expect(memberEventTimes([event(CIRCLE, SOMEONE), unreadable], CIRCLE, ME)).toBeNull();
  });

  it("is unknown (null) when one of the member's events has no readable timestamp", () => {
    expect(memberEventTimes([event(CIRCLE, ME, null)], CIRCLE, ME)).toBeNull();
    expect(memberEventTimes([event(CIRCLE, ME, 'soon')], CIRCLE, ME)).toBeNull();
  });
});

describe('membershipFromEventTimes', () => {
  it('never joined is not a member', () => {
    expect(membershipFromEventTimes([], [])).toBe(false);
    expect(membershipFromEventTimes([], [5000])).toBe(false);
  });

  it('joined and never removed is a member', () => {
    expect(membershipFromEventTimes([1000], [])).toBe(true);
  });

  it('removed after the last join is not a member; rejoined after the last removal is', () => {
    expect(membershipFromEventTimes([1000], [2000])).toBe(false);
    expect(membershipFromEventTimes([1000, 3000], [2000])).toBe(true);
  });

  it('a removal found only on a later page still counts', async () => {
    const joins = await readEveryEvent(JOINED, jest.fn().mockResolvedValueOnce(page([event(CIRCLE, ME, '1000')], false)));
    const removals = await readEveryEvent(
      '0xpkg::njangi_circles::MemberRemoved',
      jest
        .fn()
        .mockResolvedValueOnce(page([event(OTHER_CIRCLE, SOMEONE, '1500')], true, { txDigest: 'a', eventSeq: '1' }))
        .mockResolvedValueOnce(page([event(CIRCLE, ME, '2000')], false)),
    );
    expect(membershipFromEventTimes(memberEventTimes(joins!, CIRCLE, ME)!, memberEventTimes(removals!, CIRCLE, ME)!)).toBe(false);
  });
});
