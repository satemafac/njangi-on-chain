/**
 * Round discovery must survive event retention — and a failed read must not
 * look like a fact.
 *
 * The regression this guards, observed on production 2026-08-29/30: the
 * contribute panel found the current round ONLY through `CycleEscrowOpened`
 * events; the configured primary RPC prunes event history and refuses every
 * such query; the one endpoint that still served it rations requests — so
 * across a single rotation lap the panel fell into "we couldn't reach the
 * network" four separate times. The Circle's `escrow_history` dynamic field
 * carries the same answer as a plain object read, which every endpoint
 * serves.
 *
 * `findCurrentCycleEscrow` picks its own endpoint for the event scan and
 * propagates failures, so these mock the failover layer for events and
 * inject a client for the object reads.
 */
import type { SuiClient } from '@mysten/sui/client';
import {
  ESCROW_HISTORY_FIELD_NAME,
  findCurrentCycleEscrow,
  isCycleEscrowForCircle,
  listContributors,
  readCircleEscrowHistory,
  readCircleRotationPointer,
  verifyCycleEscrowForCircle,
} from '@/lib/cycle-escrow-discovery';
import { getPooledSuiClient, withSuiRpcFailover } from '@/services/sui-rpc-failover';
import { readFileSync } from 'fs';
import { join } from 'path';

jest.mock('@/services/sui-rpc-failover', () => ({
  ...jest.requireActual('@/services/sui-rpc-failover'),
  withSuiRpcFailover: jest.fn(),
  getPooledSuiClient: jest.fn(),
}));

const failover = withSuiRpcFailover as jest.MockedFunction<typeof withSuiRpcFailover>;
const pooled = getPooledSuiClient as jest.MockedFunction<typeof getPooledSuiClient>;

// Production circle 0xa3fada…675ed and its three recorded escrows, exactly as
// testnet returned them on 2026-09-05.
const CIRCLE = '0xa3fada18d0d030f0f26e9a7ea77cd4f260a13649426a97bc9063c6f47de675ed';
const OTHER_CIRCLE = '0x83bd939b76c636aaf0f1608b702ff2de4b3824c57c26c928c7b31c0bddb8a1f0';
const ESCROW_1 = '0xaf00b3aceb8fef7ecefd49f6adaf9a03fe6bc7a8895252cc5bf36ea4b34c1849';
const ESCROW_2 = '0x1eab25a8c6317c7bf3d07c57b9841312c25bd8c78c5a41a0b5bc9a43a76394f7';
const ESCROW_3 = '0x09c3df1df6caf18e04777c20fcde60ac3353cad427f798d1e1bc3d371648e4ae';
const IMPOSTER = '0x' + 'dd'.repeat(32);
const ORIGINAL_PKG = '0x89cddf4dfe654e7c7b16333096d9e750cf04bb96f7de934403a512d460594f02';
const USDC =
  '0x26b3bc67befc214058ca78ea9a2690298d731a2d4309485ec3d40198063c4abc::usdc::USDC';
const ROTATION = [
  '0xe833deaa9c038ac2edd397323ed5dbde1e622aadfd0d526332a214a31f9de17d',
  '0xdf98684462fb5b3e85dffcc34fda108b7c34e7da37ab88f0ae3a530ef804a97d',
  '0x1f8d4bdfa384503b0901c73c9925c5b29dad510766542a30dc3b6904ddba897b',
];

/** The exact on-chain key: the bytes of `b"escrow_history"`. */
const ESCROW_HISTORY_BYTES = [101, 115, 99, 114, 111, 119, 95, 104, 105, 115, 116, 111, 114, 121];

const CYCLE_ESCROW_TYPE = `${ORIGINAL_PKG}::njangi_cycle_escrow::CycleEscrow<${USDC}>`;

