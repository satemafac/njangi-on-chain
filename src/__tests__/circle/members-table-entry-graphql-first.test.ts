/**
 * NJA-3601 (circle page, part 2 of 2) — the members-table read behind the
 * circle page's recovery auto-release control (fetchRecoveryLivenessState in
 * src/pages/circle/[id]/index.tsx), run with fetch and the JSON-RPC client
 * stubbed. readMembersTableEntry asks Sui GraphQL first and JSON-RPC
 * getDynamicFieldObject only when GraphQL gives no confirmed answer; it
 * returns null only for a confirmed absence and throws when both transports
 * fail. memberEntryCanTriggerAutoRelease reads the member's own status and
 * suspension_end_time, as either transport renders them, and throws when
 * either cannot be read: an unreadable member is a failed read, never
 * permission. Nothing here reaches the network: fetch is a stub.
 */
jest.mock('@/services/network-config', () => ({
  ...(jest.requireActual('@/services/network-config') as Record<string, unknown>),
  getCurrentNetwork: () => 'testnet',
  getGraphqlUrlForNetwork: () => 'https://graphql.test.invalid/graphql',
}));

import { memberEntryCanTriggerAutoRelease, readMembersTableEntry } from '@/lib/membership-discovery';

type MembersTableClient = Parameters<typeof readMembersTableEntry>[0];

const TABLE = `0x${'7'.repeat(64)}`;
const MEMBER_HEX = 'ab'.repeat(32);
const MEMBER = `0x${MEMBER_HEX}`;

/** Members as Sui GraphQL and current JSON-RPC render them: a u8 status, an Option<u64> as null or the u64. */
const ACTIVE = { status: 0, suspension_end_time: null, deposit_balance: '5000000' };
const INACTIVE = { status: 1, suspension_end_time: null, deposit_balance: '0' };
const SUSPENDED = { status: 0, suspension_end_time: '1767225600000', deposit_balance: '5000000' };

const graphqlResponse = (body: unknown) =>
  Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });

/** The members entry as Sui GraphQL answers it: the Member's fields under `value.json`. */
const graphqlEntry = (json: unknown) => ({ data: { address: { dynamicField: { value: { json } } } } });

/** The same entry as JSON-RPC getDynamicFieldObject gives it: a Field whose `value` is the Member struct. */
const rpcEntry = (fields: Record<string, unknown>) => ({
  data: {
    objectId: '0x5',
    version: '7',
    digest: 'digest',
    content: {
      dataType: 'moveObject',
      type: '0x2::dynamic_field::Field<address, 0xc::njangi_circles::Member>',
      hasPublicTransfer: false,
      fields: { id: { id: '0x5' }, name: MEMBER, value: { type: '0xc::njangi_circles::Member', fields } },
    },
  },
});

const NOT_FOUND = { error: { code: 'dynamicFieldNotFound', parent_object_id: TABLE } };

const clientWith = (getDynamicFieldObject: jest.Mock): MembersTableClient =>
  ({ getDynamicFieldObject }) as unknown as MembersTableClient;

const realFetch = (globalThis as { fetch?: unknown }).fetch;
let fetchMock: jest.Mock;
let warnSpy: jest.SpyInstance;

beforeEach(() => {
  // GraphQL does not answer unless a test queues an answer.
  fetchMock = jest.fn(() => Promise.reject(new Error('fetch is stubbed: GraphQL does not answer')));
  (globalThis as { fetch?: unknown }).fetch = fetchMock;
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warnSpy.mockRestore();
  (globalThis as { fetch?: unknown }).fetch = realFetch;
});

/** Eligibility of `member` as the page reads it when Sui GraphQL answers (JSON-RPC refusing, NJA-2830). */
async function eligibilityViaGraphql(member: Record<string, unknown>): Promise<boolean> {
  fetchMock.mockImplementationOnce(() => graphqlResponse(graphqlEntry(member)));
  const refused = jest.fn(() => Promise.reject(new Error('JSON-RPC refused (NJA-2830)')));
  const entry = await readMembersTableEntry(clientWith(refused), TABLE, MEMBER);
  if (entry === null) throw new Error('expected a members entry');
  return memberEntryCanTriggerAutoRelease(entry);
}

