// circle-record.ts — the member's own verifiable participation history.
//
// WHAT THIS IS FOR
//
// Millions of people have decades of flawless njangi payment history and
// nothing to show for it: the record lives in a notebook nobody else will
// accept. This turns the history the product already produces into
// something the member holds and can choose to show.
//
// WHAT IT IS NOT — and these are compliance boundaries, not scope cuts:
//
//   * No score, rating, tier or grade. Facts only.
//   * We never furnish it to anyone. The member is the sole distributor.
//     Assembling consumer information and furnishing it to third parties
//     for credit / employment / housing decisions is what makes an entity
//     a consumer reporting agency under FCRA; not scoring and not
//     furnishing is what keeps us outside that.
//   * It never makes a NEGATIVE claim. Ambiguity produces silence, not an
//     accusation — a false "missed a payment" is a reputational statement
//     about a real person and is the worst bug this feature could have.
//
// WHY IT READS WHAT IT READS
//
// The obvious source — per-cycle contribution rows — is not durably
// enumerable today, and the aggregates that look like they'd work do not:
//
//   * `Member.total_contributed` is only written by njangi_payments (the
//     legacy rail, gated off) and njangi_circles::contribute_stablecoin.
//     njangi_cycle_escrow — the LIVE rail — never touches `members::`, so
//     for escrow-rail circles this figure is always 0.
//   * `Member.missed_payments`, `reputation_score` and
//     `consecutive_on_time_payments` are never assigned anywhere in the
//     contracts. They are structurally always 0. Do not surface them.
//   * `CycleEscrow.contributed` IS durable per cycle, but for circles that
//     predate v1.1 nothing on chain links a Circle to its past escrow
//     objects (`open_cycle` takes an immutable &Circle, and Sui upgrades
//     forbid changing that signature). v1.1 added NEW `open_cycle*_indexed`
//     entries taking &mut Circle that append each escrow's id to a
//     FIELD_ESCROW_HISTORY dynamic field, plus `contribute_timed*` entries
//     recording per-member timestamps — so cycles run through those paths
//     ARE enumerable and carry on-time evidence (readOnTimeEvidence below).
//     Cycles that predate them still are not, and render as "no data".
//
// The load-bearing insight that makes a pure-object-read record possible:
// `finalize` asserts `contributors_count >= required_contributors`
// (njangi_cycle_escrow.move:918), so **a round cannot complete unless it
// was fully funded**. `Circle.rotation_history` is append-only and never
// reset (njangi_circles.move:2927), so its length is the count of
// completed, fully-funded rounds, and a member's presence in it is proof
// they received a payout at that position.
//
// So everything below is a pure object read: owned membership receipts,
// the Circle object, the members table, and (post-v1.1) the escrow history
// field and its escrows. No event scans anywhere, and no dependence on
// fields the contracts never write.

import { getCurrentNetwork, type NetworkType } from '@/services/network-config';
import { getPooledSuiClient } from '@/services/sui-rpc-failover';
import { discoverMemberCircleIds } from './membership-discovery';
import { getPublishedPackageMetadata } from './circle-chain';
import { cachedRead } from './sui-read';

export interface CircleOnTime {
  /** Cycles carrying a recorded per-member timestamp for this member. */
  recorded: number;
  /** Of those, contributions that landed at or before the cycle's due time. */
  onTime: number;
}

export interface CircleRecordEntry {
  circleId: string;
  circleName: string | null;
  /** From the member's own row in the circle's members table. */
  joinedAtMs: number | null;
  /** Verified against the members table, not just the receipt. */
  isCurrentMember: boolean;
  /** Completed, fully-funded rounds this circle has run. */
  completedRounds: number;
  /**
   * 1-based round at which this member received the pot, or null if their
   * turn has not come up yet. Proven by their address's position in
   * rotation_history.
   */
  payoutRound: number | null;
  /** Scheduled place in the rotation, 1-based, if assigned. */
  rotationPosition: number | null;
  memberCount: number | null;
  currentCycle: number | null;
  /**
   * On-time evidence from the v1.1 timed entry points, or null when the
   * circle has no recorded data (predates the upgrade, or its opens never
   * used the indexed path). Null must render as NOTHING — absence of a
   * record is never evidence of anything.
   */
  onTime: CircleOnTime | null;
}

