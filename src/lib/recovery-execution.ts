// recovery-execution.ts — what an executed emergency stop / auto-release did,
// read from the events execute_recovery itself emits.
//
// The coin type a recovery unwinds is deliberately not derived here any
// more: read it from the custody wallet with resolveRecoveryCoinType
// (recovery-coin-type.ts). The event-derived version scanned
// StablecoinContributionMade (legacy rail only), StablecoinDepositWithPrice
// (carries the literal "stablecoin", not a type) and StablecoinHoldingUpdated
// (an unprefixed type name).

import type { EventId, PaginatedEvents, SuiClient, SuiEvent } from '@mysten/sui/client';

export interface RecoveryMemberRefundSummary {
  member: string;
  timestamp: number;
  suiRefundRaw: bigint;
  stablecoinRefundRaw: bigint;
}

export interface RecoveryExecutionStatus {
  startedAt: number;
  completedAt: number | null;
  executor: string;
  refundedMembers: number;
  totalMembers: number;
  totalSuiRefundRaw: bigint;
  totalStablecoinRefundRaw: bigint;
  usedAutoRelease: boolean;
  triggerRole: 'vote_execution' | 'delegate' | 'member_fallback' | null;
  memberRefunds: RecoveryMemberRefundSummary[];
}

type RecoveryExecutionClient = Pick<SuiClient, 'queryEvents'>;

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
};

const parseU64Like = (value: unknown): bigint => {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.max(0, Math.trunc(value)));
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  return 0n;
};

const parseMoveBool = (value: unknown): boolean => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  return false;
};

const parseRecoveryTriggerRole = (
  value: unknown,
): RecoveryExecutionStatus['triggerRole'] => {
  const numericValue = Number(parseU64Like(value));
  if (numericValue === 0) return 'vote_execution';
  if (numericValue === 1) return 'delegate';
  if (numericValue === 2) return 'member_fallback';
  return null;
};

const matchesCircle = (circleId: string, event: SuiEvent): boolean => {
  const parsed = asRecord(event.parsedJson);
  return typeof parsed?.circle_id === 'string' && parsed.circle_id.toLowerCase() === circleId.toLowerCase();
};

const isEventId = (value: unknown): value is EventId => {
  const record = asRecord(value);
  return typeof record?.txDigest === 'string' && typeof record.eventSeq === 'string';
};

/**
 * Every event of `moveEventType`, read `pageSize` at a time from the oldest,
 * following nextCursor until a page says hasNextPage: false. The reading
 * client pages as JSON-RPC does, so one call answers with the first page
 * only. Fails closed: a page that cannot be read rejects as it is, and a
 * page whose data is not a list, whose hasNextPage is not a boolean, or that
 * says more follow without a cursor that moves past it throws, rather than
 * pass the events read so far off as the whole list.
 */
async function readAllEvents(
  client: RecoveryExecutionClient,
  moveEventType: string,
  pageSize: number,
): Promise<SuiEvent[]> {
  const what = `[recovery-execution] ${moveEventType}`;
  const events: SuiEvent[] = [];
  let cursor: EventId | null = null;
  for (;;) {
    const page: PaginatedEvents | null | undefined = await client.queryEvents({
      query: { MoveEventType: moveEventType },
      ...(cursor ? { cursor } : {}),
      limit: pageSize,
      order: 'ascending',
    });
    if (!page || !Array.isArray(page.data)) {
      throw new Error(`${what}: a page of events did not come back as a list`);
    }
    // Only an explicit false ends the list: a missing or malformed
    // hasNextPage does not prove the events read so far are all of them.
    const hasNextPage: unknown = page.hasNextPage;
    if (typeof hasNextPage !== 'boolean') {
      throw new Error(`${what}: a page of events did not say whether more follow`);
    }
    events.push(...page.data);
    if (hasNextPage === false) return events;
    const next: unknown = page.nextCursor;
    if (
      !isEventId(next) ||
      (cursor !== null && next.txDigest === cursor.txDigest && next.eventSeq === cursor.eventSeq)
    ) {
      throw new Error(`${what}: a page says more events follow but no cursor moves past it`);
    }
    cursor = { txDigest: next.txDigest, eventSeq: next.eventSeq };
  }
}

export async function loadRecoveryExecutionStatus(args: {
  client: RecoveryExecutionClient;
  packageId: string;
  circleId: string;
}): Promise<RecoveryExecutionStatus | null> {
  const { client, packageId, circleId } = args;
  // Each list is read whole (every page, readAllEvents), so a circle's events
  // are found however many other circles emitted; a page that cannot be read
  // rejects the call, which callers show as a read failure, not as none.
  const [startedEvents, memberRefundEvents, completedEvents] = await Promise.all([
    readAllEvents(client, `${packageId}::njangi_circles::RecoveryExecutionStarted`, 20),
    readAllEvents(client, `${packageId}::njangi_circles::RecoveryMemberRefunded`, 200),
    readAllEvents(client, `${packageId}::njangi_circles::RecoveryExecutionCompleted`, 20),
  ]);

  const latestStarted = [...startedEvents]
    .filter((event) => matchesCircle(circleId, event))
    .sort((left, right) => Number(right.timestampMs || 0) - Number(left.timestampMs || 0))[0];

  if (!latestStarted) {
    return null;
  }

  const startedFields = asRecord(latestStarted.parsedJson);
  if (!startedFields || typeof startedFields.executor !== 'string') {
    return null;
  }

  const startedAt = Number(parseU64Like(startedFields.timestamp));
  const memberRefunds = memberRefundEvents
    .filter((event) => matchesCircle(circleId, event))
    .map((event) => {
      const parsed = asRecord(event.parsedJson);
      if (!parsed || typeof parsed.member !== 'string') {
        return null;
      }

      const timestamp = Number(parseU64Like(parsed.timestamp));
      return {
        member: parsed.member,
        timestamp,
        suiRefundRaw:
          parseU64Like(parsed.sui_contributions_refunded) + parseU64Like(parsed.sui_deposit_refunded),
        stablecoinRefundRaw:
          parseU64Like(parsed.stablecoin_contributions_refunded) +
          parseU64Like(parsed.stablecoin_deposit_refunded),
      };
    })
    .filter((entry): entry is RecoveryMemberRefundSummary => entry !== null)
    .filter((entry) => entry.timestamp >= startedAt)
    .sort((left, right) => right.timestamp - left.timestamp);

  const latestCompleted = [...completedEvents]
    .filter((event) => matchesCircle(circleId, event))
    .sort((left, right) => Number(right.timestampMs || 0) - Number(left.timestampMs || 0))[0];
  const completedFields = asRecord(latestCompleted?.parsedJson);
  const refundedMembers = completedFields
    ? Number(parseU64Like(completedFields.refunded_members))
    : new Set(memberRefunds.map((refund) => refund.member.toLowerCase())).size;

  return {
    startedAt,
    completedAt: completedFields ? Number(parseU64Like(completedFields.timestamp)) : null,
    executor: startedFields.executor,
    refundedMembers,
    totalMembers: Number(parseU64Like(startedFields.member_count)),
    totalSuiRefundRaw: parseU64Like(startedFields.total_sui_refund),
    totalStablecoinRefundRaw: parseU64Like(startedFields.total_stablecoin_refund),
    usedAutoRelease: parseMoveBool(startedFields.used_auto_release),
    triggerRole: parseRecoveryTriggerRole(startedFields.trigger_role),
    memberRefunds,
  };
}
