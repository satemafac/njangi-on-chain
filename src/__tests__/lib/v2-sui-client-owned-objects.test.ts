/**
 * NJA-3968 (Sui reads 1b): v2ListOwnedObjects, the owned-object listing the
 * reading client's getOwnedObjects is served from (reading-sui-client.ts).
 * It reads every page on one transport, gRPC first, and starts GraphQL over
 * from the first page when gRPC does not finish, since cursors do not carry
 * across. A listing neither transport finishes throws: it is never an empty
 * list or the pages read so far.
 *
 * The 2.x transports are stubs (@mysten/sui-v2 is ESM-only and never loads in
 * Jest): each one's core.listOwnedObjects is a jest.fn below. Nothing here
 * reaches the network.
 */

const mockGrpcListOwnedObjects = jest.fn();
const mockGraphqlListOwnedObjects = jest.fn();

jest.mock('../../services/network-config', () => ({
  getGraphqlUrlForNetwork: () => 'https://graphql.example.invalid',
}));
jest.mock('../../lib/v2-tx-mapping', () => ({
  isTxTransportError: jest.fn(() => true),
  toDryRunError: jest.fn(),
  toJsonRpcBalance: jest.fn(),
  toJsonRpcCoinPage: jest.fn(),
  toJsonRpcExecution: jest.fn(),
}));
jest.mock(
  '@mysten/sui-v2/grpc',
  () => ({
    SuiGrpcClient: class {
      core = { listOwnedObjects: (input: unknown) => mockGrpcListOwnedObjects(input) };
    },
  }),
  { virtual: true },
);
jest.mock(
  '@mysten/sui-v2/graphql',
  () => ({
    SuiGraphQLClient: class {
      core = { listOwnedObjects: (input: unknown) => mockGraphqlListOwnedObjects(input) };
    },
  }),
  { virtual: true },
);
jest.mock('@mysten/sui-v2/transactions', () => ({ Transaction: class {} }), { virtual: true });

import { MAX_OWNED_OBJECT_PAGES, v2ListOwnedObjects } from '../../lib/v2-sui-client';

const OWNER = `0x${'a1'.repeat(32)}`;
const PACKAGE = `0x${'c0'.repeat(32)}`;
const CAP_TYPE = `${PACKAGE}::njangi_compliance::AttestorCap`;

const idOf = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;

/** An object as a 2.x transport lists it. */
const listedObject = (n: number, type = CAP_TYPE) => ({
  objectId: idOf(n),
  version: String(100 + n),
  digest: `digest${n}`,
  type,
  owner: { $kind: 'AddressOwner', AddressOwner: OWNER },
});

/** One page of listOwnedObjects; `next` null ends the listing. */
const pageOf = (ns: number[], next: string | null) => ({
  objects: ns.map((n) => listedObject(n)),
  hasNextPage: next !== null,
  cursor: next,
});

/** What v2ListOwnedObjects returns for those objects. */
const refsOf = (ns: number[], type = CAP_TYPE) =>
  ns.map((n) => ({ objectId: idOf(n), version: String(100 + n), digest: `digest${n}`, type }));

const cursorsAsked = (transport: jest.Mock) =>
  transport.mock.calls.map(([input]) => (input as { cursor?: string }).cursor);

const listAll = (type = CAP_TYPE) => v2ListOwnedObjects('testnet', OWNER, type);

beforeEach(() => {
  mockGrpcListOwnedObjects.mockReset();
  mockGraphqlListOwnedObjects.mockReset();
});