const escrowObject = (opts: { id: string; circleId?: string; cycleNo?: number }) => ({
  data: {
    objectId: opts.id,
    type: CYCLE_ESCROW_TYPE,
    content: {
      dataType: 'moveObject',
      type: CYCLE_ESCROW_TYPE,
      fields: {
        circle_id: opts.circleId ?? CIRCLE,
        claimed: false,
        finalized: false,
        refunded: false,
        snapshot: {
          type: `${ORIGINAL_PKG}::njangi_cycle_escrow::CycleSnapshot`,
          fields: {
            // Bytes of the canonical type without 0x, as the contract stores it.
            asset_type: Array.from(new TextEncoder().encode(USDC.slice(2))),
            contribution_amount: '100000',
            cycle_no: String(opts.cycleNo ?? 1),
            due_at_ms: '1789948800000',
            members: ROTATION,
            opened_at_ms: '1788072287141',
            recipient: ROTATION[2],
            required_contributors: '2',
          },
        },
      },
    },
  },
});

const circleObject = {
  data: {
    objectId: CIRCLE,
    type: `${ORIGINAL_PKG}::njangi_circles::Circle`,
    content: { dataType: 'moveObject', fields: { current_cycle: '1' } },
  },
};

const HISTORY_FIELD_TYPE = '0x2::dynamic_field::Field<vector<u8>, vector<0x2::object::ID>>';

const historyField = (ids: string[]) => ({
  data: {
    objectId: '0xc0767ce39364dce50e91a58cb1ac7d8882d01d9765676b63728c5c13b8a426f7',
    type: HISTORY_FIELD_TYPE,
    content: {
      dataType: 'moveObject',
      type: HISTORY_FIELD_TYPE,
      fields: { name: ESCROW_HISTORY_BYTES, value: ids },
    },
  },
});

const noHistoryField = { error: { code: 'dynamicFieldNotFound', parent_object_id: CIRCLE } };

const rejecting = (message: string) =>
  jest.fn(async () => {
    throw new Error(message);
  });

/**
 * A client serving a fixed set of objects: any id not in `objects` reads as
 * nonexistent, and the history field is absent unless overridden.
 */
function makeClient(
  objects: Record<string, unknown>,
  overrides: Partial<Record<keyof SuiClient, unknown>> = {},
): SuiClient {
  return {
    getObject: jest.fn(async ({ id }: { id: string }) =>
      objects[id] ?? { error: { code: 'notExists', object_id: id } },
    ),
    getDynamicFieldObject: jest.fn(async () => noHistoryField),
    getDynamicFields: jest.fn(async () => ({ data: [], hasNextPage: false, nextCursor: null })),
    ...overrides,
  } as unknown as SuiClient;
}

const withHistory = (ids: string[]) => ({
  getDynamicFieldObject: jest.fn(async () => historyField(ids)),
});

const openedEvent = (escrowId: string, circleId = CIRCLE, cycleNo = 1) => ({
  parsedJson: {
    circle_id: circleId,
    escrow_id: escrowId,
    cycle_no: String(cycleNo),
    recipient: ROTATION[2],
    contribution_amount: '100000',
    required_contributors: 2,
    asset_type: [],
    opened_at_ms: '1788072287141',
  },
});

/** Stands in for whichever endpoint failover settles on. */
const eventsResolvingTo = (data: unknown[]) =>
  failover.mockImplementation(async () => ({ data }) as never);

const readOrderOf = (client: SuiClient): string[] =>
  (client.getObject as jest.Mock).mock.calls.map(([args]) => (args as { id: string }).id);

