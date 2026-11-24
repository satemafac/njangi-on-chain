// v2GetObjects / v2ListDynamicFields (v2-sui-client.ts): @mysten/sui 2.x
// `core` on Sui gRPC first, GraphQL second. The SDK's clients are stubbed
// (the real package is ESM-only and never loads in Jest), so nothing here
// reaches the network.
//
// What must hold: an id is "gone" only when a transport answered notFound;
// an answer for another id, or without its JSON, does not count; whatever
// gRPC did not answer goes to GraphQL; an id neither answered is "failed".

const grpcCore = { getObjects: jest.fn(), listDynamicFields: jest.fn() };
const graphqlCore = { getObjects: jest.fn(), listDynamicFields: jest.fn() };

jest.mock('@mysten/sui-v2/grpc', () => ({ SuiGrpcClient: jest.fn(() => ({ core: grpcCore })) }), { virtual: true });
jest.mock('@mysten/sui-v2/graphql', () => ({ SuiGraphQLClient: jest.fn(() => ({ core: graphqlCore })) }), { virtual: true });
jest.mock('@mysten/sui-v2/transactions', () => ({ Transaction: class {} }), { virtual: true });
jest.mock('@/services/network-config', () => ({
  getGraphqlUrlForNetwork: () => 'https://graphql.test.invalid/graphql',
}));

import { v2GetObjects, v2ListDynamicFields, v2Reads } from '@/lib/v2-sui-client';

const A = `0x${'a1'.repeat(32)}`;
const B = `0x${'b2'.repeat(32)}`;

class ObjectError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly reason: string,
  ) {
    super(message);
  }
}

const object = (id: string, json: Record<string, unknown> | null = { id }) => ({
  objectId: id,
  version: '5',
  digest: 'D',
  type: '0x2::clock::Clock',
  owner: { $kind: 'Shared', Shared: { initialSharedVersion: '1' } },
  json,
});

beforeEach(() => {
  for (const fn of [grpcCore.getObjects, grpcCore.listDynamicFields, graphqlCore.getObjects, graphqlCore.listDynamicFields]) {
    fn.mockReset();
  }
});

describe('v2GetObjects', () => {
  it('answers from gRPC and never asks GraphQL when gRPC answered every id', async () => {
    grpcCore.getObjects.mockResolvedValue({ objects: [object(A), object(B)] });
    const results = await v2GetObjects('testnet', [A, B]);
    expect(results.map((r) => r.kind)).toEqual(['found', 'found']);
    expect(grpcCore.getObjects).toHaveBeenCalledWith({ objectIds: [A, B], include: { json: true } });
    expect(graphqlCore.getObjects).not.toHaveBeenCalled();
  });

  it('treats a GraphQL notFound as a failed read, not gone: GraphQL lags the chain (review of #175, issue 2)', async () => {
    grpcCore.getObjects.mockRejectedValue(new TypeError('Failed to fetch'));
    graphqlCore.getObjects.mockResolvedValue({ objects: [new ObjectError('Object not found', 'notFound', 'notFound')] });
    const [result] = await v2GetObjects('testnet', [A]);
    expect(result.kind).toBe('failed');
  });

  it('treats a gRPC notFound answer as gone', async () => {
    grpcCore.getObjects.mockResolvedValue({ objects: [new ObjectError('not found', 'notExists', 'notFound')] });
    expect(await v2GetObjects('testnet', [A])).toEqual([{ kind: 'gone' }]);
    expect(graphqlCore.getObjects).not.toHaveBeenCalled();
  });

  it('asks GraphQL for every id when gRPC fails as a whole', async () => {
    grpcCore.getObjects.mockRejectedValue(new TypeError('Failed to fetch'));
    graphqlCore.getObjects.mockResolvedValue({ objects: [object(A)] });
    const [result] = await v2GetObjects('testnet', [A]);
    expect(result).toMatchObject({ kind: 'found', object: { objectId: A, type: '0x2::clock::Clock', json: { id: A } } });
  });

  it('asks GraphQL only for the ids gRPC did not answer', async () => {
    grpcCore.getObjects.mockResolvedValue({ objects: [object(A), new ObjectError('internal', 'INTERNAL', 'unknown')] });
    graphqlCore.getObjects.mockResolvedValue({ objects: [object(B)] });
    const results = await v2GetObjects('testnet', [A, B]);
    expect(results.map((r) => r.kind)).toEqual(['found', 'found']);
    expect(graphqlCore.getObjects.mock.calls[0][0].objectIds).toEqual([B]);
  });

  it('does not count an answer for another id, or one without its JSON', async () => {
    grpcCore.getObjects.mockResolvedValue({ objects: [object(B), object(B, null)] });
    graphqlCore.getObjects.mockRejectedValue(new Error('GraphQL down'));
    const results = await v2GetObjects('testnet', [A, B]);
    expect(results.map((r) => r.kind)).toEqual(['failed', 'failed']);
  });

  it('is failed, never gone, when neither transport answers', async () => {
    grpcCore.getObjects.mockRejectedValue(new Error('UNAVAILABLE'));
    graphqlCore.getObjects.mockRejectedValue(new Error('503'));
    const [result] = await v2GetObjects('testnet', [A]);
    expect(result.kind).toBe('failed');
  });

  it('does not count a response with the wrong number of objects', async () => {
    grpcCore.getObjects.mockResolvedValue({ objects: [object(A)] });
    graphqlCore.getObjects.mockResolvedValue({ objects: [object(A), object(B)] });
    const results = await v2GetObjects('testnet', [A, B]);
    expect(results.map((r) => r.kind)).toEqual(['found', 'found']);
    expect(graphqlCore.getObjects).toHaveBeenCalledTimes(1);
  });
});