/** Eligibility of `member` as the page reads it when only JSON-RPC answers. */
async function eligibilityViaJsonRpc(member: Record<string, unknown>): Promise<boolean> {
  const answer = jest.fn(() => Promise.resolve(rpcEntry(member)));
  const entry = await readMembersTableEntry(clientWith(answer), TABLE, MEMBER);
  if (entry === null) throw new Error('expected a members entry');
  return memberEntryCanTriggerAutoRelease(entry);
}

describe('readMembersTableEntry: Sui GraphQL first, JSON-RPC getDynamicFieldObject as the fallback (NJA-3601)', () => {
  it('reads the member over Sui GraphQL, named by its 32 address bytes, without asking JSON-RPC', async () => {
    fetchMock.mockImplementationOnce(() => graphqlResponse(graphqlEntry(ACTIVE)));
    const getDynamicFieldObject = jest.fn(() => Promise.reject(new Error('JSON-RPC refused (NJA-2830)')));

    await expect(readMembersTableEntry(clientWith(getDynamicFieldObject), TABLE, MEMBER)).resolves.toEqual(ACTIVE);
    expect(getDynamicFieldObject).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(request.query).toMatch(/dynamicField\s*\(/);
    expect(request.variables.table).toBe(TABLE);
    expect(Buffer.from(request.variables.bcs, 'base64').toString('hex')).toBe(MEMBER_HEX);
  });

  it('returns null for an absence GraphQL confirms (`dynamicField: null`), without asking JSON-RPC', async () => {
    fetchMock.mockImplementationOnce(() => graphqlResponse({ data: { address: { dynamicField: null } } }));
    const getDynamicFieldObject = jest.fn();

    await expect(readMembersTableEntry(clientWith(getDynamicFieldObject), TABLE, MEMBER)).resolves.toBeNull();
    expect(getDynamicFieldObject).not.toHaveBeenCalled();
  });

  it("falls back to getDynamicFieldObject when GraphQL does not answer, returning the member's own fields", async () => {
    const getDynamicFieldObject = jest.fn(() => Promise.resolve(rpcEntry(INACTIVE)));

    await expect(readMembersTableEntry(clientWith(getDynamicFieldObject), TABLE, MEMBER)).resolves.toEqual(INACTIVE);
    expect(getDynamicFieldObject).toHaveBeenCalledWith({ parentId: TABLE, name: { type: 'address', value: MEMBER } });
  });

  it('treats a GraphQL answer that is not a confirmed one as a failed read and asks JSON-RPC, which may confirm the absence', async () => {
    const unconfirmed: Array<[string, () => Promise<unknown>]> = [
      ['a non-2xx status', () => Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) })],
      ['an errors body', () => graphqlResponse({ errors: [{ message: 'boom' }], data: null })],
      ['address: null', () => graphqlResponse({ data: { address: null } })],
      ['no dynamicField in the answer', () => graphqlResponse({ data: { address: {} } })],
      ['an entry without value.json', () => graphqlResponse(graphqlEntry(undefined))],
      ['a value.json that is not an object', () => graphqlResponse(graphqlEntry('0x1'))],
    ];
    for (const [label, answer] of unconfirmed) {
      fetchMock.mockImplementationOnce(answer);
      const getDynamicFieldObject = jest.fn(() => Promise.resolve(NOT_FOUND));
      await expect(readMembersTableEntry(clientWith(getDynamicFieldObject), TABLE, MEMBER)).resolves.toBeNull();
      expect({ label, jsonRpcAsked: getDynamicFieldObject.mock.calls.length }).toEqual({ label, jsonRpcAsked: 1 });
    }
  });

  it('throws when both transports fail, never returning null or a member', async () => {
    const failedJsonRpc: Array<[string, () => Promise<unknown>]> = [
      ['a rejected request', () => Promise.reject(new Error('JSON-RPC refused (NJA-2830)'))],
      ['an error other than dynamicFieldNotFound', () => Promise.resolve({ error: { code: 'displayError', error: 'boom' } })],
      ['no error and no entry', () => Promise.resolve({ data: null })],
      ['an entry without content', () => Promise.resolve({ data: { objectId: '0x5', version: '7', digest: 'digest' } })],
      [
        'a value without its fields',
        () => Promise.resolve({ data: { content: { dataType: 'moveObject', fields: { name: MEMBER, value: '1' } } } }),
      ],
    ];
    for (const [label, answer] of failedJsonRpc) {
      const getDynamicFieldObject = jest.fn(answer);
      await expect(readMembersTableEntry(clientWith(getDynamicFieldObject), TABLE, MEMBER)).rejects.toThrow(/no source read/);
      expect({ label, jsonRpcAsked: getDynamicFieldObject.mock.calls.length }).toEqual({ label, jsonRpcAsked: 1 });
    }
  });

  it('throws for a value that is not a Sui address, asking neither transport', async () => {
    const getDynamicFieldObject = jest.fn();

    await expect(readMembersTableEntry(clientWith(getDynamicFieldObject), TABLE, 'not-an-address')).rejects.toThrow(/not a Sui address/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getDynamicFieldObject).not.toHaveBeenCalled();
  });
});