beforeEach(() => {
  failover.mockReset();
  pooled.mockReset();
  // The fallback paths log on purpose; keep the test output readable.
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('findCurrentCycleEscrow — escrow_history tier', () => {
  it('resolves the newest recorded escrow without touching event history', async () => {
    const client = makeClient(
      { [ESCROW_3]: escrowObject({ id: ESCROW_3 }) },
      withHistory([ESCROW_1, ESCROW_2, ESCROW_3]),
    );

    const found = await findCurrentCycleEscrow('testnet', CIRCLE, { client });

    expect(found?.escrowId).toBe(ESCROW_3);
    expect(found?.source).toBe('escrow_history');
    expect(failover).not.toHaveBeenCalled();
    // Only the newest id can be the current round, so only it is read.
    expect(readOrderOf(client)).toEqual([ESCROW_3]);
  });

  it('looks the field up by its on-chain key: the raw bytes of "escrow_history"', async () => {
    // FIELD_ESCROW_HISTORY is a vector<u8>, not a String. A String-typed
    // lookup derives a different child id and finds nothing.
    const client = makeClient({ [ESCROW_3]: escrowObject({ id: ESCROW_3 }) }, withHistory([ESCROW_3]));

    await findCurrentCycleEscrow('testnet', CIRCLE, { client });

    expect(client.getDynamicFieldObject).toHaveBeenCalledWith({
      parentId: CIRCLE,
      name: { type: 'vector<u8>', value: ESCROW_HISTORY_BYTES },
    });
    expect(ESCROW_HISTORY_FIELD_NAME.value).toEqual(ESCROW_HISTORY_BYTES);
  });

  it('builds the summary from the escrow object itself', async () => {
    const client = makeClient(
      { [ESCROW_3]: escrowObject({ id: ESCROW_3, cycleNo: 2 }) },
      withHistory([ESCROW_3]),
    );

    const found = await findCurrentCycleEscrow('testnet', CIRCLE, { client });

    expect(found).toEqual({
      escrowId: ESCROW_3,
      circleId: CIRCLE,
      cycleNo: 2,
      recipient: ROTATION[2],
      contributionAmount: '100000',
      requiredContributors: 2,
      assetType: USDC.slice(2),
      openedAtMs: 1788072287141,
      source: 'escrow_history',
    });
  });

  it('walks the history newest-first when a cycle number is requested', async () => {
    // A cycle number spans a whole rotation lap, so several escrows share
    // it; the newest escrow of the requested cycle is the one that matters.
    const client = makeClient(
      {
        [ESCROW_1]: escrowObject({ id: ESCROW_1, cycleNo: 1 }),
        [ESCROW_2]: escrowObject({ id: ESCROW_2, cycleNo: 1 }),
        [ESCROW_3]: escrowObject({ id: ESCROW_3, cycleNo: 2 }),
      },
      withHistory([ESCROW_1, ESCROW_2, ESCROW_3]),
    );

    const found = await findCurrentCycleEscrow('testnet', CIRCLE, { client, cycleNo: 1 });

    expect(found?.escrowId).toBe(ESCROW_2);
    expect(readOrderOf(client)).toEqual([ESCROW_3, ESCROW_2]);
  });

  it('uses the pooled failover client when none is injected', async () => {
    const client = makeClient({ [ESCROW_3]: escrowObject({ id: ESCROW_3 }) }, withHistory([ESCROW_3]));
    pooled.mockReturnValue(client);

    const found = await findCurrentCycleEscrow('testnet', CIRCLE);

    expect(found?.escrowId).toBe(ESCROW_3);
    expect(pooled).toHaveBeenCalledWith({ network: 'testnet', rpcUrl: expect.any(String) });
  });
});

describe('findCurrentCycleEscrow — event fallback', () => {
  it('falls back to CycleEscrowOpened for a circle with no escrow_history field', async () => {
    // A circle that predates the indexed opens, or whose rounds went through
    // the original entries: the field does not exist. That is a real answer,
    // but it is not "no round".
    const client = makeClient({ [ESCROW_3]: escrowObject({ id: ESCROW_3 }) });
    eventsResolvingTo([openedEvent(ESCROW_3)]);

    const found = await findCurrentCycleEscrow('testnet', CIRCLE, { client });

    expect(found?.escrowId).toBe(ESCROW_3);
    expect(found?.source).toBe('events');
    // Through the failover chain, never the caller's client: the configured
    // primary cannot serve event history.
    expect(failover).toHaveBeenCalledWith('testnet', 'findCurrentCycleEscrow', expect.any(Function));
  });

  it('reports "not open" only when the field is definitively absent AND no event matches', async () => {
    const client = makeClient({});
    eventsResolvingTo([openedEvent(ESCROW_3, OTHER_CIRCLE)]);

    await expect(findCurrentCycleEscrow('testnet', CIRCLE, { client })).resolves.toBeNull();
  });

  it('still answers from a verified event when the history read fails', async () => {
    const client = makeClient(
      { [ESCROW_3]: escrowObject({ id: ESCROW_3 }) },
      { getDynamicFieldObject: rejecting('Unexpected status code: 429') },
    );
    eventsResolvingTo([openedEvent(ESCROW_3)]);

    const found = await findCurrentCycleEscrow('testnet', CIRCLE, { client });

    expect(found?.escrowId).toBe(ESCROW_3);
    expect(found?.source).toBe('events');
  });

  // The doctrine: the durable source could not be read and the lossy one
  // found nothing in its window. That is unknown, not "not open".
  it('refuses to report "not open" when the history was unreadable and the scan found nothing', async () => {
    const client = makeClient({}, { getDynamicFieldObject: rejecting('Unexpected status code: 429') });
    eventsResolvingTo([]);

    await expect(findCurrentCycleEscrow('testnet', CIRCLE, { client })).rejects.toThrow(/unreadable/);
  });

  it('treats a field error other than not-found as unknown, never as absent', async () => {
    const client = makeClient(
      {},
      { getDynamicFieldObject: jest.fn(async () => ({ error: { code: 'unknown' } })) },
    );
    eventsResolvingTo([]);

    await expect(findCurrentCycleEscrow('testnet', CIRCLE, { client })).rejects.toThrow(/unreadable/);
  });

  it('propagates the failure when every tier fails', async () => {
    const client = makeClient({}, { getDynamicFieldObject: rejecting('fetch failed') });
    failover.mockRejectedValue(new Error('Your request is too frequent'));

    await expect(findCurrentCycleEscrow('testnet', CIRCLE, { client })).rejects.toThrow(/too frequent/);
  });

  it('propagates an event-scan failure even when the field is definitively absent', async () => {
    // Absent history rules out indexed rounds, not un-indexed ones. The scan
    // was the only remaining source, and it did not answer.
    const client = makeClient({});
    failover.mockRejectedValue(new Error('Unexpected status code: 429'));

    await expect(findCurrentCycleEscrow('testnet', CIRCLE, { client })).rejects.toThrow(/429/);
  });
});

describe('findCurrentCycleEscrow — verification', () => {
  it('never returns an event candidate it could not verify', async () => {
    const client = makeClient({}, { getObject: rejecting('Unexpected status code: 429') });
    eventsResolvingTo([openedEvent(ESCROW_3)]);

    await expect(findCurrentCycleEscrow('testnet', CIRCLE, { client })).rejects.toThrow(
      /could not read escrow/,
    );
  });

  it('skips an event candidate that verifies as another circle’s escrow', async () => {
    const client = makeClient({ [IMPOSTER]: escrowObject({ id: IMPOSTER, circleId: OTHER_CIRCLE }) });
    eventsResolvingTo([openedEvent(IMPOSTER)]);

    await expect(findCurrentCycleEscrow('testnet', CIRCLE, { client })).resolves.toBeNull();
  });

  it('does not trust a history entry that verifies as another circle’s escrow', async () => {
    // Cannot happen by construction (record_escrow_opened is package-
    // internal) — which is exactly why it is checked rather than assumed.
    const client = makeClient(
      {
        [IMPOSTER]: escrowObject({ id: IMPOSTER, circleId: OTHER_CIRCLE }),
        [ESCROW_3]: escrowObject({ id: ESCROW_3 }),
      },
      withHistory([IMPOSTER]),
    );
    eventsResolvingTo([openedEvent(ESCROW_3)]);

    const found = await findCurrentCycleEscrow('testnet', CIRCLE, { client });

    expect(found?.escrowId).toBe(ESCROW_3);
    expect(found?.source).toBe('events');
  });

  it('treats a history candidate that cannot be read as unknown — falls back, never "not open"', async () => {
    const client = makeClient(
      {},
      { ...withHistory([ESCROW_3]), getObject: rejecting('socket hang up') },
    );
    eventsResolvingTo([]);

    await expect(findCurrentCycleEscrow('testnet', CIRCLE, { client })).rejects.toThrow(/unreadable/);
  });
});

describe('verifyCycleEscrowForCircle / isCycleEscrowForCircle', () => {
  const client = makeClient({
    [ESCROW_3]: escrowObject({ id: ESCROW_3 }),
    [IMPOSTER]: escrowObject({ id: IMPOSTER, circleId: OTHER_CIRCLE }),
    [CIRCLE]: circleObject,
  });

  it('accepts only a CycleEscrow whose circle_id points back at the circle', async () => {
    expect(await isCycleEscrowForCircle(client, ESCROW_3, CIRCLE)).toBe(true);
    expect(await isCycleEscrowForCircle(client, IMPOSTER, CIRCLE)).toBe(false);
    // Right circle, wrong kind of object.
    expect(await isCycleEscrowForCircle(client, CIRCLE, CIRCLE)).toBe(false);
  });

  it('compares ids by value, not spelling', async () => {
    const upper = '0x' + CIRCLE.slice(2).toUpperCase();
    expect(await isCycleEscrowForCircle(client, ESCROW_3, upper)).toBe(true);
    expect(await isCycleEscrowForCircle(client, ESCROW_3, CIRCLE.slice(2))).toBe(true);
  });

  it('a nonexistent or deleted object is a real "no"', async () => {
    expect(await isCycleEscrowForCircle(client, '0x' + 'ee'.repeat(32), CIRCLE)).toBe(false);
    const deleted = makeClient({}, { getObject: jest.fn(async () => ({ error: { code: 'deleted' } })) });
    expect(await isCycleEscrowForCircle(deleted, ESCROW_3, CIRCLE)).toBe(false);
  });

  it('a failed read is unknown, never "no"', async () => {
    const down = makeClient({}, { getObject: rejecting('Unexpected status code: 429') });
    expect(await isCycleEscrowForCircle(down, ESCROW_3, CIRCLE)).toBeNull();
    const odd = makeClient({}, { getObject: jest.fn(async () => ({ error: { code: 'unknown' } })) });
    expect(await isCycleEscrowForCircle(odd, ESCROW_3, CIRCLE)).toBeNull();
  });

  it('returns the summary alongside a positive verdict', async () => {
    const verified = await verifyCycleEscrowForCircle(client, ESCROW_3, CIRCLE);

    expect(verified.verdict).toBe(true);
    expect(verified.verdict === true && verified.summary.recipient).toBe(ROTATION[2]);
  });
});

describe('readCircleEscrowHistory', () => {
  it('returns the recorded ids in on-chain order, oldest first', async () => {
    const client = makeClient({}, withHistory([ESCROW_1, ESCROW_2, ESCROW_3]));

    expect(await readCircleEscrowHistory(client, CIRCLE)).toEqual({
      kind: 'found',
      escrowIds: [ESCROW_1, ESCROW_2, ESCROW_3],
    });
  });

  it('is absent when the field does not exist', async () => {
    expect(await readCircleEscrowHistory(makeClient({}), CIRCLE)).toEqual({ kind: 'absent' });
  });

  it('is unknown on a read failure or a value it cannot interpret', async () => {
    const down = makeClient({}, { getDynamicFieldObject: rejecting('fetch failed') });
    expect(await readCircleEscrowHistory(down, CIRCLE)).toEqual({ kind: 'unknown' });

    const odd = makeClient(
      {},
      {
        getDynamicFieldObject: jest.fn(async () => ({
          data: { content: { dataType: 'moveObject', fields: { value: 'not-a-vector' } } },
        })),
      },
    );
    expect(await readCircleEscrowHistory(odd, CIRCLE)).toEqual({ kind: 'unknown' });
  });
});

describe('round surfaces resolve through the shared discovery', () => {
  // A surface that hard-wires the event scan reintroduces the retention
  // failure on its own, however the resolver behaves.
  const ROUND_SURFACES = [
    'src/components/CycleEscrowPanel.tsx',
    'src/components/NjangiRoundAlerts.tsx',
  ];

  it.each(ROUND_SURFACES)('%s never scans escrow events directly', (rel) => {
    const source = readFileSync(join(process.cwd(), rel), 'utf8');
    expect(source).not.toContain('CycleEscrowOpened');
    expect(source).not.toContain('ContributionRecorded');
    expect(source).toContain('findCurrentCycleEscrow');
  });
});

/**
 * The rotation pointer is what tells a settled round whether the circle
 * moved on. It is deliberately NOT the cycle number: every round in one lap
 * of the rotation shares `current_cycle`, so only `rotation_order`
 * [`current_position`] separates "round 1 is done" from "the claim never
 * rotated the circle". Reading it wrong either strands the circle on round 1
 * or offers a control that pays the same member twice.
 */
describe('readCircleRotationPointer', () => {
  const ROTATION = [
    '0xe833deaa9c038ac2edd397323ed5dbde1e622aadfd0d526332a214a31f9de17d',
    '0xdf98684462fb5b3e85dffcc34fda108b7c34e7da37ab88f0ae3a530ef804a97d',
    '0x1f8d4bdfa384503b0901c73c9925c5b29dad510766542a30dc3b6904ddba897b',
  ];

  /** Stands in for a pooled SuiClient; only getObject is exercised. */
  const clientReturning = (fields: Record<string, unknown> | null) =>
    ({
      getObject: jest.fn().mockResolvedValue(
        fields
          ? { data: { content: { dataType: 'moveObject', fields } } }
          : { data: { content: { dataType: 'package' } } },
      ),
    }) as never;

  const circleFields = (over: Record<string, unknown> = {}) => ({
    current_cycle: '1',
    current_position: '1',
    rotation_order: ROTATION,
    paused_after_cycle: false,
    ...over,
  });

  // Exact production state of 0xa3fada…675ed after round 1 was claimed.
  it('reads the pointer of a circle whose claim rotated it', async () => {
    const pointer = await readCircleRotationPointer(CIRCLE, 'testnet', clientReturning(circleFields()));

    expect(pointer).toEqual({
      currentCycle: 1,
      currentPosition: 1,
      nextRecipient: ROTATION[1],
      pausedAfterCycle: false,
    });
  });

  it('reads a paused circle whose lap is complete', async () => {
    const pointer = await readCircleRotationPointer(
      CIRCLE,
      'testnet',
      clientReturning(circleFields({ current_position: '2', paused_after_cycle: true })),
    );

    // The contract leaves the position on the member who just collected.
    expect(pointer?.nextRecipient).toBe(ROTATION[2]);
    expect(pointer?.pausedAfterCycle).toBe(true);
  });

  it('reports no recipient when the position runs past the rotation', async () => {
    const pointer = await readCircleRotationPointer(
      CIRCLE,
      'testnet',
      clientReturning(circleFields({ current_position: '3' })),
    );

    expect(pointer?.nextRecipient).toBeNull();
  });

  // Mirrors get_next_payout_recipient, which treats @0x0 as "none".
  it('treats the 0x0 placeholder as no recipient', async () => {
    const pointer = await readCircleRotationPointer(
      CIRCLE,
      'testnet',
      clientReturning(
        circleFields({
          current_position: '0',
          rotation_order: [`0x${'0'.repeat(64)}`, ...ROTATION.slice(1)],
        }),
      ),
    );

    expect(pointer?.nextRecipient).toBeNull();
  });

  // A failed read must not look like a rotation state — the caller renders
  // "unknown" and offers no control, rather than guessing.
  it('propagates an RPC failure instead of inventing a pointer', async () => {
    const client = {
      getObject: jest.fn().mockRejectedValue(new Error('Your request is too frequent')),
    } as never;

    await expect(readCircleRotationPointer(CIRCLE, 'testnet', client)).rejects.toThrow(
      /too frequent/,
    );
  });
});

/**
 * Who has paid is the next thing the panel asks after finding the round,
 * and it used to come ONLY from `ContributionRecorded` events — the same
 * rationed endpoint, one call later. The escrow's own `contributed` table
 * answers by object read: `contribute` adds the sender, the refund paths
 * remove them, and the table's `size` is authoritative.
 */
describe('listContributors — contributed table tier', () => {
  // Table id of ESCROW_3's `contributed` field, as testnet returned it.
  const TABLE = '0x7d9ef12721f756caf5a72bb35031cfc40d7bd10c782f31139026446297310781';
  const PAID = [ROTATION[0], ROTATION[1]];

  const escrowWithTable = (size: number) => {
    const base = escrowObject({ id: ESCROW_3 });
    return {
      data: {
        ...base.data,
        content: {
          ...base.data.content,
          fields: {
            ...base.data.content.fields,
            contributors_count: String(size),
            contributed: {
              type: '0x2::table::Table<address, bool>',
              fields: { id: { id: TABLE }, size: String(size) },
            },
          },
        },
      },
    };
  };
  const tableEntry = (address: string) => ({
    name: { type: 'address', value: address },
    type: 'DynamicField',
    objectType: 'bool',
    objectId: '0x' + 'ab'.repeat(32),
  });
  const tablePage = (addresses: string[], next: string | null = null) => ({
    data: addresses.map(tableEntry),
    hasNextPage: next !== null,
    nextCursor: next,
  });
  const contributionEvent = (contributor: string, escrowId = ESCROW_3) => ({
    parsedJson: { escrow_id: escrowId, contributor, amount: '100000', cycle_no: '1' },
  });

  it('lists who has paid from the escrow’s own table without touching event history', async () => {
    const client = makeClient(
      { [ESCROW_3]: escrowWithTable(2) },
      { getDynamicFields: jest.fn(async () => tablePage(PAID)) },
    );

    const paid = await listContributors(ESCROW_3, 'testnet', client);

    expect(paid).toEqual(PAID);
    expect(client.getDynamicFields).toHaveBeenCalledWith({ parentId: TABLE, cursor: undefined });
    expect(failover).not.toHaveBeenCalled();
  });

  it('reports an empty table as a fact, without listing it', async () => {
    const client = makeClient({ [ESCROW_3]: escrowWithTable(0) });

    expect(await listContributors(ESCROW_3, 'testnet', client)).toEqual([]);
    expect(client.getDynamicFields).not.toHaveBeenCalled();
    expect(failover).not.toHaveBeenCalled();
  });

  it('pages through a large table', async () => {
    const many = [ROTATION[0], ROTATION[1], ROTATION[2]];
    const getDynamicFields = jest
      .fn()
      .mockResolvedValueOnce(tablePage(many.slice(0, 2), 'cursor-1'))
      .mockResolvedValueOnce(tablePage(many.slice(2)));
    const client = makeClient({ [ESCROW_3]: escrowWithTable(3) }, { getDynamicFields });

    expect(await listContributors(ESCROW_3, 'testnet', client)).toEqual(many);
    expect(getDynamicFields).toHaveBeenLastCalledWith({ parentId: TABLE, cursor: 'cursor-1' });
  });

  it('refuses a listing that does not account for every entry — falls back rather than under-reporting', async () => {
    // The table says 3 paid, the listing shows 2: trusting it would tell a
    // member who paid that their share is still due.
    const client = makeClient(
      { [ESCROW_3]: escrowWithTable(3) },
      { getDynamicFields: jest.fn(async () => tablePage(PAID)) },
    );
    const fromEvents = [ROTATION[2], ROTATION[1], ROTATION[0]];
    eventsResolvingTo(fromEvents.map((a) => contributionEvent(a)));

    expect(await listContributors(ESCROW_3, 'testnet', client)).toEqual(fromEvents);
    expect(failover).toHaveBeenCalledWith('testnet', 'listContributors', expect.any(Function));
  });

  it('falls back to ContributionRecorded when the escrow cannot be read', async () => {
    const client = makeClient({}, { getObject: rejecting('Unexpected status code: 429') });
    eventsResolvingTo([contributionEvent(ROTATION[0]), contributionEvent(ROTATION[1], IMPOSTER)]);

    expect(await listContributors(ESCROW_3, 'testnet', client)).toEqual([ROTATION[0]]);
  });

  it('never turns an unreadable table into "nobody has paid"', async () => {
    const client = makeClient({}, { getObject: rejecting('Unexpected status code: 429') });
    eventsResolvingTo([]);

    await expect(listContributors(ESCROW_3, 'testnet', client)).rejects.toThrow(/unreadable/);
  });

  it('propagates the failure when every tier fails', async () => {
    const client = makeClient({}, { getObject: rejecting('fetch failed') });
    failover.mockRejectedValue(new Error('Your request is too frequent'));

    await expect(listContributors(ESCROW_3, 'testnet', client)).rejects.toThrow(/too frequent/);
  });

  it('uses the pooled failover client when none is injected', async () => {
    const client = makeClient(
      { [ESCROW_3]: escrowWithTable(2) },
      { getDynamicFields: jest.fn(async () => tablePage(PAID)) },
    );
    pooled.mockReturnValue(client);

    expect(await listContributors(ESCROW_3, 'testnet')).toEqual(PAID);
    expect(pooled).toHaveBeenCalledWith({ network: 'testnet', rpcUrl: expect.any(String) });
  });
});
