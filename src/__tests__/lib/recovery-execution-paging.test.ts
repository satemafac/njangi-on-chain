/**
 * NJA-4085: loadRecoveryExecutionStatus (src/lib/recovery-execution.ts:77-90)
 * asks for RecoveryExecutionStarted (limit 20), RecoveryMemberRefunded
 * (limit 200) and RecoveryExecutionCompleted (limit 20) once each, ascending,
 * with no cursor, and filters that single page by circle. Since NJA-3967 the
 * reading client honours `limit` as JSON-RPC does (reading-sui-client.ts:115-119,
 * pageOfEvents :78-81): the call answers with the OLDEST `limit` events and
 * hasNextPage: true. Once a package holds more events than the limit, a newer
 * circle's events are never read: its recovery reads as null (:96-97), its
 * refunds as none (:106-107) and its completion as none (:129-131).
 *
 * The stub client below pages the way that client (and JSON-RPC) does: one
 * whole list per event type, ascending unless `order` says otherwise, `limit`
 * events per page (50 when none is given, as JSON-RPC defaults), nextCursor
 * the last event served, a cursor resuming right after it. No network.
 */
import { loadRecoveryExecutionStatus } from '../../lib/recovery-execution';

const PACKAGE_ID = '0x' + 'ab'.repeat(32);
const TARGET_CIRCLE = '0x' + 'c3'.repeat(32);
const OTHER_CIRCLE = '0x' + 'd4'.repeat(32);
const ADMIN = '0x' + 'ad'.repeat(32);
const OTHER_MEMBER = '0x' + 'ee'.repeat(32);
const STARTED_AT = 1_700_000_000_000;
const DEFAULT_PAGE_SIZE = 50;

const memberAt = (i: number) => '0x' + (i + 1).toString(16).padStart(64, '0');
const eventType = (name: string) => `${PACKAGE_ID}::njangi_circles::${name}`;
const STARTED = eventType('RecoveryExecutionStarted');
const REFUNDED = eventType('RecoveryMemberRefunded');
const COMPLETED = eventType('RecoveryExecutionCompleted');

interface EventId {
  txDigest: string;
  eventSeq: string;
}

interface StubEvent {
  id: EventId;
  type: string;
  timestampMs: string;
  parsedJson: Record<string, unknown>;
}

const makeEvent = (type: string, seq: number, timestampMs: number, fields: Record<string, unknown>): StubEvent => ({
  id: { txDigest: `${type}#${seq}`, eventSeq: '0' },
  type,
  timestampMs: String(timestampMs),
  parsedJson: { ...fields, timestamp: String(timestampMs) },
});

const started = (seq: number, circleId: string, timestampMs: number): StubEvent =>
  makeEvent(STARTED, seq, timestampMs, {
    circle_id: circleId,
    executor: ADMIN,
    member_count: '5',
    total_sui_refund: '3000000000',
    total_stablecoin_refund: '0',
    used_auto_release: false,
    trigger_role: '1',
  });

const refunded = (seq: number, circleId: string, member: string, timestampMs: number): StubEvent =>
  makeEvent(REFUNDED, seq, timestampMs, {
    circle_id: circleId,
    member,
    sui_contributions_refunded: '0',
    sui_deposit_refunded: '600000000',
    stablecoin_contributions_refunded: '0',
    stablecoin_deposit_refunded: '0',
  });

const completed = (seq: number, circleId: string, refundedMembers: number, timestampMs: number): StubEvent =>
  makeEvent(COMPLETED, seq, timestampMs, {
    circle_id: circleId,
    executor: ADMIN,
    refunded_members: String(refundedMembers),
    total_sui_refund: '3000000000',
    total_stablecoin_refund: '0',
  });

interface QueryEventsArgs {
  query: { MoveEventType?: string };
  cursor?: EventId | null;
  limit?: number | null;
  order?: 'ascending' | 'descending';
}

/**
 * A queryEvents over `lists` (whole, ascending, keyed by MoveEventType) that
 * pages as reading-sui-client's pageOfEvents and JSON-RPC do. `failPage`
 * names a (type, zero-based page index) whose read fails.
 */
function pagingQueryEvents(lists: Record<string, StubEvent[]>, failPage?: (type: string, page: number) => boolean) {
  const pagesServed = new Map<string, number>();
  return jest.fn(async ({ query, cursor, limit, order }: QueryEventsArgs) => {
    const type = query.MoveEventType ?? '';
    const whole = lists[type];
    if (!whole) throw new Error(`stub: no events stubbed for ${JSON.stringify(query)}`);
    const page = pagesServed.get(type) ?? 0;
    pagesServed.set(type, page + 1);
    if (failPage?.(type, page)) throw new Error('every endpoint refused the read');
    const ordered = order === 'descending' ? [...whole].reverse() : whole;
    let start = 0;
    if (cursor) {
      const at = ordered.findIndex((e) => e.id.txDigest === cursor.txDigest && e.id.eventSeq === cursor.eventSeq);
      if (at < 0) throw new Error(`stub: cursor ${cursor.txDigest} is not among the events`);
      start = at + 1;
    }
    const pageSize = limit ?? DEFAULT_PAGE_SIZE;
    const end = Math.min(ordered.length, start + pageSize);
    const data = ordered.slice(start, end);
    const last = data[data.length - 1];
    return { data, hasNextPage: end < ordered.length, nextCursor: last ? last.id : (cursor ?? null) };
  });
}

