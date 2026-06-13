// Tests for CircleMilestones discovery + Move object JSON parsing.

const getObject = jest.fn();
const queryEvents = jest.fn();
let mockOriginalId: string | null = '0xorig';

jest.mock('@/services/sui-rpc-failover', () => ({
  getPooledSuiClient: () => ({ getObject, queryEvents }),
}));
jest.mock('@/services/network-config', () => ({
  getNetworkConfig: () => ({ rpcUrl: 'http://localhost:9000' }),
  getPackageIdForNetwork: () => '0xpkg',
}));
jest.mock('@/lib/circle-chain', () => ({
  getPublishedPackageMetadata: () => ({ originalId: mockOriginalId, publishedAt: '0xpkg' }),
}));

import type { SuiClient } from '@mysten/sui/client';
import {
  computeGoalProgress,
  computeMilestoneProgress,
  findCircleMilestones,
  MAX_MILESTONE_EVENT_PAGES,
  nextIncompleteMilestone,
  parseCircleMilestonesContent,
  readCircleMilestonesState,
  type MilestoneState,
} from '@/lib/milestone-discovery';

const fakeClient = { getObject, queryEvents } as unknown as SuiClient;

const SUI_TYPE = '0x2::sui::SUI';
const TRACKER_TYPE = `0xorig::njangi_milestones::CircleMilestones<${SUI_TYPE}>`;
const assetTypeBytes = Array.from(new TextEncoder().encode(SUI_TYPE));

const monetaryMilestone = {
  type: '0xorig::njangi_milestones::Milestone',
  fields: {
    kind: 0,
    target_amount: '2000000000',
    target_timestamp_ms: '0',
    description: 'First two cycles saved',
    requires_verification: true,
    verified_by: '0xAD',
    proofs: ['aGFzaA=='],
    completed: true,
    completed_at_ms: '1700000000000',
    achieved_value: '2000000000',
  },
};

const timeMilestone = {
  type: '0xorig::njangi_milestones::Milestone',
  fields: {
    kind: 1,
    target_amount: '0',
    target_timestamp_ms: '1800000000000',
    description: '30 days strong together',
    requires_verification: false,
    // Option<address> rendered in the `{ fields: { vec: [] } }` shape.
    verified_by: { fields: { vec: [] } },
    proofs: [],
    completed: false,
    completed_at_ms: '0',
    achieved_value: '0',
  },
};

const trackerContent = {
  dataType: 'moveObject' as const,
  type: TRACKER_TYPE,
  fields: {
    id: { id: '0xtracker' },
    circle_id: '0xc1',
    next_to_complete: '1',
    cumulative_contributed: '2000000000',
    locked: true,
    credited_escrows: {
      type: '0x2::table::Table<0x2::object::ID, bool>',
      fields: { id: { id: '0xtable' }, size: '1' },
    },
    milestones: [monetaryMilestone, timeMilestone],
  },
};

beforeEach(() => {
  getObject.mockReset();
  queryEvents.mockReset();
  mockOriginalId = '0xorig';
});

