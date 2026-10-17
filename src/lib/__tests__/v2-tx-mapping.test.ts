// 2.x results must read exactly like JSON-RPC to the app's parsers. The abort
// case below is the live one (2026-10-17): opening a round on a circle whose
// round is already open, abort 234 from njangi_cycle_escrow::open_cycle_internal.

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  formatJsonRpcExecutionError,
  isTxTransportError,
  toDryRunError,
  toJsonRpcBalance,
  toJsonRpcCoinPage,
  toJsonRpcExecution,
  type V2ExecutionError,
} from '../v2-tx-mapping';
import { classifyOpenRoundError } from '../cycle-open-round-lock';
import { moveAbortUserMessage } from '../user-error-messages';
import { assertTransactionSucceeded, OnChainFailureError } from '../tx-effects-status';

const PKG = '0x5f71b5c82f167be517a09604a1f911a642e037ce0ae2e8f9e004f67eb52893ee';
const ABORT_234: V2ExecutionError = {
  $kind: 'MoveAbort',
  message: `MoveAbort in 1st command, abort code: 234, in '${PKG}::njangi_cycle_escrow::open_cycle_internal' (instruction 152)`,
  command: 0,
  MoveAbort: {
    abortCode: '234',
    location: { package: PKG, module: 'njangi_cycle_escrow', function: 21, instruction: 152, functionName: 'open_cycle_internal' },
  },
};
const JSON_RPC_234 =
  'MoveAbort(MoveLocation { module: ModuleId { address: 5f71b5c82f167be517a09604a1f911a642e037ce0ae2e8f9e004f67eb52893ee, ' +
  'name: Identifier("njangi_cycle_escrow") }, function: 21, instruction: 152, function_name: Some("open_cycle_internal") }, 234) in command 0';