describe("memberEntryCanTriggerAutoRelease: eligibility from the member's own fields (NJA-3601)", () => {
  it('answers for active, inactive and suspended members read over Sui GraphQL', async () => {
    expect({
      active: await eligibilityViaGraphql(ACTIVE),
      inactive: await eligibilityViaGraphql(INACTIVE),
      suspended: await eligibilityViaGraphql(SUSPENDED),
    }).toEqual({ active: true, inactive: false, suspended: false });
  });

  it('answers the same for members read over the JSON-RPC fallback, in either Option rendering', async () => {
    const none = { type: '0x1::option::Option<u64>', fields: { vec: [] } };
    const some = { type: '0x1::option::Option<u64>', fields: { vec: ['1767225600000'] } };
    expect({
      active: await eligibilityViaJsonRpc(ACTIVE),
      inactive: await eligibilityViaJsonRpc(INACTIVE),
      suspended: await eligibilityViaJsonRpc(SUSPENDED),
      activeOptionStruct: await eligibilityViaJsonRpc({ status: 0, suspension_end_time: none }),
      suspendedOptionStruct: await eligibilityViaJsonRpc({ status: 0, suspension_end_time: some }),
    }).toEqual({ active: true, inactive: false, suspended: false, activeOptionStruct: true, suspendedOptionStruct: false });
  });

  it('reads a status rendered as a number or a decimal string, and an Option rendered as a bare `{ vec }`', () => {
    expect({
      zeroString: memberEntryCanTriggerAutoRelease({ status: '0', suspension_end_time: null }),
      oneString: memberEntryCanTriggerAutoRelease({ status: '1', suspension_end_time: null }),
      emptyVec: memberEntryCanTriggerAutoRelease({ status: 0, suspension_end_time: { vec: [] } }),
      filledVec: memberEntryCanTriggerAutoRelease({ status: 0, suspension_end_time: { vec: ['1767225600000'] } }),
    }).toEqual({ zeroString: true, oneString: false, emptyVec: true, filledVec: false });
  });

  it('throws when status or suspension_end_time is missing or unreadable, never granting or refusing', () => {
    const unreadable: Array<Record<string, unknown>> = [
      { suspension_end_time: null },
      { status: 'active', suspension_end_time: null },
      { status: -1, suspension_end_time: null },
      { status: 0.5, suspension_end_time: null },
      { status: 0 },
      { status: 0, suspension_end_time: {} },
      { status: 0, suspension_end_time: { vec: ['1', '2'] } },
      { status: 0, suspension_end_time: { vec: ['soon'] } },
      { status: 0, suspension_end_time: 'soon' },
      // The dynamic-field wrapper is not the member: its status is one level down.
      { id: { id: '0x5' }, name: MEMBER, value: { type: '0xc::njangi_circles::Member', fields: INACTIVE } },
    ];
    for (const member of unreadable) {
      expect(() => memberEntryCanTriggerAutoRelease(member)).toThrow(/members entry without a readable/);
    }
  });
});
