/**
 * Tests for Circle Record (docs/prd/prd-circle-record.md).
 *
 * The cases that matter most are the ones where a wrong answer is a
 * reputational statement about a real person:
 *   - a stale membership receipt must not appear as a circle;
 *   - an RPC failure must never render as "no history";
 *   - nothing may produce a negative claim (a missed payment) — absence of
 *     a payout is reported as "turn not yet reached", never as a failure.
 */

jest.mock('@/services/network-config', () => ({
  getCurrentNetwork: () => 'testnet',
  getNetworkConfig: () => ({ rpcUrl: 'https://example.invalid' }),
}));

const getObject = jest.fn();
const getDynamicFieldObject = jest.fn();

jest.mock('@/services/sui-rpc-failover', () => ({
  getPooledSuiClient: () => ({ getObject, getDynamicFieldObject }),
}));

const discoverMemberCircleIds = jest.fn();
jest.mock('../membership-discovery', () => ({
  discoverMemberCircleIds: (...args: unknown[]) => discoverMemberCircleIds(...args),
}));

// Bypass the read cache so each test sees its own mocks.
jest.mock('../sui-read', () => ({
  cachedRead: (_key: string, loader: () => Promise<unknown>) => loader(),
}));

import { buildCircleRecord } from '../circle-record';

const ME = '0x' + '11'.repeat(32);
const OTHER = '0x' + '22'.repeat(32);
const CIRCLE_A = '0x' + 'aa'.repeat(32);
const CIRCLE_B = '0x' + 'bb'.repeat(32);

const MEMBERS_TABLE = '0x' + 'cc'.repeat(32);

function circleObject(opts: {
  name?: string;
  rotationHistory?: string[];
  rotationOrder?: string[];
  currentMembers?: number;
  currentCycle?: number;
}) {
  return {
    data: {
      content: {
        dataType: 'moveObject',
        fields: {
          name: opts.name ?? 'Family Circle',
          rotation_history: opts.rotationHistory ?? [],
          rotation_order: opts.rotationOrder ?? [],
          current_members: String(opts.currentMembers ?? 5),
          current_cycle: String(opts.currentCycle ?? 1),
          members: { fields: { id: { id: MEMBERS_TABLE } } },
        },
      },
    },
  };
}

function memberRow(joinedAt: number, payoutPosition?: number) {
  return {
    data: {
      content: {
        dataType: 'moveObject',
        fields: {
          value: {
            fields: {
              joined_at: String(joinedAt),
              payout_position:
                payoutPosition === undefined
                  ? { fields: { vec: [] } }
                  : { fields: { vec: [String(payoutPosition)] } },
            },
          },
        },
      },
    },
  };
}

beforeEach(() => {
  getObject.mockReset();
  getDynamicFieldObject.mockReset();
  discoverMemberCircleIds.mockReset();
});

