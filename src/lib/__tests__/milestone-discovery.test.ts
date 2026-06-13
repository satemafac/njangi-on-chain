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
const readEscrowState = jest.fn();
jest.mock('@/lib/cycle-escrow-discovery', () => ({
  readCycleEscrowState: (...args: unknown[]) => readEscrowState(...args),
}));

import type { SuiClient } from '@mysten/sui/client';
import {
  computeGoalProgress,
  computeMilestoneProgress,
  findCircleMilestones,
  findUncountedEscrows,
  isCircleMember,
  isEscrowCredited,
  listCircleEscrowEvents,
  MAX_ESCROW_EVENT_PAGES,
  MAX_MILESTONE_EVENT_PAGES,
  nextIncompleteMilestone,
  parseCircleMilestonesContent,
  readCircleGoalContext,
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
  readEscrowState.mockReset();
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
    expect(state!.creditedTableId).toBe('0xtable');
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

describe('isEscrowCredited', () => {
  const getDynamicFieldObject = jest.fn();
  const dfClient = { getDynamicFieldObject } as unknown as SuiClient;

  beforeEach(() => getDynamicFieldObject.mockReset());

  it('returns true when the credited table holds the escrow id', async () => {
    getDynamicFieldObject.mockResolvedValueOnce({ data: { objectId: '0xfield' } });
    await expect(
      isEscrowCredited('0xtable', '0xescrow', 'testnet', dfClient),
    ).resolves.toBe(true);
    expect(getDynamicFieldObject).toHaveBeenCalledWith({
      parentId: '0xtable',
      name: { type: '0x2::object::ID', value: '0xescrow' },
    });
  });

  it('returns false when the dynamic field does not exist (never credited)', async () => {
    getDynamicFieldObject.mockResolvedValueOnce({
      error: { code: 'dynamicFieldNotFound' },
    });
    await expect(
      isEscrowCredited('0xtable', '0xescrow', 'testnet', dfClient),
    ).resolves.toBe(false);
  });

  it('returns null (unknown) on other errors so the UI hides the affordance', async () => {
    getDynamicFieldObject.mockResolvedValueOnce({ error: { code: 'somethingElse' } });
    await expect(
      isEscrowCredited('0xtable', '0xescrow', 'testnet', dfClient),
    ).resolves.toBeNull();
    getDynamicFieldObject.mockRejectedValueOnce(new Error('rpc down'));
    await expect(
      isEscrowCredited('0xtable', '0xescrow', 'testnet', dfClient),
    ).resolves.toBeNull();
  });

  it('returns null without a table or escrow id', async () => {
    await expect(isEscrowCredited('', '0xescrow', 'testnet', dfClient)).resolves.toBeNull();
    await expect(isEscrowCredited('0xtable', '', 'testnet', dfClient)).resolves.toBeNull();
    expect(getDynamicFieldObject).not.toHaveBeenCalled();
  });
});

describe('listCircleEscrowEvents', () => {
  const openedEvent = (circleId: string, escrowId: string, cycleNo: string) => ({
    parsedJson: {
      circle_id: circleId,
      escrow_id: escrowId,
      cycle_no: cycleNo,
      opened_at_ms: '1000',
      recipient: '0xr',
    },
  });

  it('queries CycleEscrowOpened oldest-first, anchored to the ORIGINAL package id', async () => {
    queryEvents.mockResolvedValueOnce({ data: [], hasNextPage: false, nextCursor: null });
    await listCircleEscrowEvents(fakeClient, 'testnet', '0xc1');
    expect(queryEvents).toHaveBeenCalledWith({
      query: { MoveEventType: '0xorig::njangi_cycle_escrow::CycleEscrowOpened' },
      limit: 50,
      order: 'ascending',
      cursor: undefined,
    });
  });

  it('collects EVERY escrow for the circle across pages, not one recent window', async () => {
    // A multi-cycle goal: round 1's escrow sits on an earlier page than
    // round 2's. Both must come back, oldest first.
    queryEvents
      .mockResolvedValueOnce({
        data: [
          openedEvent('0xc1', '0xesc1', '1'),
          openedEvent('0xother', '0xforeign', '1'),
        ],
        hasNextPage: true,
        nextCursor: { txDigest: 'tx-1', eventSeq: '0' },
      })
      .mockResolvedValueOnce({
        data: [openedEvent('0xc1', '0xesc2', '2')],
        hasNextPage: false,
        nextCursor: null,
      });
    const events = await listCircleEscrowEvents(fakeClient, 'testnet', '0xc1');
    expect(events).toEqual([
      { escrowId: '0xesc1', cycleNo: 1, openedAtMs: 1000 },
      { escrowId: '0xesc2', cycleNo: 2, openedAtMs: 1000 },
    ]);
    expect(queryEvents).toHaveBeenCalledTimes(2);
    expect(queryEvents).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ cursor: { txDigest: 'tx-1', eventSeq: '0' } }),
    );
  });

  it('dedupes repeated escrow ids and ignores malformed events', async () => {
    queryEvents.mockResolvedValueOnce({
      data: [
        openedEvent('0xc1', '0xesc1', '1'),
        openedEvent('0xc1', '0xesc1', '1'),
        { parsedJson: { circle_id: '0xc1', cycle_no: '2' } }, // no escrow_id
      ],
      hasNextPage: false,
      nextCursor: null,
    });
    const events = await listCircleEscrowEvents(fakeClient, 'testnet', '0xc1');
    expect(events).toHaveLength(1);
    expect(events[0].escrowId).toBe('0xesc1');
  });

  it('stops at the page safety cap instead of looping forever', async () => {
    queryEvents.mockResolvedValue({
      data: [openedEvent('0xother', '0xforeign', '1')],
      hasNextPage: true,
      nextCursor: { txDigest: 'tx-loop', eventSeq: '0' },
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const events = await listCircleEscrowEvents(fakeClient, 'testnet', '0xc1');
      expect(events).toEqual([]);
      expect(queryEvents).toHaveBeenCalledTimes(MAX_ESCROW_EVENT_PAGES);
    } finally {
      warn.mockRestore();
    }
  });

  it('returns [] instead of throwing on RPC errors', async () => {
    queryEvents.mockRejectedValueOnce(new Error('rpc down'));
    await expect(
      listCircleEscrowEvents(fakeClient, 'testnet', '0xc1'),
    ).resolves.toEqual([]);
  });
});