describe('parseCircleMilestonesContent', () => {
  it('parses the Move object JSON into a typed state', () => {
    const state = parseCircleMilestonesContent('0xtracker', trackerContent);
    expect(state).not.toBeNull();
    expect(state!.milestonesId).toBe('0xtracker');
    expect(state!.circleId).toBe('0xc1');
    expect(state!.assetType).toBe(SUI_TYPE);
    expect(state!.nextToComplete).toBe(1);
    expect(state!.cumulativeContributed).toBe('2000000000');
    expect(state!.creditedEscrowCount).toBe(1);
    expect(state!.locked).toBe(true);
    expect(state!.goalAchieved).toBe(false);
    expect(state!.milestones).toHaveLength(2);
  });

  it('parses a monetary milestone with proofs and a verified-by address', () => {
    const state = parseCircleMilestonesContent('0xtracker', trackerContent)!;
    const milestone = state.milestones[0];
    expect(milestone.index).toBe(0);
    expect(milestone.kind).toBe('monetary');
    expect(milestone.targetAmount).toBe('2000000000');
    expect(milestone.targetTimestampMs).toBe(0);
    expect(milestone.description).toBe('First two cycles saved');
    expect(milestone.requiresVerification).toBe(true);
    expect(milestone.verifiedBy).toBe('0xad');
    expect(milestone.proofCount).toBe(1);
    expect(milestone.completed).toBe(true);
    expect(milestone.completedAtMs).toBe(1700000000000);
    expect(milestone.achievedValue).toBe('2000000000');
  });

  it('parses a time milestone with an empty Option verified_by as null', () => {
    const state = parseCircleMilestonesContent('0xtracker', trackerContent)!;
    const milestone = state.milestones[1];
    expect(milestone.kind).toBe('time');
    expect(milestone.targetTimestampMs).toBe(1800000000000);
    expect(milestone.verifiedBy).toBeNull();
    expect(milestone.proofCount).toBe(0);
    expect(milestone.completed).toBe(false);
  });

  it('reports goalAchieved when next_to_complete reaches the milestone count', () => {
    const achieved = {
      ...trackerContent,
      fields: { ...trackerContent.fields, next_to_complete: '2' },
    };
    const state = parseCircleMilestonesContent('0xtracker', achieved)!;
    expect(state.goalAchieved).toBe(true);
    expect(nextIncompleteMilestone(state)).toBeNull();
  });

  it('returns null for non-move-object content', () => {
    expect(parseCircleMilestonesContent('0xtracker', null)).toBeNull();
    expect(
      parseCircleMilestonesContent('0xtracker', { dataType: 'package' }),
    ).toBeNull();
  });
});

describe('readCircleMilestonesState', () => {
  it('reads and parses the shared object via RPC', async () => {
    getObject.mockResolvedValueOnce({ data: { content: trackerContent } });
    const state = await readCircleMilestonesState('0xtracker', 'testnet', fakeClient);
    expect(getObject).toHaveBeenCalledWith({
      id: '0xtracker',
      options: { showContent: true },
    });
    expect(state?.circleId).toBe('0xc1');
    expect(state?.assetType).toBe(SUI_TYPE);
  });

  it('returns null when the object has no move content', async () => {
    getObject.mockResolvedValueOnce({ data: { content: undefined } });
    const state = await readCircleMilestonesState('0xtracker', 'testnet', fakeClient);
    expect(state).toBeNull();
  });
});

