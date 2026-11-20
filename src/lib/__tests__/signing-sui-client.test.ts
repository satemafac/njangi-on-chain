// The signing client: the pooled 1.x client, plus a transport and coin reads
// served by @mysten/sui 2.x (mocked here; v2-sui-client.ts is ESM-only and
// never loads under Jest), falling back to JSON-RPC on transport failures.

const v2Execute = jest.fn();
const v2GetCoins = jest.fn();
const v2GetBalance = jest.fn();

jest.mock('../v2-sui-client', () => ({
  v2TxTransports: async () => [
    { name: 'v2-grpc', build: jest.fn(), execute: (...a: unknown[]) => v2Execute('grpc', ...a), waitForTransaction: jest.fn() },
    { name: 'v2-graphql', build: jest.fn(), execute: (...a: unknown[]) => v2Execute('graphql', ...a), waitForTransaction: jest.fn() },
  ],
  v2Reads: () => ({
    getCoins: (input: unknown) => v2GetCoins(input),
    getBalance: (input: unknown) => v2GetBalance(input),
    dynamicFieldValueJson: jest.fn(),
  }),
}));

const pooled = {
  transport: { name: 'pooled-transport' },
  getCoins: jest.fn().mockResolvedValue({ data: ['from json-rpc'], hasNextPage: false, nextCursor: null }),
  getBalance: jest.fn().mockResolvedValue({ totalBalance: 'from json-rpc' }),
  getObject: jest.fn().mockResolvedValue({ data: 'object from json-rpc' }),
  executeTransactionBlock: jest.fn().mockResolvedValue({ digest: 'JSONRPC', effects: { status: { status: 'success' } } }),
};

jest.mock('@/services/sui-rpc-failover', () => ({
  getPooledSuiClient: () => pooled,
  isRetriableSuiRpcError: () => false,
  isJsonRpcWithdrawnError: (m: string) => /json-?rpc/i.test(m) && /deprecated/i.test(m),
}));
jest.mock('@/services/network-config', () => ({ getCurrentNetwork: () => 'testnet' }));

import { getSigningSuiClient } from '../signing-sui-client';
import { attachedTxTransport, attachedV2Reads } from '../tx-transport';

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

it('serves coin reads from 2.x', async () => {
  v2GetCoins.mockResolvedValue({ data: ['from v2'], hasNextPage: false, nextCursor: null });
  const client = getSigningSuiClient('testnet');
  await expect(client.getCoins({ owner: '0xme', coinType: '0x2::sui::SUI' })).resolves.toMatchObject({ data: ['from v2'] });
  expect(pooled.getCoins).not.toHaveBeenCalled();
});

it('falls back to JSON-RPC for a coin read when 2.x is unreachable', async () => {
  v2GetBalance.mockRejectedValue(new TypeError('Failed to fetch'));
  const client = getSigningSuiClient('testnet');
  await expect(client.getBalance({ owner: '0xme' })).resolves.toEqual({ totalBalance: 'from json-rpc' });
});

it('does not paper over a 2.x answer with JSON-RPC', async () => {
  v2GetCoins.mockRejectedValue(new Error('Invalid owner address'));
  const client = getSigningSuiClient('testnet');
  await expect(client.getCoins({ owner: 'nope' })).rejects.toThrow('Invalid owner address');
  expect(pooled.getCoins).not.toHaveBeenCalled();
});

it('leaves every other method on the pooled client', async () => {
  const client = getSigningSuiClient('testnet');
  await expect(client.getObject({ id: '0x6' })).resolves.toEqual({ data: 'object from json-rpc' });
  expect((client as unknown as { transport: unknown }).transport).toBe(pooled.transport);
});

it('submits via gRPC, then GraphQL, then JSON-RPC, with the same bytes each time', async () => {
  v2Execute.mockRejectedValue(new Error('UNAVAILABLE'));
  const transport = attachedTxTransport(getSigningSuiClient('testnet'))!;
  const bytes = new Uint8Array([9]);

  await expect(transport.execute(bytes, 'SIG')).resolves.toMatchObject({ digest: 'JSONRPC' });
  expect(v2Execute.mock.calls).toEqual([
    ['grpc', bytes, 'SIG'],
    ['graphql', bytes, 'SIG'],
  ]);
  expect(pooled.executeTransactionBlock).toHaveBeenCalledWith(expect.objectContaining({ transactionBlock: bytes, signature: 'SIG' }));
});

it('exposes the 2.x reads for callers that parse raw JSON themselves', () => {
  expect(attachedV2Reads(getSigningSuiClient('testnet'))).toBeDefined();
});