describe('v2ListDynamicFields', () => {
  const entry = (n: number) => ({
    $kind: 'DynamicField',
    fieldId: `0x${String(n).padStart(64, '0')}`,
    name: { type: 'address', bcs: new Uint8Array(32) },
    valueType: 'u64',
  });

  it('reads every page on gRPC', async () => {
    grpcCore.listDynamicFields
      .mockResolvedValueOnce({ dynamicFields: [entry(1)], hasNextPage: true, cursor: 'c1' })
      .mockResolvedValueOnce({ dynamicFields: [entry(2)], hasNextPage: false, cursor: null });
    const fields = await v2ListDynamicFields('testnet', A);
    expect(fields.map((f) => f.fieldId)).toEqual([entry(1).fieldId, entry(2).fieldId]);
    expect(grpcCore.listDynamicFields.mock.calls[1][0]).toEqual({ parentId: A, cursor: 'c1' });
  });

  it('starts over on GraphQL when a gRPC page fails, never returning part of the list', async () => {
    grpcCore.listDynamicFields
      .mockResolvedValueOnce({ dynamicFields: [entry(1)], hasNextPage: true, cursor: 'c1' })
      .mockRejectedValueOnce(new Error('UNAVAILABLE'));
    graphqlCore.listDynamicFields.mockResolvedValueOnce({ dynamicFields: [entry(1), entry(2)], hasNextPage: false, cursor: null });
    const fields = await v2ListDynamicFields('testnet', A);
    expect(fields).toHaveLength(2);
    expect(graphqlCore.listDynamicFields).toHaveBeenCalledWith({ parentId: A });
  });

  it('throws when neither transport reads the list to its end', async () => {
    grpcCore.listDynamicFields.mockResolvedValue({ dynamicFields: [entry(1)], hasNextPage: true, cursor: null });
    graphqlCore.listDynamicFields.mockRejectedValue(new Error('503'));
    await expect(v2ListDynamicFields('testnet', A)).rejects.toThrow(/v2-read:graphql/);
  });
});

describe('v2Reads.dynamicFieldValueJson', () => {
  it('throws, rather than answer "no such field", when a page says there is more but gives no cursor', async () => {
    grpcCore.listDynamicFields.mockResolvedValue({ dynamicFields: [], hasNextPage: true, cursor: null });
    graphqlCore.listDynamicFields.mockResolvedValue({ dynamicFields: [], hasNextPage: true, cursor: null });
    await expect(v2Reads('testnet').dynamicFieldValueJson(A, '::AssetPolicyKey')).rejects.toThrow(/without a new cursor/);
  });
});
