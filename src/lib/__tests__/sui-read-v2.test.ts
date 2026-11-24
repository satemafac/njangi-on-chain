// sui-read.ts when the pooled client carries a 2.x read source (production):
// objects and dynamic fields from the source (Sui gRPC, then GraphQL), events
// from Sui GraphQL read to the end, all in JSON-RPC's shapes. The source is a
// stub here, so nothing reaches the network.
//
// What must hold: a read that fails is never a fact. "Gone" only when the
// source answered that the object does not exist; an answer of an unexpected
// Move type, one that cannot be read, or no answer at all throws a
// SuiReadError; a dynamic field is "not found" only on a confirmed absence.

jest.mock('@/services/network-config', () => ({
  getCurrentNetwork: () => 'testnet',
}));
jest.mock('@/services/sui-rpc-failover', () => ({
  getPooledSuiClient: jest.fn(),
}));

import { deriveDynamicFieldID } from '@mysten/sui/utils';
import { getPooledSuiClient } from '@/services/sui-rpc-failover';
import {
  clearSuiReadCache,
  invalidateObject,
  isDynamicFieldMissingResponse,
  isGoneObjectResponse,
  listDynamicFields,
  queryEventsCached,
  readAllEvents,
  readDynamicFieldObject,
  readObject,
  SuiReadError,
} from '@/lib/sui-read';
import { rpcValueToBcs, type MoveLayout } from '@/lib/move-json-rpc';
import { attachV2ReadSource, type V2ObjectResult, type V2ReadSource } from '@/lib/v2-read-source';
import type { GraphqlEventRecord } from '@/lib/sui-graphql-reads';

const PKG = `0x${'5a'.repeat(32)}`;
const SYS2 = `0x${'0'.repeat(63)}2`;
const CIRCLE = `0x${'c1'.repeat(32)}`;
const OTHER = `0x${'c2'.repeat(32)}`;
const TABLE = `0x${'7a'.repeat(32)}`;
const ADMIN = `0x${'ad'.repeat(32)}`;
const CHILD = `0x${'cd'.repeat(32)}`;

const UID: MoveLayout = {
  struct: {
    type: `${SYS2}::object::UID`,
    fields: [{ name: 'id', layout: { struct: { type: `${SYS2}::object::ID`, fields: [{ name: 'bytes', layout: 'address' }] } } }],
  },
};
const CIRCLE_TYPE = `${PKG}::njangi_circles::Circle`;
const MEMBER_TYPE = `${PKG}::njangi_members::Member`;
const FIELD_TYPE = `${SYS2}::dynamic_field::Field<address,${MEMBER_TYPE}>`;
const EVENT_TYPE = `${PKG}::njangi_circles::MemberJoined`;

const LAYOUTS: Record<string, MoveLayout> = {
  [CIRCLE_TYPE]: {
    struct: {
      type: CIRCLE_TYPE,
      fields: [
        { name: 'id', layout: UID },
        { name: 'admin', layout: 'address' },
        {
          name: 'members',
          layout: {
            struct: {
              type: `${SYS2}::table::Table<address,${MEMBER_TYPE}>`,
              fields: [
                { name: 'id', layout: UID },
                { name: 'size', layout: 'u64' },
              ],
            },
          },
        },
      ],
    },
  },
  [FIELD_TYPE]: {
    struct: {
      type: FIELD_TYPE,
      fields: [
        { name: 'id', layout: UID },
        { name: 'name', layout: 'address' },
        { name: 'value', layout: { struct: { type: MEMBER_TYPE, fields: [{ name: 'deposit_paid', layout: 'bool' }] } } },
      ],
    },
  },
  [EVENT_TYPE]: {
    struct: {
      type: EVENT_TYPE,
      fields: [
        { name: 'circle_id', layout: 'address' },
        { name: 'member', layout: 'address' },
        { name: 'tag', layout: { vector: 'u8' } },
      ],
    },
  },
};