describe('v2ListOwnedObjects (NJA-3968)', () => {
  it('reads every gRPC page, following each cursor, and returns the whole listing in order', async () => {
    mockGrpcListOwnedObjects
      .mockResolvedValueOnce(pageOf([1, 2], 'g1'))
      .mockResolvedValueOnce(pageOf([3, 4], 'g2'))
      .mockResolvedValueOnce(pageOf([5], null));

    await expect(listAll()).resolves.toEqual(refsOf([1, 2, 3, 4, 5]));
    expect(cursorsAsked(mockGrpcListOwnedObjects)).toEqual([undefined, 'g1', 'g2']);
    expect(mockGrpcListOwnedObjects).toHaveBeenCalledWith(expect.objectContaining({ owner: OWNER, type: CAP_TYPE }));
    expect(mockGraphqlListOwnedObjects).not.toHaveBeenCalled();
  });

  it('answers an empty list only when a transport says the listing ends there', async () => {
    mockGrpcListOwnedObjects.mockResolvedValueOnce(pageOf([], null));

    await expect(listAll()).resolves.toEqual([]);
    expect(mockGraphqlListOwnedObjects).not.toHaveBeenCalled();
  });

  it('starts GraphQL over from the first page when a later gRPC page fails, keeping nothing gRPC read', async () => {
    mockGrpcListOwnedObjects
      .mockResolvedValueOnce(pageOf([1, 2], 'g1'))
      .mockRejectedValueOnce(new Error('14 UNAVAILABLE: connection reset'));
    mockGraphqlListOwnedObjects
      .mockResolvedValueOnce(pageOf([1, 2], 'q1'))
      .mockResolvedValueOnce(pageOf([3], null));

    await expect(listAll()).resolves.toEqual(refsOf([1, 2, 3]));
    expect(cursorsAsked(mockGrpcListOwnedObjects)).toEqual([undefined, 'g1']);
    expect(cursorsAsked(mockGraphqlListOwnedObjects)).toEqual([undefined, 'q1']);
  });

  it('throws when neither transport pages to the end: a next page without a new cursor cuts the listing short', async () => {
    // gRPC: more to come, but no cursor to ask for it.
    mockGrpcListOwnedObjects.mockResolvedValueOnce({ objects: [listedObject(1)], hasNextPage: true, cursor: null });
    // GraphQL: its second page hands back the cursor it was asked with.
    mockGraphqlListOwnedObjects
      .mockResolvedValueOnce(pageOf([1], 'q1'))
      .mockResolvedValueOnce(pageOf([2], 'q1'));

    await expect(listAll()).rejects.toThrow('a next page without a new cursor');
    expect(mockGrpcListOwnedObjects).toHaveBeenCalledTimes(1);
    expect(mockGraphqlListOwnedObjects).toHaveBeenCalledTimes(2);
  });

  it('throws when neither transport finishes within MAX_OWNED_OBJECT_PAGES pages, rather than return the pages read', async () => {
    let n = 0;
    const endless = async () => {
      n += 1;
      return pageOf([n], `c${n}`);
    };
    mockGrpcListOwnedObjects.mockImplementation(endless);
    mockGraphqlListOwnedObjects.mockImplementation(endless);

    await expect(listAll()).rejects.toThrow(`more than ${MAX_OWNED_OBJECT_PAGES} pages`);
    expect(mockGrpcListOwnedObjects).toHaveBeenCalledTimes(MAX_OWNED_OBJECT_PAGES);
    expect(mockGraphqlListOwnedObjects).toHaveBeenCalledTimes(MAX_OWNED_OBJECT_PAGES);
  });

  it('throws when the pages are malformed: a page without its list, an object without its digest', async () => {
    mockGrpcListOwnedObjects.mockResolvedValueOnce({ hasNextPage: false, cursor: null });
    mockGraphqlListOwnedObjects.mockResolvedValueOnce({
      objects: [listedObject(1), { ...listedObject(2), digest: undefined }],
      hasNextPage: false,
      cursor: null,
    });

    await expect(listAll()).rejects.toThrow('without its id, version, digest or type');
    expect(mockGrpcListOwnedObjects).toHaveBeenCalledTimes(1);
    expect(mockGraphqlListOwnedObjects).toHaveBeenCalledTimes(1);
  });

  it('throws when a transport lists an object of another type, rather than hand it back or drop it', async () => {
    const other = `${PACKAGE}::njangi_compliance::ComplianceAttestation`;
    const mixed = { objects: [listedObject(1), listedObject(2, other)], hasNextPage: false, cursor: null };
    mockGrpcListOwnedObjects.mockResolvedValueOnce(mixed);
    mockGraphqlListOwnedObjects.mockResolvedValueOnce(mixed);

    await expect(listAll()).rejects.toThrow(`of type ${other}`);
  });

  it('compares Move types at full width, and a type without type arguments names each instantiation', async () => {
    const claim = `${PACKAGE}::njangi_cycle_escrow::Claim`;
    const fullWidth = `${claim}<0x${'0'.repeat(63)}2::sui::SUI>`;
    mockGrpcListOwnedObjects.mockResolvedValue({ objects: [listedObject(1, fullWidth)], hasNextPage: false, cursor: null });

    await expect(listAll(`${claim}<0x2::sui::SUI>`)).resolves.toEqual(refsOf([1], fullWidth));
    await expect(listAll(claim)).resolves.toEqual(refsOf([1], fullWidth));
    expect(mockGraphqlListOwnedObjects).not.toHaveBeenCalled();
  });
});