describe('findCircleMilestones', () => {
  const createdEvent = (circleId: string, milestonesId: string, timestampMs: string) => ({
    parsedJson: {
      circle_id: circleId,
      milestones_id: milestonesId,
      asset_type: assetTypeBytes,
    },
    timestampMs,
  });

  it('queries MilestonesCreated oldest-first, anchored to the ORIGINAL package id', async () => {
    queryEvents.mockResolvedValueOnce({ data: [], hasNextPage: false, nextCursor: null });
    await findCircleMilestones(fakeClient, 'testnet', '0xc1');
    expect(queryEvents).toHaveBeenCalledWith({
      query: { MoveEventType: '0xorig::njangi_milestones::MilestonesCreated' },
      limit: 50,
      order: 'ascending',
      cursor: undefined,
    });
  });

  it('falls back to the configured package id when no lineage is recorded', async () => {
    mockOriginalId = null;
    queryEvents.mockResolvedValueOnce({ data: [], hasNextPage: false, nextCursor: null });
    await findCircleMilestones(fakeClient, 'testnet', '0xc1');
    expect(queryEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        query: { MoveEventType: '0xpkg::njangi_milestones::MilestonesCreated' },
      }),
    );
  });

  it('returns the OLDEST matching event for the circle (canonical first creation)', async () => {
    // Ascending order: oldest first. The first match must win over a
    // later duplicate tracker for the same circle.
    queryEvents.mockResolvedValueOnce({
      data: [
        createdEvent('0xc1', '0xcanonical', '100'),
        createdEvent('0xother', '0xforeign', '150'),
        createdEvent('0xc1', '0xduplicate', '200'),
      ],
      hasNextPage: false,
      nextCursor: null,
    });
    const found = await findCircleMilestones(fakeClient, 'testnet', '0xc1');
    expect(found).not.toBeNull();
    expect(found!.milestonesId).toBe('0xcanonical');
    expect(found!.circleId).toBe('0xc1');
    expect(found!.assetType).toBe(SUI_TYPE);
    expect(found!.createdAtMs).toBe(100);
  });

  it('follows nextCursor across pages until the circle is found', async () => {
    // The circle's tracker was created long ago: its event sits beyond
    // the first page. Discovery must paginate, not stop at one window.
    queryEvents
      .mockResolvedValueOnce({
        data: [
          createdEvent('0xother1', '0xf1', '10'),
          createdEvent('0xother2', '0xf2', '20'),
        ],
        hasNextPage: true,
        nextCursor: { txDigest: 'tx-page-1', eventSeq: '1' },
      })
      .mockResolvedValueOnce({
        data: [
          createdEvent('0xother3', '0xf3', '30'),
          createdEvent('0xc1', '0xcanonical', '40'),
        ],
        hasNextPage: true,
        nextCursor: { txDigest: 'tx-page-2', eventSeq: '1' },
      });
    const found = await findCircleMilestones(fakeClient, 'testnet', '0xc1');
    expect(found).not.toBeNull();
    expect(found!.milestonesId).toBe('0xcanonical');
    expect(found!.createdAtMs).toBe(40);
    expect(queryEvents).toHaveBeenCalledTimes(2);
    expect(queryEvents).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ cursor: { txDigest: 'tx-page-1', eventSeq: '1' } }),
    );
  });

  it('stops paginating as soon as the canonical (first) match is found', async () => {
    // Early exit: ascending order guarantees the first match is the
    // oldest, so any further pages are irrelevant.
    queryEvents.mockResolvedValueOnce({
      data: [createdEvent('0xc1', '0xcanonical', '100')],
      hasNextPage: true,
      nextCursor: { txDigest: 'tx-more', eventSeq: '0' },
    });
    const found = await findCircleMilestones(fakeClient, 'testnet', '0xc1');
    expect(found!.milestonesId).toBe('0xcanonical');
    expect(queryEvents).toHaveBeenCalledTimes(1);
  });

  it('drains every page before concluding no tracker exists', async () => {
    queryEvents
      .mockResolvedValueOnce({
        data: [createdEvent('0xother1', '0xf1', '10')],
        hasNextPage: true,
        nextCursor: { txDigest: 'tx-1', eventSeq: '0' },
      })
      .mockResolvedValueOnce({
        data: [createdEvent('0xother2', '0xf2', '20')],
        hasNextPage: true,
        nextCursor: { txDigest: 'tx-2', eventSeq: '0' },
      })
      .mockResolvedValueOnce({
        data: [createdEvent('0xother3', '0xf3', '30')],
        hasNextPage: false,
        nextCursor: null,
      });
    const found = await findCircleMilestones(fakeClient, 'testnet', '0xc1');
    expect(found).toBeNull();
    expect(queryEvents).toHaveBeenCalledTimes(3);
  });

  it('stops at the page safety cap instead of looping forever', async () => {
    // An RPC that always reports another page must not hang discovery.
    queryEvents.mockResolvedValue({
      data: [createdEvent('0xother', '0xforeign', '10')],
      hasNextPage: true,
      nextCursor: { txDigest: 'tx-loop', eventSeq: '0' },
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const found = await findCircleMilestones(fakeClient, 'testnet', '0xc1');
      expect(found).toBeNull();
      expect(queryEvents).toHaveBeenCalledTimes(MAX_MILESTONE_EVENT_PAGES);
    } finally {
      warn.mockRestore();
    }
  });

  it('treats hasNextPage without a cursor as the final page', async () => {
    // Defensive: a malformed page must terminate rather than refetch the
    // same window indefinitely.
    queryEvents.mockResolvedValueOnce({
      data: [createdEvent('0xother', '0xforeign', '10')],
      hasNextPage: true,
      nextCursor: null,
    });
    const found = await findCircleMilestones(fakeClient, 'testnet', '0xc1');
    expect(found).toBeNull();
    expect(queryEvents).toHaveBeenCalledTimes(1);
  });

  it('returns null when no event matches the circle', async () => {
    queryEvents.mockResolvedValueOnce({
      data: [createdEvent('0xother', '0xforeign', '100')],
      hasNextPage: false,
      nextCursor: null,
    });
    const found = await findCircleMilestones(fakeClient, 'testnet', '0xc1');
    expect(found).toBeNull();
  });

  it('returns null instead of throwing on RPC errors', async () => {
    queryEvents.mockRejectedValueOnce(new Error('rpc down'));
    const found = await findCircleMilestones(fakeClient, 'testnet', '0xc1');
    expect(found).toBeNull();
  });
});