const circleRecord = (id = CIRCLE, type = CIRCLE_TYPE): V2ObjectResult => ({
  kind: 'found',
  object: {
    objectId: id,
    version: '9',
    digest: 'D1',
    type,
    owner: { $kind: 'Shared', Shared: { initialSharedVersion: '3' } },
    json: { id, admin: ADMIN, members: { id: TABLE, size: '2' } },
  },
});

let answers: Map<string, V2ObjectResult>;
let source: V2ReadSource & {
  getObjects: jest.Mock;
  listDynamicFields: jest.Mock;
  readAllEvents: jest.Mock;
  typeLayout: jest.Mock;
};

beforeEach(() => {
  clearSuiReadCache();
  answers = new Map();
  source = {
    network: 'testnet',
    getObjects: jest.fn(async (ids: string[]) =>
      ids.map((id): V2ObjectResult => answers.get(id) ?? { kind: 'failed', error: new Error('no transport answered') }),
    ),
    listDynamicFields: jest.fn(async () => []),
    readAllEvents: jest.fn(async () => []),
    typeLayout: jest.fn(async (type: string) => {
      const layout = LAYOUTS[type];
      if (!layout) throw new Error(`no layout for ${type}`);
      return { layout, abilities: ['KEY'] };
    }),
  };
  (getPooledSuiClient as jest.Mock).mockReturnValue(attachV2ReadSource({}, source));
});