describe('findUncountedEscrows', () => {
  const getDynamicFieldObject = jest.fn();
  const escrowClient = {
    queryEvents,
    getDynamicFieldObject,
  } as unknown as SuiClient;

  const openedEvent = (escrowId: string, cycleNo: string) => ({
    parsedJson: {
      circle_id: '0xc1',
      escrow_id: escrowId,
      cycle_no: cycleNo,
      opened_at_ms: '1000',
    },
  });

  beforeEach(() => getDynamicFieldObject.mockReset());

  it('surfaces EVERY claimed-but-uncredited escrow, oldest first — even after newer cycles open', async () => {
    // Three rounds: round 1 credited, round 2 claimed but never credited
    // (the window everyone missed), round 3 still collecting. Round 2 must
    // surface even though it is no longer the most recent escrow.
    queryEvents.mockResolvedValueOnce({
      data: [
        openedEvent('0xesc1', '1'),
        openedEvent('0xesc2', '2'),
        openedEvent('0xesc3', '3'),
      ],
      hasNextPage: false,
      nextCursor: null,
    });
    getDynamicFieldObject
      .mockResolvedValueOnce({ data: { objectId: '0xfield1' } }) // esc1 credited
      .mockResolvedValueOnce({ error: { code: 'dynamicFieldNotFound' } }) // esc2 not
      .mockResolvedValueOnce({ error: { code: 'dynamicFieldNotFound' } }); // esc3 not
    readEscrowState
      .mockResolvedValueOnce({ claimed: true, cycleNo: 2 }) // esc2 settled
      .mockResolvedValueOnce({ claimed: false, cycleNo: 3 }); // esc3 running

    const uncounted = await findUncountedEscrows(
      escrowClient,
      'testnet',
      '0xc1',
      '0xtable',
    );
    expect(uncounted).toEqual([{ escrowId: '0xesc2', cycleNo: 2 }]);
    // Credited escrows never get a state read.
    expect(readEscrowState).toHaveBeenCalledTimes(2);
    expect(readEscrowState).toHaveBeenNthCalledWith(1, '0xesc2', 'testnet', escrowClient);
  });

  it('returns multiple stragglers in rotation (oldest-first) order', async () => {
    queryEvents.mockResolvedValueOnce({
      data: [openedEvent('0xesc1', '1'), openedEvent('0xesc2', '2')],
      hasNextPage: false,
      nextCursor: null,
    });
    getDynamicFieldObject.mockResolvedValue({
      error: { code: 'dynamicFieldNotFound' },
    });
    readEscrowState
      .mockResolvedValueOnce({ claimed: true, cycleNo: 1 })
      .mockResolvedValueOnce({ claimed: true, cycleNo: 2 });
    const uncounted = await findUncountedEscrows(
      escrowClient,
      'testnet',
      '0xc1',
      '0xtable',
    );
    expect(uncounted).toEqual([
      { escrowId: '0xesc1', cycleNo: 1 },
      { escrowId: '0xesc2', cycleNo: 2 },
    ]);
  });

  it('skips escrows with UNKNOWN credited status rather than inviting an abort', async () => {
    queryEvents.mockResolvedValueOnce({
      data: [openedEvent('0xesc1', '1')],
      hasNextPage: false,
      nextCursor: null,
    });
    getDynamicFieldObject.mockResolvedValueOnce({ error: { code: 'somethingElse' } });
    const uncounted = await findUncountedEscrows(
      escrowClient,
      'testnet',
      '0xc1',
      '0xtable',
    );
    expect(uncounted).toEqual([]);
    expect(readEscrowState).not.toHaveBeenCalled();
  });

  it('survives a failing escrow state read and keeps the rest', async () => {
    queryEvents.mockResolvedValueOnce({
      data: [openedEvent('0xesc1', '1'), openedEvent('0xesc2', '2')],
      hasNextPage: false,
      nextCursor: null,
    });
    getDynamicFieldObject.mockResolvedValue({
      error: { code: 'dynamicFieldNotFound' },
    });
    readEscrowState
      .mockRejectedValueOnce(new Error('rpc down'))
      .mockResolvedValueOnce({ claimed: true, cycleNo: 2 });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const uncounted = await findUncountedEscrows(
        escrowClient,
        'testnet',
        '0xc1',
        '0xtable',
      );
      expect(uncounted).toEqual([{ escrowId: '0xesc2', cycleNo: 2 }]);
    } finally {
      warn.mockRestore();
    }
  });

  it('returns [] without a credited table id (tracker state unknown)', async () => {
    const uncounted = await findUncountedEscrows(
      escrowClient,
      'testnet',
      '0xc1',
      '',
    );
    expect(uncounted).toEqual([]);
    expect(queryEvents).not.toHaveBeenCalled();
  });
});