export interface CircleRecordSummary {
  circlesJoined: number;
  payoutsReceived: number;
  /** Sum of completed rounds across the member's circles. */
  completedRoundsAcrossCircles: number;
  /**
   * Rounds this member is PROVEN to have participated in: for a member who
   * has been paid at round K, rounds 1..K all completed while they were in
   * the rotation, and each required full funding. Summed across circles.
   * Deliberately conservative — it never counts rounds we cannot prove.
   */
  provenParticipatedRounds: number;
  earliestJoinedAtMs: number | null;
}

export interface CircleRecord {
  address: string;
  generatedAtMs: number;
  network: NetworkType;
  circles: CircleRecordEntry[];
  summary: CircleRecordSummary;
  /** Object ids a recipient can check on a public explorer themselves. */
  verificationObjectIds: string[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function parseU64(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

function normalizeAddress(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.startsWith('0x') ? trimmed : null;
}

/**
 * Sui renders a `vector<address>` as a plain array of strings, but wrapped
 * shapes show up depending on the RPC/serialization path. Normalize both.
 */
function parseAddressVector(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : Array.isArray(asRecord(value)?.fields)
      ? (asRecord(value)?.fields as unknown[])
      : [];
  return raw.map(normalizeAddress).filter((a): a is string => a !== null);
}

interface CircleChainState {
  name: string | null;
  rotationHistory: string[];
  rotationOrder: string[];
  currentCycle: number | null;
  memberCount: number | null;
  membersTableId: string | null;
}

async function readCircleState(
  circleId: string,
  network: NetworkType,
): Promise<CircleChainState | null> {
  return cachedRead(`circle-record:circle:${network}:${circleId}`, async () => {
    const client = getPooledSuiClient({ network });
    const obj = await client.getObject({ id: circleId, options: { showContent: true } });
    const content = obj.data?.content;
    if (!content || content.dataType !== 'moveObject') return null;
    const fields = asRecord((content as { fields?: unknown }).fields);
    if (!fields) return null;

    const membersRecord = asRecord(fields.members);
    const membersInner = asRecord(membersRecord?.fields) ?? membersRecord;
    const membersIdRecord = asRecord(membersInner?.id);

    return {
      name: typeof fields.name === 'string' ? fields.name : null,
      rotationHistory: parseAddressVector(fields.rotation_history),
      rotationOrder: parseAddressVector(fields.rotation_order),
      currentCycle: parseU64(fields.current_cycle),
      memberCount: parseU64(fields.current_members),
      membersTableId:
        typeof membersIdRecord?.id === 'string' ? membersIdRecord.id : null,
    };
  });
}

interface MemberRow {
  joinedAtMs: number | null;
  payoutPosition: number | null;
}

/**
 * The member's own row. Absence is meaningful: a membership receipt can
 * outlive a removal, so the receipt is only a discovery hint and this is
 * the verification step (see membership-discovery.ts).
 *
 * Returns `undefined` when the lookup could not be performed (RPC error),
 * distinct from `null` for "verified absent" — the caller must not turn an
 * outage into "not a member".
 */
async function readMemberRow(
  membersTableId: string | null,
  address: string,
  network: NetworkType,
): Promise<MemberRow | null | undefined> {
  if (!membersTableId) return undefined;
  const client = getPooledSuiClient({ network });
  try {
    const field = await client.getDynamicFieldObject({
      parentId: membersTableId,
      name: { type: 'address', value: address },
    });
    if (field.error) {
      const code = (field.error as { code?: string }).code ?? '';
      return code === 'dynamicFieldNotFound' ? null : undefined;
    }
    const content = field.data?.content;
    if (!content || content.dataType !== 'moveObject') return undefined;
    const outer = asRecord((content as { fields?: unknown }).fields);
    const value = asRecord(outer?.value);
    const inner = asRecord(value?.fields) ?? value ?? outer;
    if (!inner) return undefined;

    // payout_position is Option<u64>: `{ fields: { vec: [n] } }` or null.
    let payoutPosition: number | null = null;
    const posOption = asRecord(inner.payout_position);
    const posVec = posOption ? (asRecord(posOption.fields)?.vec ?? posOption.vec) : null;
    if (Array.isArray(posVec) && posVec.length > 0) {
      payoutPosition = parseU64(posVec[0]);
    } else {
      payoutPosition = parseU64(inner.payout_position);
    }

    return {
      joinedAtMs: parseU64(inner.joined_at),
      payoutPosition,
    };
  } catch {
    return undefined;
  }
}

/** Escrows examined per circle; beyond this we report the recent window. */
const MAX_ESCROWS_PER_CIRCLE = 24;

function decodeByteName(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((b) => (typeof b === 'number' ? String.fromCharCode(b) : ''))
      .join('');
  }
  return null;
}

/**
 * The circle's on-chain escrow history (v1.1 `FIELD_ESCROW_HISTORY`),
 * newest last, or null when the field does not exist / cannot be read.
 * A `vector<u8>` dynamic-field name comes back as a byte array on most
 * nodes, so the match decodes it — same pitfall circle-migration.ts
 * documents.
 */
async function readEscrowHistory(
  circleId: string,
  network: NetworkType,
): Promise<string[] | null> {
  const client = getPooledSuiClient({ network });
  try {
    let cursor: string | null | undefined;
    let fieldObjectId: string | null = null;
    let pages = 0;
    do {
      const res = await client.getDynamicFields({
        parentId: circleId,
        cursor: cursor ?? undefined,
      });
      for (const f of res.data) {
        const nameRecord =
          f && typeof f.name === 'object' ? (f.name as { value?: unknown }) : null;
        if (decodeByteName(nameRecord?.value) === 'escrow_history') {
          fieldObjectId = f.objectId;
          break;
        }
      }
      cursor = fieldObjectId ? null : res.hasNextPage ? res.nextCursor : null;
      pages += 1;
    } while (cursor && pages < 10);

    if (!fieldObjectId) return null;

    const obj = await client.getObject({ id: fieldObjectId, options: { showContent: true } });
    const content = obj.data?.content;
    if (!content || content.dataType !== 'moveObject') return null;
    const fields = asRecord((content as { fields?: unknown }).fields);
    const value = fields?.value;
    if (!Array.isArray(value)) return null;
    return value.filter((id): id is string => typeof id === 'string');
  } catch {
    return null;
  }
}

/**
 * On-time evidence for one member across the circle's recorded escrows.
 *
 * Counts only what is provable: a cycle contributes to `recorded` only if
 * a v1.1 timestamp exists for this member, and refunded (cancelled)
 * cycles are excluded entirely. Any read failure returns what was
 * gathered so far or null — never a fabricated count.
 */
async function readOnTimeEvidence(
  circleId: string,
  memberAddress: string,
  network: NetworkType,
): Promise<CircleOnTime | null> {
  const history = await readEscrowHistory(circleId, network);
  if (!history || history.length === 0) return null;

  // ContributionTimeKey is a v1.1-introduced type: it anchors to the id
  // of the package version that DEFINED it (v6), not the original id —
  // the inverse of the membership-discovery rule, which applies only to
  // types that existed at original publish. Using originalId here
  // silently found nothing (live, 2026-08-23).
  const { timedEntriesPackageId } = getPublishedPackageMetadata(network);
  if (!timedEntriesPackageId) return null;
  const keyType = `${timedEntriesPackageId}::njangi_cycle_escrow::ContributionTimeKey`;

  const client = getPooledSuiClient({ network });
  const recent = history.slice(-MAX_ESCROWS_PER_CIRCLE);

  let recorded = 0;
  let onTime = 0;

  await Promise.all(
    recent.map(async (escrowId) => {
      try {
        const obj = await client.getObject({ id: escrowId, options: { showContent: true } });
        const content = obj.data?.content;
        if (!content || content.dataType !== 'moveObject') return;
        const fields = asRecord((content as { fields?: unknown }).fields);
        if (!fields || fields.refunded === true) return;
        const snapshot = asRecord(asRecord(fields.snapshot)?.fields) ?? asRecord(fields.snapshot);
        const dueAtMs = parseU64(snapshot?.due_at_ms);
        if (dueAtMs === null) return;

        const ts = await client.getDynamicFieldObject({
          parentId: escrowId,
          name: { type: keyType, value: { member: memberAddress } },
        });
        if (ts.error || !ts.data) return;
        const tsContent = ts.data.content;
        if (!tsContent || tsContent.dataType !== 'moveObject') return;
        const tsFields = asRecord((tsContent as { fields?: unknown }).fields);
        const paidAtMs = parseU64(tsFields?.value);
        if (paidAtMs === null) return;

        recorded += 1;
        if (paidAtMs <= dueAtMs) onTime += 1;
      } catch {
        // Skip unreadable escrows; partial evidence is still evidence,
        // and a read failure must never manufacture a late payment.
      }
    }),
  );

  return recorded > 0 ? { recorded, onTime } : null;
}

/**
 * Builds the member's record across every circle they hold a receipt for.
 *
 * Circles are read concurrently; a circle that cannot be read is omitted
 * rather than reported as empty, so an RPC failure never renders as an
 * absence of history.
 */
export async function buildCircleRecord(
  address: string,
  opts: { network?: NetworkType; nowMs?: number } = {},
): Promise<CircleRecord> {
  const network = opts.network ?? getCurrentNetwork();
  const normalized = normalizeAddress(address) ?? address.trim().toLowerCase();

  const circleIds = await discoverMemberCircleIds(normalized, { network });

  const entries = await Promise.all(
    circleIds.map(async (circleId): Promise<CircleRecordEntry | null> => {
      const state = await readCircleState(circleId, network);
      if (!state) return null;

      const memberRow = await readMemberRow(state.membersTableId, normalized, network);
      // Verified absent -> the receipt is stale; leave the circle out.
      if (memberRow === null) return null;

      const historyIndex = state.rotationHistory.indexOf(normalized);
      const orderIndex = state.rotationOrder.indexOf(normalized);
      const onTime = await readOnTimeEvidence(circleId, normalized, network);

      return {
        circleId,
        circleName: state.name,
        joinedAtMs: memberRow?.joinedAtMs ?? null,
        isCurrentMember: true,
        completedRounds: state.rotationHistory.length,
        payoutRound: historyIndex >= 0 ? historyIndex + 1 : null,
        rotationPosition:
          memberRow?.payoutPosition != null
            ? memberRow.payoutPosition + 1
            : orderIndex >= 0
              ? orderIndex + 1
              : null,
        memberCount: state.memberCount,
        currentCycle: state.currentCycle,
        onTime,
      };
    }),
  );

  const circles = entries.filter((e): e is CircleRecordEntry => e !== null);

  const joinedTimes = circles
    .map((c) => c.joinedAtMs)
    .filter((t): t is number => typeof t === 'number' && t > 0);

  const summary: CircleRecordSummary = {
    circlesJoined: circles.length,
    payoutsReceived: circles.filter((c) => c.payoutRound !== null).length,
    completedRoundsAcrossCircles: circles.reduce((sum, c) => sum + c.completedRounds, 0),
    // Only rounds up to and including a payout are provably theirs.
    provenParticipatedRounds: circles.reduce((sum, c) => sum + (c.payoutRound ?? 0), 0),
    earliestJoinedAtMs: joinedTimes.length > 0 ? Math.min(...joinedTimes) : null,
  };

  return {
    address: normalized,
    generatedAtMs: opts.nowMs ?? Date.now(),
    network,
    circles,
    summary,
    verificationObjectIds: circles.map((c) => c.circleId),
  };
}