describe('readObject over the 2.x source', () => {
  it('answers in JSON-RPC shape, batching concurrent reads into one source call', async () => {
    answers.set(CIRCLE, circleRecord());
    answers.set(OTHER, circleRecord(OTHER));
    const options = { showContent: true, showType: true, showOwner: true };
    const [a, b] = await Promise.all([readObject(CIRCLE, options), readObject(OTHER, options)]);

    expect(source.getObjects).toHaveBeenCalledTimes(1);
    expect(source.getObjects.mock.calls[0][0]).toEqual([CIRCLE, OTHER]);
    expect(a.data).toEqual({
      objectId: CIRCLE,
      version: '9',
      digest: 'D1',
      type: CIRCLE_TYPE,
      owner: { Shared: { initial_shared_version: 3 } },
      content: {
        dataType: 'moveObject',
        type: CIRCLE_TYPE,
        hasPublicTransfer: false,
        fields: {
          id: { id: CIRCLE },
          admin: ADMIN,
          members: { type: `0x2::table::Table<address, ${MEMBER_TYPE}>`, fields: { id: { id: TABLE }, size: '2' } },
        },
      },
    });
    expect(b.data?.objectId).toBe(OTHER);
  });

  it('looks a type layout up once for every object of that type', async () => {
    answers.set(CIRCLE, circleRecord());
    answers.set(OTHER, circleRecord(OTHER));
    await Promise.all([readObject(CIRCLE), readObject(OTHER)]);
    expect(source.typeLayout).toHaveBeenCalledTimes(1);
  });

  it('is gone only when the source said the object does not exist', async () => {
    answers.set(CIRCLE, { kind: 'gone' });
    const response = await readObject(CIRCLE);
    expect(isGoneObjectResponse(response)).toBe(true);
  });

  it('does not keep a gone answer: an object created a moment later is read', async () => {
    answers.set(CIRCLE, { kind: 'gone' });
    await readObject(CIRCLE);
    answers.set(CIRCLE, circleRecord());
    await expect(readObject(CIRCLE)).resolves.toMatchObject({ data: { objectId: CIRCLE } });
    expect(source.getObjects).toHaveBeenCalledTimes(2);
  });

  it('throws when no source answered, and does not cache the failure', async () => {
    await expect(readObject(CIRCLE)).rejects.toMatchObject({ name: 'SuiReadError', reason: 'unavailable' });
    answers.set(CIRCLE, circleRecord());
    await expect(readObject(CIRCLE)).resolves.toMatchObject({ data: { objectId: CIRCLE } });
  });

  it('throws for every id when the source cannot run at all', async () => {
    source.getObjects.mockRejectedValueOnce(new Error('module failed to load'));
    const results = await Promise.allSettled([readObject(CIRCLE), readObject(OTHER)]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
  });

  it('counts an answer only when it is of the expected Move type', async () => {
    answers.set(CIRCLE, circleRecord());
    answers.set(OTHER, circleRecord(OTHER, `${SYS2}::clock::Clock`));
    LAYOUTS[`${SYS2}::clock::Clock`] = { struct: { type: `${SYS2}::clock::Clock`, fields: [] } };
    await expect(readObject(CIRCLE, { showContent: true }, { expectType: '::njangi_circles::Circle' })).resolves.toMatchObject({
      data: { objectId: CIRCLE },
    });
    const other = { ...circleRecord(OTHER, `${SYS2}::clock::Clock`) } as V2ObjectResult & { kind: 'found' };
    other.object.json = {};
    answers.set(OTHER, other);
    await expect(readObject(OTHER, { showContent: true }, { expectType: '::njangi_circles::Circle' })).rejects.toMatchObject({
      reason: 'unexpected-type',
    });
  });

  it('throws when the layout cannot be read or the JSON does not match it', async () => {
    answers.set(CIRCLE, circleRecord(CIRCLE, `${PKG}::njangi_circles::Unknown`));
    await expect(readObject(CIRCLE)).rejects.toMatchObject({ reason: 'unavailable' });

    clearSuiReadCache();
    const broken = circleRecord() as V2ObjectResult & { kind: 'found' };
    broken.object.json = { id: CIRCLE, admin: ADMIN };
    answers.set(CIRCLE, broken);
    await expect(readObject(CIRCLE)).rejects.toMatchObject({ reason: 'unreadable' });
  });

  it('refuses options it cannot serve instead of leaving them out', async () => {
    answers.set(CIRCLE, circleRecord());
    await expect(readObject(CIRCLE, { showBcs: true })).rejects.toMatchObject({ reason: 'unsupported' });
    expect(source.getObjects).not.toHaveBeenCalled();
  });
});

const event = (over: Partial<GraphqlEventRecord>): GraphqlEventRecord => ({
  txDigest: 'T1',
  eventSeq: '0',
  timestampMs: '1000',
  sender: ADMIN,
  packageId: PKG,
  transactionModule: 'njangi_circles',
  type: EVENT_TYPE,
  json: { circle_id: CIRCLE, member: ADMIN, tag: 'c3Vp' },
  bcs: null,
  ...over,
});

describe('events from Sui GraphQL', () => {
  it('returns the whole list as one page in JSON-RPC shape, newest first when asked', async () => {
    source.readAllEvents.mockResolvedValue([event({}), event({ txDigest: 'T2', timestampMs: '2000' })]);
    const page = await queryEventsCached({ query: { MoveEventType: EVENT_TYPE }, limit: 1, order: 'descending' });

    expect(source.readAllEvents).toHaveBeenCalledWith({ type: EVENT_TYPE });
    expect(page.hasNextPage).toBe(false);
    expect(page.nextCursor).toBeNull();
    expect(page.data.map((e) => e.id.txDigest)).toEqual(['T2', 'T1']);
    expect(page.data[1]).toMatchObject({
      id: { txDigest: 'T1', eventSeq: '0' },
      type: EVENT_TYPE,
      sender: ADMIN,
      timestampMs: '1000',
      parsedJson: { circle_id: CIRCLE, member: ADMIN, tag: [115, 117, 105] },
    });
  });

  it('throws when the list cannot be read to its end, never an empty list', async () => {
    source.readAllEvents.mockRejectedValue(new Error('page 3 failed'));
    await expect(readAllEvents({ MoveEventType: EVENT_TYPE })).rejects.toMatchObject({ reason: 'unavailable' });
  });

  it('refuses a filter Sui GraphQL cannot express', async () => {
    await expect(readAllEvents({ TimeRange: { startTime: '0', endTime: '1' } })).rejects.toBeInstanceOf(SuiReadError);
    expect(source.readAllEvents).not.toHaveBeenCalled();
  });

  it('maps module and sender filters', async () => {
    await readAllEvents({ MoveModule: { package: PKG, module: 'njangi_circles' } });
    await readAllEvents({ Sender: ADMIN });
    expect(source.readAllEvents.mock.calls).toEqual([[{ module: `${PKG}::njangi_circles` }], [{ sender: ADMIN }]]);
  });
});

describe('dynamic fields', () => {
  const memberFieldId = () => deriveDynamicFieldID(TABLE, 'address', rpcValueToBcs(ADMIN, 'address'));

  it('lists every field with its name decoded as JSON-RPC rendered it', async () => {
    source.listDynamicFields.mockResolvedValue([
      {
        kind: 'DynamicField',
        fieldId: `0x${'f1'.repeat(32)}`,
        nameType: 'vector<u8>',
        nameBcs: rpcValueToBcs('circle_config', { vector: 'u8' }),
        valueType: `${PKG}::njangi_circle_config::CircleConfig`,
      },
      {
        kind: 'DynamicObject',
        fieldId: `0x${'f2'.repeat(32)}`,
        childId: CHILD,
        nameType: 'address',
        nameBcs: rpcValueToBcs(ADMIN, 'address'),
        valueType: `${SYS2}::coin::Coin<${SYS2}::sui::SUI>`,
      },
    ]);
    const fields = await listDynamicFields(CIRCLE);
    expect(fields).toEqual([
      expect.objectContaining({
        name: { type: 'vector<u8>', value: Array.from(Buffer.from('circle_config')) },
        type: 'DynamicField',
        objectId: `0x${'f1'.repeat(32)}`,
        objectType: `${PKG}::njangi_circle_config::CircleConfig`,
      }),
      expect.objectContaining({
        name: { type: 'address', value: ADMIN },
        type: 'DynamicObject',
        objectId: CHILD,
        objectType: '0x2::coin::Coin<0x2::sui::SUI>',
      }),
    ]);
  });

  it('throws when the list cannot be read to its end', async () => {
    source.listDynamicFields.mockRejectedValue(new Error('page 2 failed'));
    await expect(listDynamicFields(CIRCLE)).rejects.toMatchObject({ reason: 'unavailable' });
  });

  it('reads a members-table entry by its derived id', async () => {
    const id = memberFieldId();
    answers.set(id, {
      kind: 'found',
      object: {
        objectId: id,
        version: '4',
        digest: 'D2',
        type: FIELD_TYPE,
        owner: { $kind: 'ObjectOwner', ObjectOwner: TABLE },
        json: { id, name: ADMIN, value: { deposit_paid: true } },
      },
    });
    const response = await readDynamicFieldObject(TABLE, { type: 'address', value: ADMIN });
    expect(response.data?.content).toMatchObject({
      fields: { name: ADMIN, value: { type: MEMBER_TYPE, fields: { deposit_paid: true } } },
    });
  });

  it('answers dynamicFieldNotFound only when both the field and an object field are confirmed absent', async () => {
    source.getObjects.mockImplementation(async (ids: string[]) => ids.map(() => ({ kind: 'gone' })));
    const response = await readDynamicFieldObject(TABLE, { type: 'address', value: ADMIN });
    expect(isDynamicFieldMissingResponse(response)).toBe(true);
  });

  it('throws, never "not a member", when the entry cannot be read', async () => {
    await expect(readDynamicFieldObject(TABLE, { type: 'address', value: ADMIN })).rejects.toBeInstanceOf(SuiReadError);
  });

  it('follows a dynamic object field to its child object', async () => {
    const key = rpcValueToBcs(ADMIN, 'address');
    const wrapperId = deriveDynamicFieldID(TABLE, `0x2::dynamic_object_field::Wrapper<address>`, key);
    const wrapperType = `${SYS2}::dynamic_field::Field<${SYS2}::dynamic_object_field::Wrapper<address>,${SYS2}::object::ID>`;
    LAYOUTS[wrapperType] = {
      struct: {
        type: wrapperType,
        fields: [
          { name: 'id', layout: UID },
          { name: 'name', layout: { struct: { type: `${SYS2}::dynamic_object_field::Wrapper<address>`, fields: [{ name: 'name', layout: 'address' }] } } },
          { name: 'value', layout: { struct: { type: `${SYS2}::object::ID`, fields: [{ name: 'bytes', layout: 'address' }] } } },
        ],
      },
    };
    answers.set(memberFieldId(), { kind: 'gone' });
    answers.set(wrapperId, {
      kind: 'found',
      object: { objectId: wrapperId, version: '1', digest: 'W', type: wrapperType, owner: null, json: { id: wrapperId, name: { name: ADMIN }, value: CHILD } },
    });
    answers.set(CHILD, circleRecord(CHILD));
    const response = await readDynamicFieldObject(TABLE, { type: 'address', value: ADMIN });
    expect(response.data?.objectId).toBe(CHILD);
  });
});

describe('after a write (review of #175, issue 1)', () => {
  const memberFieldId = () => deriveDynamicFieldID(TABLE, 'address', rpcValueToBcs(ADMIN, 'address'));
  const memberRecord = (paid: boolean): V2ObjectResult => ({
    kind: 'found',
    object: {
      objectId: memberFieldId(),
      version: paid ? '5' : '4',
      digest: 'D',
      type: FIELD_TYPE,
      owner: { $kind: 'ObjectOwner', ObjectOwner: TABLE },
      json: { id: memberFieldId(), name: ADMIN, value: { deposit_paid: paid } },
    },
  });
  const paidFlag = async () => {
    const response = await readDynamicFieldObject(TABLE, { type: 'address', value: ADMIN });
    return (response.data?.content as unknown as { fields: { value: { fields: { deposit_paid: boolean } } } }).fields.value.fields.deposit_paid;
  };

  it('shows the paid flag after a deposit and a refresh: invalidating the circle drops its member records too', async () => {
    answers.set(memberFieldId(), memberRecord(false));
    expect(await paidFlag()).toBe(false);

    // The deposit lands; the page invalidates the CIRCLE id (not the table or field id) and re-reads.
    answers.set(memberFieldId(), memberRecord(true));
    invalidateObject(CIRCLE);
    expect(await paidFlag()).toBe(true);
  });

  it('does not keep or share a read that started before the write', async () => {
    let release: (value: V2ObjectResult[]) => void = () => {};
    source.getObjects.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const before = readObject(CIRCLE);
    await new Promise((resolve) => setTimeout(resolve, 0));

    invalidateObject(CIRCLE);
    answers.set(CIRCLE, circleRecord());
    const after = readObject(CIRCLE);
    release([{ kind: 'gone' }]);

    expect(isGoneObjectResponse(await before)).toBe(true);
    await expect(after).resolves.toMatchObject({ data: { objectId: CIRCLE } });
    // Neither the pre-write answer nor a shared promise serves later readers.
    await expect(readObject(CIRCLE)).resolves.toMatchObject({ data: { objectId: CIRCLE } });
  });
});

describe('pinned Move types (review of #175, issue 5)', () => {
  it('accepts a list of full types and refuses the same struct from another package', async () => {
    const OTHER_PKG = `0x${'ee'.repeat(32)}`;
    answers.set(CIRCLE, circleRecord(CIRCLE, `${OTHER_PKG}::njangi_circles::Circle`));
    LAYOUTS[`${OTHER_PKG}::njangi_circles::Circle`] = LAYOUTS[CIRCLE_TYPE];
    await expect(readObject(CIRCLE, { showContent: true }, { expectType: [CIRCLE_TYPE] })).rejects.toMatchObject({
      reason: 'unexpected-type',
    });

    clearSuiReadCache();
    answers.set(CIRCLE, circleRecord());
    await expect(readObject(CIRCLE, { showContent: true }, { expectType: [`${OTHER_PKG}::x::Y`, CIRCLE_TYPE] })).resolves.toMatchObject({
      data: { objectId: CIRCLE },
    });
  });
});