describe('isCircleMember', () => {
  const getDynamicFieldObject = jest.fn();
  const dfClient = { getDynamicFieldObject } as unknown as SuiClient;

  beforeEach(() => getDynamicFieldObject.mockReset());

  it('resolves membership via the members table dynamic field', async () => {
    getDynamicFieldObject.mockResolvedValueOnce({ data: { objectId: '0xmember' } });
    await expect(
      isCircleMember('0xmembers', '0xb0b', 'testnet', dfClient),
    ).resolves.toBe(true);
    getDynamicFieldObject.mockResolvedValueOnce({
      error: { code: 'dynamicFieldNotFound' },
    });
    await expect(
      isCircleMember('0xmembers', '0xdead', 'testnet', dfClient),
    ).resolves.toBe(false);
  });

  it('fails open (null) on missing inputs or RPC trouble', async () => {
    await expect(isCircleMember(null, '0xb0b', 'testnet', dfClient)).resolves.toBeNull();
    getDynamicFieldObject.mockRejectedValueOnce(new Error('rpc down'));
    await expect(
      isCircleMember('0xmembers', '0xb0b', 'testnet', dfClient),
    ).resolves.toBeNull();
  });
});

describe('readCircleGoalContext', () => {
  const getDynamicFields = jest.fn();
  const ctxClient = { getObject, getDynamicFields } as unknown as SuiClient;

  const circleContent = (overrides: Record<string, unknown> = {}) => ({
    data: {
      content: {
        dataType: 'moveObject',
        fields: {
          name: 'Village Savings',
          admin: '0xA11CE',
          current_cycle: '1',
          current_position: '0',
          paused_after_cycle: false,
          is_active: true,
          members: { fields: { id: { id: '0xmembers' } } },
          ...overrides,
        },
      },
    },
  });

  const configObject = (configFields: Record<string, unknown>) => ({
    data: {
      content: {
        dataType: 'moveObject',
        fields: {
          name: { type: '...', value: 'circle_config' },
          value: { type: '...CircleConfig', fields: configFields },
        },
      },
    },
  });

  beforeEach(() => {
    getDynamicFields.mockReset();
    getDynamicFields.mockResolvedValue({
      data: [
        {
          objectId: '0xcfg',
          objectType: '0xorig::njangi_circle_config::CircleConfig',
          name: { type: 'vector<u8>', value: 'circle_config' },
        },
      ],
    });
  });

  it('reads a smart-goal circle with an amount goal', async () => {
    getObject
      .mockResolvedValueOnce(circleContent())
      .mockResolvedValueOnce(
        configObject({
          goal_type: 0,
          target_amount: '4000000000',
          target_amount_local: '100000',
          target_date: null,
          verification_required: true,
          auto_swap_enabled: false,
        }),
      );
    const ctx = await readCircleGoalContext('0xc1', 'testnet', ctxClient);
    expect(ctx).not.toBeNull();
    expect(ctx!.name).toBe('Village Savings');
    expect(ctx!.admin).toBe('0xa11ce');
    expect(ctx!.hasGoal).toBe(true);
    expect(ctx!.goalKind).toBe('amount');
    expect(ctx!.targetAmountMist).toBe('4000000000');
    expect(ctx!.verificationRequired).toBe(true);
    expect(ctx!.autoSwapEnabled).toBe(false);
    expect(ctx!.membersTableId).toBe('0xmembers');
    expect(ctx!.rotationStarted).toBe(false);
  });

  it('reports rotationStarted once the rotation has advanced (mirrors assert_rotation_not_started)', async () => {
    getObject
      .mockResolvedValueOnce(circleContent({ current_position: '1' }))
      .mockResolvedValueOnce(configObject({ goal_type: 0 }));
    const ctx = await readCircleGoalContext('0xc1', 'testnet', ctxClient);
    expect(ctx!.rotationStarted).toBe(true);
  });

  it('treats a circle without goal_type as not smart-goal', async () => {
    getObject
      .mockResolvedValueOnce(circleContent())
      .mockResolvedValueOnce(configObject({ goal_type: null }));
    const ctx = await readCircleGoalContext('0xc1', 'testnet', ctxClient);
    expect(ctx!.hasGoal).toBe(false);
    expect(ctx!.goalKind).toBeNull();
  });

  it('returns null when the circle object is unreadable', async () => {
    getObject.mockResolvedValueOnce({ data: { content: undefined } });
    const ctx = await readCircleGoalContext('0xmissing', 'testnet', ctxClient);
    expect(ctx).toBeNull();
  });
});