describe('formatJsonRpcExecutionError', () => {
  it('renders a Move abort exactly as JSON-RPC does', () => {
    expect(formatJsonRpcExecutionError(ABORT_234)).toBe(JSON_RPC_234);
  });

  it("matches the manage page's full-format parser", () => {
    // The regex parseMoveError uses, read from the page so the two cannot drift.
    const page = readFileSync(join(process.cwd(), 'src/pages/circle/[id]/manage/index.tsx'), 'utf8');
    const literal = page.match(/const moveAbortMatch = error\.match\((\/MoveAbort.+\/)\);/)?.[1];
    expect(literal).toBeDefined();
    const pageRegex = new RegExp(literal!.slice(1, -1));
    expect(JSON_RPC_234.match(pageRegex)?.slice(1)).toEqual(['njangi_cycle_escrow', 'open_cycle_internal', '234']);
  });

  it('feeds the panel and copy parsers the same way JSON-RPC did', () => {
    expect(classifyOpenRoundError(new Error(JSON_RPC_234))).toBe('round-already-open');
    // 236 is a code the copy table explains ("This circle isn't running …").
    const abort236 = formatJsonRpcExecutionError({
      ...ABORT_234,
      MoveAbort: { ...ABORT_234.MoveAbort!, abortCode: '236' },
    });
    expect(moveAbortUserMessage(new Error(abort236))).toMatch(/isn't running/);
  });

  it('renders other failures as their kind and command', () => {
    expect(formatJsonRpcExecutionError({ $kind: 'InsufficientCoinBalance', message: 'x', command: 1 })).toBe(
      'InsufficientCoinBalance in command 1',
    );
  });
});

describe('toDryRunError', () => {
  it("rewrites a 2.x simulation failure as 1.x's dry-run error", () => {
    const simulationError = Object.assign(new Error(`Transaction resolution failed: ${ABORT_234.message}`), {
      executionError: ABORT_234,
    });
    const converted = toDryRunError(simulationError);
    expect(converted?.message).toBe(`Dry run failed, could not automatically determine a budget: ${JSON_RPC_234}`);
    expect(classifyOpenRoundError(converted)).toBe('round-already-open');
    // An answer about the transaction: no other endpoint is asked.
    expect(isTxTransportError(converted)).toBe(false);
  });

  it('leaves other errors alone', () => {
    expect(toDryRunError(new Error('fetch failed'))).toBeNull();
  });
});

describe('isTxTransportError', () => {
  it.each([
    new TypeError('Failed to fetch'),
    new Error('UNAVAILABLE: upstream connect error'),
    new Error('Unexpected status code: 503'),
    new Error('Internal error'),
    new Error('Sui JSON-RPC endpoint has been deprecated. Please use the gRPC endpoint instead'),
    new Error('Failed to fetch dynamically imported module'),
  ])('fails over on %s', (error) => {
    expect(isTxTransportError(error)).toBe(true);
  });

  it('does not fail over on an answer about the transaction', () => {
    expect(isTxTransportError(new Error('Invalid user signature: Required Signature from 0xabc is absent'))).toBe(false);
  });
});

describe('toJsonRpcExecution', () => {
  const effects = (status: unknown) => ({
    status,
    gasUsed: { computationCost: '1', storageCost: '2', storageRebate: '3', nonRefundableStorageFee: '0' },
    transactionDigest: 'DIG',
    changedObjects: [
      { objectId: '0xnew', idOperation: 'Created', outputVersion: '7', outputDigest: 'd', outputOwner: { $kind: 'Shared', Shared: { initialSharedVersion: '7' } }, outputState: 'ObjectWrite' },
      { objectId: '0xgas', idOperation: 'None', outputVersion: '7', outputDigest: 'g', outputOwner: { $kind: 'AddressOwner', AddressOwner: '0xme' }, outputState: 'ObjectWrite' },
    ],
  });

  it('maps a success, its created object and its events', () => {
    const result = toJsonRpcExecution({
      $kind: 'Transaction',
      Transaction: {
        digest: 'DIG',
        status: { success: true, error: null },
        effects: effects({ success: true, error: null }) as never,
        events: [{ packageId: PKG, module: 'njangi_goal_pool', sender: '0xme', eventType: `${PKG}::njangi_goal_pool::GoalPoolOpened`, json: { pool_id: '0xpool' } }],
      },
    });
    expect(result.digest).toBe('DIG');
    expect(result.effects?.status).toEqual({ status: 'success' });
    expect(result.effects?.created).toEqual([
      { owner: { Shared: { initial_shared_version: '7' } }, reference: { objectId: '0xnew', version: '7', digest: 'd' } },
    ]);
    // What create-circle reads for a goal pool: ev.type and ev.parsedJson.pool_id.
    expect(result.events?.[0]).toMatchObject({ type: `${PKG}::njangi_goal_pool::GoalPoolOpened`, parsedJson: { pool_id: '0xpool' } });
    expect(() => assertTransactionSucceeded(result)).not.toThrow();
  });

  it('maps a failed transaction to a failure status with the JSON-RPC error text', () => {
    const result = toJsonRpcExecution({
      $kind: 'FailedTransaction',
      FailedTransaction: {
        digest: 'DIG',
        status: { success: false, error: ABORT_234 },
        effects: effects({ success: false, error: ABORT_234 }) as never,
      },
    });
    expect(result.effects?.status).toEqual({ status: 'failure', error: JSON_RPC_234 });
    expect(() => assertTransactionSucceeded(result)).toThrow(OnChainFailureError);
  });
});

describe('coin reads', () => {
  it('maps a 2.x coin page to the fields the payment builders read', () => {
    const page = toJsonRpcCoinPage({
      objects: [{ objectId: '0xc', version: '1', digest: 'd', balance: '1925922', type: '0x0000000000000000000000000000000000000000000000000000000000000002::coin::Coin<0x26b3::usdc::USDC>' }],
      hasNextPage: false,
      cursor: 'JKqX',
    });
    expect(page).toEqual({
      data: [{ coinType: '0x26b3::usdc::USDC', coinObjectId: '0xc', version: '1', digest: 'd', balance: '1925922' }],
      hasNextPage: false,
      nextCursor: 'JKqX',
    });
  });

  it('reports the coin balance, not coins plus address balance, as totalBalance', () => {
    expect(toJsonRpcBalance({ coinType: '0x2::sui::SUI', coinBalance: '100' } as never).totalBalance).toBe('100');
    expect(
      toJsonRpcBalance({ coinType: '0x2::sui::SUI', coinBalance: '100', balance: '150', addressBalance: '50' } as never)
        .totalBalance,
    ).toBe('100');
  });
});