describe('computeMilestoneProgress', () => {
  const base: MilestoneState = {
    index: 0,
    kind: 'monetary',
    targetAmount: '4000000000',
    targetTimestampMs: 0,
    description: '',
    requiresVerification: false,
    verifiedBy: null,
    proofCount: 0,
    completed: false,
    completedAtMs: 0,
    achievedValue: '0',
  };

  it('reports a proportional percentage for partial monetary progress', () => {
    const progress = computeMilestoneProgress(base, {
      cumulativeContributed: '2000000000',
      nowMs: 0,
    });
    expect(progress).toEqual({ index: 0, percent: 50, conditionMet: false });
  });

  it('caps incomplete monetary progress below 100 even when nearly there', () => {
    const progress = computeMilestoneProgress(base, {
      cumulativeContributed: '3999999999',
      nowMs: 0,
    });
    expect(progress.percent).toBe(99);
    expect(progress.conditionMet).toBe(false);
  });

  it('marks the condition met once the cumulative total reaches the target', () => {
    const progress = computeMilestoneProgress(base, {
      cumulativeContributed: '4000000000',
      nowMs: 0,
    });
    expect(progress).toEqual({ index: 0, percent: 100, conditionMet: true });
  });

  it('treats completed milestones as 100 regardless of inputs', () => {
    const progress = computeMilestoneProgress(
      { ...base, completed: true },
      { cumulativeContributed: '0', nowMs: 0 },
    );
    expect(progress).toEqual({ index: 0, percent: 100, conditionMet: true });
  });

  it('computes elapsed-time percentage for time milestones with an origin', () => {
    const milestone: MilestoneState = {
      ...base,
      kind: 'time',
      targetAmount: '0',
      targetTimestampMs: 2000,
    };
    const progress = computeMilestoneProgress(milestone, {
      cumulativeContributed: '0',
      nowMs: 1500,
      originMs: 1000,
    });
    expect(progress).toEqual({ index: 0, percent: 50, conditionMet: false });
  });

  it('reports time milestones as met once the clock passes the target', () => {
    const milestone: MilestoneState = {
      ...base,
      kind: 'time',
      targetTimestampMs: 2000,
    };
    const progress = computeMilestoneProgress(milestone, {
      cumulativeContributed: '0',
      nowMs: 2000,
    });
    expect(progress).toEqual({ index: 0, percent: 100, conditionMet: true });
  });

  it('reports 0 for unreached time milestones without an origin reference', () => {
    const milestone: MilestoneState = {
      ...base,
      kind: 'time',
      targetTimestampMs: 2000,
    };
    const progress = computeMilestoneProgress(milestone, {
      cumulativeContributed: '0',
      nowMs: 1999,
    });
    expect(progress).toEqual({ index: 0, percent: 0, conditionMet: false });
  });
});

describe('computeGoalProgress', () => {
  it('maps every milestone in index order', () => {
    const state = parseCircleMilestonesContent('0xtracker', trackerContent)!;
    const progress = computeGoalProgress(state, { nowMs: 1750000000000 });
    expect(progress).toHaveLength(2);
    // Completed monetary milestone.
    expect(progress[0]).toEqual({ index: 0, percent: 100, conditionMet: true });
    // Time milestone not yet reached, no origin → 0.
    expect(progress[1]).toEqual({ index: 1, percent: 0, conditionMet: false });
  });

  it('uses the creation timestamp as the time-milestone origin', () => {
    const state = parseCircleMilestonesContent('0xtracker', trackerContent)!;
    const progress = computeGoalProgress(state, {
      nowMs: 1_750_000_000_000,
      originMs: 1_700_000_000_000,
    });
    // (1750e9 - 1700e9) / (1800e9 - 1700e9) = 50%
    expect(progress[1]).toEqual({ index: 1, percent: 50, conditionMet: false });
  });
});
