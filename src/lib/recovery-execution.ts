import type { SuiClient, SuiEvent } from '@mysten/sui/client';

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

export async function loadRecoveryExecutionStatus(args: {
  client: RecoveryExecutionClient;
  packageId: string;
  circleId: string;
}): Promise<RecoveryExecutionStatus | null> {
  const { client, packageId, circleId } = args;
  const [startedEvents, memberRefundEvents, completedEvents] = await Promise.all([
    client.queryEvents({
      query: { MoveEventType: `${packageId}::njangi_circles::RecoveryExecutionStarted` },
      limit: 20,
    }),
    client.queryEvents({
      query: { MoveEventType: `${packageId}::njangi_circles::RecoveryMemberRefunded` },
      limit: 200,
    }),
    client.queryEvents({
      query: { MoveEventType: `${packageId}::njangi_circles::RecoveryExecutionCompleted` },
      limit: 20,
    }),
  ]);

  const latestStarted = [...startedEvents.data]
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
  const memberRefunds = memberRefundEvents.data
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

  const latestCompleted = [...completedEvents.data]
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

export async function loadRecoveryStablecoinCoinType(args: {
  client: RecoveryExecutionClient;
  packageId: string;
  circleId: string;
}): Promise<string | null> {
  const { client, packageId, circleId } = args;
  const [contributionEvents, depositEvents, walletEvents] = await Promise.all([
    client.queryEvents({
      query: { MoveEventType: `${packageId}::njangi_circles::StablecoinContributionMade` },
      limit: 50,
    }),
    client.queryEvents({
      query: { MoveEventType: `${packageId}::njangi_custody::StablecoinDepositWithPrice` },
      limit: 50,
    }),
    client.queryEvents({
      query: { MoveEventType: `${packageId}::njangi_custody::StablecoinHoldingUpdated` },
      limit: 50,
    }),
  ]);

  const latestStablecoinEvent = [
    ...contributionEvents.data,
    ...depositEvents.data,
    ...walletEvents.data,
  ]
    .filter((event) => matchesCircle(circleId, event))
    .sort((left, right) => Number(right.timestampMs || 0) - Number(left.timestampMs || 0))[0];

  if (!latestStablecoinEvent) {
    return null;
  }

  const fields = asRecord(latestStablecoinEvent.parsedJson);
  return typeof fields?.coin_type === 'string' && fields.coin_type.length > 0 ? fields.coin_type : null;
}