const load = (queryEvents: unknown) =>
  loadRecoveryExecutionStatus({ client: { queryEvents } as never, packageId: PACKAGE_ID, circleId: TARGET_CIRCLE });

describe('loadRecoveryExecutionStatus reads past the first page of each event list (NJA-4085)', () => {
  it("returns the circle's status when its RecoveryExecutionStarted is the 25th of 25 (past the limit of 20)", async () => {
    const olderOtherCircles = Array.from({ length: 24 }, (_, i) => started(i, OTHER_CIRCLE, STARTED_AT - 100_000 + i));
    const queryEvents = pagingQueryEvents({
      [STARTED]: [...olderOtherCircles, started(24, TARGET_CIRCLE, STARTED_AT)],
      [REFUNDED]: [refunded(0, TARGET_CIRCLE, memberAt(0), STARTED_AT + 1_000)],
      [COMPLETED]: [],
    });

    // Fails on this commit: the one call (limit 20, no cursor) serves the 20
    // oldest events, all the other circle's, so the status is null.
    await expect(load(queryEvents)).resolves.toEqual({
      startedAt: STARTED_AT,
      completedAt: null,
      executor: ADMIN,
      refundedMembers: 1,
      totalMembers: 5,
      totalSuiRefundRaw: 3000000000n,
      totalStablecoinRefundRaw: 0n,
      usedAutoRelease: false,
      triggerRole: 'delegate',
      memberRefunds: [
        { member: memberAt(0), timestamp: STARTED_AT + 1_000, suiRefundRaw: 600000000n, stablecoinRefundRaw: 0n },
      ],
    });
  });

  it("reads the circle's RecoveryMemberRefunded events that lie past the 200th", async () => {
    const members = Array.from({ length: 5 }, (_, i) => memberAt(i));
    const olderOtherRefunds = Array.from({ length: 200 }, (_, i) =>
      refunded(i, OTHER_CIRCLE, OTHER_MEMBER, STARTED_AT - 50_000 + i),
    );
    const targetRefunds = members.map((member, i) => refunded(200 + i, TARGET_CIRCLE, member, STARTED_AT + 1_000 + i));
    const queryEvents = pagingQueryEvents({
      [STARTED]: [started(0, TARGET_CIRCLE, STARTED_AT)],
      [REFUNDED]: [...olderOtherRefunds, ...targetRefunds],
      [COMPLETED]: [],
    });

    const status = await load(queryEvents);

    // Fails on this commit: the first 200 refunds are the other circle's, so
    // memberRefunds is [] and refundedMembers 0 for a circle refunded 5 times.
    expect(status).not.toBeNull();
    expect(status?.memberRefunds.map((refund) => refund.member)).toEqual([...members].reverse());
    expect(status?.refundedMembers).toBe(5);
  });

  it("reads the circle's RecoveryExecutionCompleted when it is the 25th of 25 (past the limit of 20)", async () => {
    const olderOtherCompletions = Array.from({ length: 24 }, (_, i) =>
      completed(i, OTHER_CIRCLE, 3, STARTED_AT - 10_000 + i),
    );
    const queryEvents = pagingQueryEvents({
      [STARTED]: [started(0, TARGET_CIRCLE, STARTED_AT)],
      [REFUNDED]: [refunded(0, TARGET_CIRCLE, memberAt(0), STARTED_AT + 1_000)],
      [COMPLETED]: [...olderOtherCompletions, completed(24, TARGET_CIRCLE, 5, STARTED_AT + 5_000)],
    });

    // Fails on this commit: completedAt is null and refundedMembers 1 (counted
    // from the one refund), although the completion summary was emitted.
    await expect(load(queryEvents)).resolves.toMatchObject({ completedAt: STARTED_AT + 5_000, refundedMembers: 5 });
  });

  it('throws when a later page cannot be read, never answering with the first page as the whole list', async () => {
    // 205 refunds, all this circle's and all after startedAt: whichever
    // direction the pages are read in, the second page is needed.
    const targetRefunds = Array.from({ length: 205 }, (_, i) =>
      refunded(i, TARGET_CIRCLE, memberAt(i), STARTED_AT + 1_000 + i),
    );
    const queryEvents = pagingQueryEvents(
      {
        [STARTED]: [started(0, TARGET_CIRCLE, STARTED_AT)],
        [REFUNDED]: targetRefunds,
        [COMPLETED]: [],
      },
      (type, page) => type === REFUNDED && page >= 1,
    );

    // Fails on this commit: the second page is never asked for, so the call
    // resolves with 200 of 205 refunds instead of throwing.
    await expect(load(queryEvents)).rejects.toThrow('every endpoint refused the read');
  });
});
