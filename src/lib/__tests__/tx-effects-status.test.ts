/**
 * Sui commits a transaction that aborts and charges its gas, and
 * executeTransactionBlock resolves normally: the failure is only in
 * effects.status. The round panel read the digest alone, so a refused payment
 * was thanked and a refused open (abort 234) was announced as opened. These
 * pin the check that turns that status into an error the panel's existing
 * abort handling understands.
 */
import {
  assertTransactionSucceeded,
  isOnChainFailure,
  onChainFailure,
  OnChainFailureError,
} from '@/lib/tx-effects-status';
import { moveAbortUserMessage } from '@/lib/user-error-messages';
import { classifyOpenRoundError } from '@/lib/cycle-open-round-lock';

/** The chain's own wording for a Move abort, as effects.status.error carries it. */
const abort = (code: number, fn = 'open_cycle_stable_indexed') =>
  `MoveAbort(MoveLocation { module: ModuleId { address: ${'5f'.repeat(32)}, name: Identifier("njangi_cycle_escrow") }, function: 7, instruction: 31, function_name: Some("${fn}") }, ${code}) in command 0`;

const failed = (error: string) => ({ status: { status: 'failure', error } });
const succeeded = { status: { status: 'success' } };

describe('onChainFailure', () => {
  it('returns the chain error for failed effects', () => {
    expect(onChainFailure(failed(abort(234)))).toBe(abort(234));
  });

  it('returns null for successful effects', () => {
    expect(onChainFailure(succeeded)).toBeNull();
  });

  it('returns null when no effects came back, which proves nothing either way', () => {
    expect(onChainFailure(undefined)).toBeNull();
    expect(onChainFailure(null)).toBeNull();
    expect(onChainFailure({})).toBeNull();
  });

  it('still reports a failure that carries no error text', () => {
    expect(onChainFailure({ status: { status: 'failure' } })).toBe('unknown error');
  });
});

describe('assertTransactionSucceeded', () => {
  it('passes a successful transaction', () => {
    expect(() => assertTransactionSucceeded({ digest: 'd1', effects: succeeded })).not.toThrow();
  });

  it('passes a result without effects, as reading only the digest always did', () => {
    expect(() => assertTransactionSucceeded({ digest: 'd1' })).not.toThrow();
  });

  it('throws an OnChainFailureError carrying the digest for a failed transaction', () => {
    let caught: unknown;
    try {
      assertTransactionSucceeded({ digest: 'd2', effects: failed(abort(239, 'contribute_timed')) });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OnChainFailureError);
    expect(isOnChainFailure(caught)).toBe(true);
    expect((caught as OnChainFailureError).digest).toBe('d2');
  });

  it("keeps the chain's text where the panel's abort copy finds it", () => {
    // 239 has its own sentence; the panel shows it instead of a MoveAbort dump.
    let caught: unknown;
    try {
      assertTransactionSucceeded({ digest: 'd3', effects: failed(abort(239, 'contribute_timed')) });
    } catch (err) {
      caught = err;
    }
    expect(moveAbortUserMessage(caught)).toBe("That isn't this circle's coin. Refresh the page and try again.");
  });

  it('lets the open path recognise a refused duplicate open (abort 234)', () => {
    let caught: unknown;
    try {
      assertTransactionSucceeded({ digest: 'd4', effects: failed(abort(234)) });
    } catch (err) {
      caught = err;
    }
    expect(classifyOpenRoundError(caught)).toBe('round-already-open');
  });
});

describe('isOnChainFailure', () => {
  it('is false for other errors', () => {
    expect(isOnChainFailure(new Error('network down'))).toBe(false);
    expect(isOnChainFailure('MoveAbort')).toBe(false);
    expect(isOnChainFailure(undefined)).toBe(false);
  });
});