describe('buildCircleRecord', () => {
  it('reports a circle the member belongs to, with completed rounds', async () => {
    discoverMemberCircleIds.mockResolvedValue([CIRCLE_A]);
    getObject.mockResolvedValue(
      circleObject({ rotationHistory: [OTHER, ME], rotationOrder: [OTHER, ME] }),
    );
    getDynamicFieldObject.mockResolvedValue(memberRow(1_700_000_000_000, 1));

    const record = await buildCircleRecord(ME);

    expect(record.circles).toHaveLength(1);
    const c = record.circles[0];
    expect(c.circleId).toBe(CIRCLE_A);
    expect(c.completedRounds).toBe(2);
    expect(c.payoutRound).toBe(2); // second entry in rotation_history
    expect(c.rotationPosition).toBe(2); // payout_position 1 -> 1-based 2
    expect(record.summary.payoutsReceived).toBe(1);
  });

  it('reports a member whose turn has not come as "not yet", never as a miss', async () => {
    discoverMemberCircleIds.mockResolvedValue([CIRCLE_A]);
    getObject.mockResolvedValue(
      circleObject({ rotationHistory: [OTHER], rotationOrder: [OTHER, ME] }),
    );
    getDynamicFieldObject.mockResolvedValue(memberRow(1_700_000_000_000, 1));

    const record = await buildCircleRecord(ME);

    expect(record.circles[0].payoutRound).toBeNull();
    expect(record.summary.payoutsReceived).toBe(0);
    // The record must not invent a participation count it cannot prove.
    expect(record.summary.provenParticipatedRounds).toBe(0);
  });

  it('drops a circle when the membership receipt is stale (verified absent)', async () => {
    discoverMemberCircleIds.mockResolvedValue([CIRCLE_A]);
    getObject.mockResolvedValue(circleObject({}));
    getDynamicFieldObject.mockResolvedValue({
      error: { code: 'dynamicFieldNotFound' },
    });

    const record = await buildCircleRecord(ME);

    expect(record.circles).toHaveLength(0);
    expect(record.summary.circlesJoined).toBe(0);
  });

  it('keeps the circle when the member lookup FAILS, rather than implying removal', async () => {
    // An RPC error must not look the same as "not a member" — otherwise an
    // outage silently erases someone's history.
    discoverMemberCircleIds.mockResolvedValue([CIRCLE_A]);
    getObject.mockResolvedValue(circleObject({ rotationHistory: [ME] }));
    getDynamicFieldObject.mockRejectedValue(new Error('rpc down'));

    const record = await buildCircleRecord(ME);

    expect(record.circles).toHaveLength(1);
    expect(record.circles[0].joinedAtMs).toBeNull();
    expect(record.circles[0].payoutRound).toBe(1);
  });

  it('omits a circle whose object cannot be read instead of showing it empty', async () => {
    discoverMemberCircleIds.mockResolvedValue([CIRCLE_A]);
    getObject.mockResolvedValue({ data: null });

    const record = await buildCircleRecord(ME);
    expect(record.circles).toHaveLength(0);
  });

  it('aggregates across several circles', async () => {
    discoverMemberCircleIds.mockResolvedValue([CIRCLE_A, CIRCLE_B]);
    getObject.mockImplementation(({ id }: { id: string }) =>
      Promise.resolve(
        id === CIRCLE_A
          ? circleObject({ name: 'A', rotationHistory: [ME, OTHER] })
          : circleObject({ name: 'B', rotationHistory: [OTHER] }),
      ),
    );
    getDynamicFieldObject.mockResolvedValue(memberRow(1_700_000_000_000, 0));

    const record = await buildCircleRecord(ME);

    expect(record.summary.circlesJoined).toBe(2);
    expect(record.summary.payoutsReceived).toBe(1);
    expect(record.summary.completedRoundsAcrossCircles).toBe(3);
    expect(record.verificationObjectIds).toEqual(
      expect.arrayContaining([CIRCLE_A, CIRCLE_B]),
    );
  });

  it('handles a brand-new member with no circles', async () => {
    discoverMemberCircleIds.mockResolvedValue([]);
    const record = await buildCircleRecord(ME);

    expect(record.circles).toHaveLength(0);
    expect(record.summary).toEqual({
      circlesJoined: 0,
      payoutsReceived: 0,
      completedRoundsAcrossCircles: 0,
      provenParticipatedRounds: 0,
      earliestJoinedAtMs: null,
    });
  });

  it('matches addresses case-insensitively', async () => {
    discoverMemberCircleIds.mockResolvedValue([CIRCLE_A]);
    getObject.mockResolvedValue(
      circleObject({ rotationHistory: [ME.toUpperCase().replace('0X', '0x')] }),
    );
    getDynamicFieldObject.mockResolvedValue(memberRow(1_700_000_000_000));

    const record = await buildCircleRecord(ME.toUpperCase().replace('0X', '0x'));
    expect(record.circles[0].payoutRound).toBe(1);
  });

  it('never emits a score, rating or grade field', async () => {
    discoverMemberCircleIds.mockResolvedValue([CIRCLE_A]);
    getObject.mockResolvedValue(circleObject({ rotationHistory: [ME] }));
    getDynamicFieldObject.mockResolvedValue(memberRow(1_700_000_000_000, 0));

    const record = await buildCircleRecord(ME);
    const serialized = JSON.stringify(record).toLowerCase();

    expect(serialized).not.toMatch(/"score"|"rating"|"grade"|"tier"|reputation/);
  });
});
