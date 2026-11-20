import {
  attachedTxTransport,
  failoverTxTransport,
  jsonRpcTxTransport,
  TX_TRANSPORT_KEY,
  txTransportFor,
  type TxTransport,
} from '../tx-transport';
import { isTxTransportError } from '../v2-tx-mapping';

const BYTES = new Uint8Array([1, 2, 3]);

function fake(name: string, behaviour: Partial<Record<keyof Omit<TxTransport, 'name'>, () => Promise<unknown>>>): TxTransport & {
  calls: Array<[string, unknown[]]>;
} {
  const calls: Array<[string, unknown[]]> = [];
  const method = (key: keyof Omit<TxTransport, 'name'>) => async (...args: unknown[]) => {
    calls.push([key, args]);
    const run = behaviour[key];
    if (!run) throw new Error(`${name}.${key} not stubbed`);
    return run();
  };
  return {
    name,
    calls,
    build: method('build') as TxTransport['build'],
    execute: method('execute') as TxTransport['execute'],
    waitForTransaction: method('waitForTransaction') as TxTransport['waitForTransaction'],
  };
}

describe('failoverTxTransport', () => {
  beforeEach(() => jest.spyOn(console, 'warn').mockImplementation(() => {}));

  it('submits the same signed bytes to the next endpoint after a transport failure', async () => {
    const grpc = fake('v2-grpc', { execute: () => Promise.reject(new Error('UNAVAILABLE: no healthy upstream')) });
    const graphql = fake('v2-graphql', { execute: () => Promise.resolve({ digest: 'D', effects: { status: { status: 'success' } } }) });
    const transport = failoverTxTransport([grpc, graphql], isTxTransportError);

    await expect(transport.execute(BYTES, 'SIG')).resolves.toMatchObject({ digest: 'D' });
    expect(grpc.calls).toEqual([['execute', [BYTES, 'SIG']]]);
    expect(graphql.calls).toEqual([['execute', [BYTES, 'SIG']]]);
  });

  it('stops at an answer about the transaction: another endpoint would say the same', async () => {
    const abort = Object.assign(new Error('Dry run failed, could not automatically determine a budget: MoveAbort(…, 234) in command 0'), {
      executionError: { $kind: 'MoveAbort', message: 'x' },
    });
    const grpc = fake('v2-grpc', { build: () => Promise.reject(abort) });
    const graphql = fake('v2-graphql', { build: () => Promise.resolve(BYTES) });
    const transport = failoverTxTransport([grpc, graphql], isTxTransportError);

    await expect(transport.build({} as never)).rejects.toBe(abort);
    expect(graphql.calls).toEqual([]);
  });

  it('rethrows the last failure when every endpoint is down', async () => {
    const down = () => Promise.reject(new Error('fetch failed'));
    const transport = failoverTxTransport([fake('a', { waitForTransaction: down }), fake('b', { waitForTransaction: down })], isTxTransportError);
    await expect(transport.waitForTransaction('D')).rejects.toThrow('fetch failed');
  });

  it('is named after its order', () => {
    expect(failoverTxTransport([fake('v2-grpc', {}), fake('json-rpc', {})], isTxTransportError).name).toBe('v2-grpc>json-rpc');
  });
});

describe('txTransportFor', () => {
  it('uses the transport attached to a signing client', () => {
    const transport = fake('attached', {});
    const client = { [TX_TRANSPORT_KEY]: transport };
    expect(attachedTxTransport(client)).toBe(transport);
    expect(txTransportFor(client as never)).toBe(transport);
  });

  it('falls back to JSON-RPC through any other client, with the calls it always made', async () => {
    const client = {
      executeTransactionBlock: jest.fn().mockResolvedValue({ digest: 'D', effects: { status: { status: 'success' } }, events: [] }),
      waitForTransaction: jest.fn().mockResolvedValue({ digest: 'D', effects: { status: { status: 'success' } } }),
    };
    const transport = txTransportFor(client as never);
    expect(transport.name).toBe('json-rpc');

    await transport.execute(BYTES, 'SIG');
    expect(client.executeTransactionBlock).toHaveBeenCalledWith({
      transactionBlock: BYTES,
      signature: 'SIG',
      options: { showEffects: true, showEvents: true },
    });
    await transport.waitForTransaction('D');
    expect(client.waitForTransaction).toHaveBeenCalledWith({ digest: 'D', options: { showEffects: true } });
  });

  it('builds a 1.x transaction with the client, kind-only when asked', async () => {
    const tx = { build: jest.fn().mockResolvedValue(BYTES) };
    const client = {};
    await jsonRpcTxTransport(client as never).build(tx as never, { onlyTransactionKind: true });
    expect(tx.build).toHaveBeenCalledWith({ client, onlyTransactionKind: true });
  });
});
