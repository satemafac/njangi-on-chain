// circle-membership-events.ts — the circle page's fallback membership check,
// read from MemberJoined / MemberRemoved events once the members table has
// verified the viewer absent (src/pages/circle/[id]/index.tsx verifyMembership).
//
// A read that fails is not a fact: an event list that could not be read to its
// end, or an event that cannot be read, is "unknown" (null), never "never
// joined" or "never removed". The caller turns a false answer into "You are no
// longer a member of this circle" and a redirect, so only a complete read may
// answer false.

import { queryEventsCached } from '@/lib/sui-read';

/** One page of an event scan, as queryEventsCached returns it. */
export type CircleEventPage = Awaited<ReturnType<typeof queryEventsCached>>;
export type CircleEvent = CircleEventPage['data'][number];
type EventQuery = (params: Parameters<typeof queryEventsCached>[0]) => Promise<CircleEventPage>;

/** Bound on each event scan: 20 pages of 100 events. */
export const MAX_EVENT_PAGES = 20;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * Every event of `eventType`, following `nextCursor` while `hasNextPage`.
 * Null when the list could not be read to its end (a next page without a new
 * cursor, or the bound hit first): the first page of a paginated list is not
 * the list. A page that cannot be read throws.
 */
export async function readEveryEvent(eventType: string, query: EventQuery = queryEventsCached): Promise<CircleEvent[] | null> {
  const events: CircleEvent[] = [];
  let cursor: CircleEventPage['nextCursor'] = null;
  for (let page = 1; page <= MAX_EVENT_PAGES; page += 1) {
    const result: CircleEventPage = await query({
      query: { MoveEventType: eventType },
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    if (!Array.isArray(result?.data)) {
      throw new Error(`[Membership] ${eventType} events: page ${page} carried no event list`);
    }
    events.push(...result.data);
    if (result.hasNextPage === false) return events;
    const next: CircleEventPage['nextCursor'] = result.nextCursor;
    if (result.hasNextPage !== true || !next || JSON.stringify(next) === JSON.stringify(cursor)) {
      console.warn(`[Membership] ${eventType} events: page ${page} gave no cursor to the next page`);
      return null;
    }
    cursor = next;
  }
  console.warn(`[Membership] ${eventType} events: stopped after ${MAX_EVENT_PAGES} pages, before the end`);
  return null;
}

/**
 * The times `member` appears in `circleId` among `events`. Null when an event
 * cannot be read (no string `circle_id` and `member` in its parsedJson, or one
 * of the member's events without a timestamp): an unread event is not "not
 * theirs".
 */
export function memberEventTimes(events: CircleEvent[], circleId: string, member: string): number[] | null {
  const times: number[] = [];
  for (const event of events) {
    const parsed = asRecord(event.parsedJson);
    const eventCircleId = parsed ? parsed.circle_id : undefined;
    const eventMember = parsed ? parsed.member : undefined;
    if (typeof eventCircleId !== 'string' || typeof eventMember !== 'string') {
      console.warn('[Membership] An event without a readable circle_id and member; membership unknown');
      return null;
    }
    if (eventCircleId !== circleId || eventMember !== member) continue;
    const timestampMs = event.timestampMs;
    if (typeof timestampMs !== 'string' || !/^\d+$/.test(timestampMs)) {
      console.warn(`[Membership] An event of ${member} in ${circleId} has no readable timestamp; membership unknown`);
      return null;
    }
    times.push(Number(timestampMs));
  }
  return times;
}

/**
 * The decision from complete join and removal times: never joined is false; joined
 * and never removed is true; removed after the last join is false; rejoined after
 * the last removal is true.
 */
export function membershipFromEventTimes(joinTimes: number[], removalTimes: number[]): boolean {
  if (joinTimes.length === 0) return false;
  if (removalTimes.length === 0) return true;
  return Math.max(...joinTimes) > Math.max(...removalTimes);
}
