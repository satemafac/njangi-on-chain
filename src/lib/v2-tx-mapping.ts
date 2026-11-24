// v2-tx-mapping.ts — @mysten/sui 2.x results in the JSON-RPC shapes the app
// already reads. Pure functions over structural types: no import of the 2.x
// package, so Jest (CommonJS, `node` resolution) can test it directly.
//
// What has to survive the move, exactly:
//   - `effects.status.status` / `effects.status.error`, read by
//     tx-effects-status.ts and every abort-code parser. The error must be the
//     JSON-RPC text, `MoveAbort(MoveLocation { module: ModuleId { address: …,
//     name: Identifier("…") }, function: N, instruction: N, function_name:
//     Some("…") }, CODE) in command N`; manage/index.tsx matches it whole.
//   - A failed simulation during build reads like 1.x's dry-run failure,
//     `Dry run failed, could not automatically determine a budget: …`.
//   - Coin pages (`data[].coinObjectId`, `balance`, `hasNextPage`,
//     `nextCursor`) and balances (`totalBalance`) for the payment-coin builders.

import { isJsonRpcWithdrawnError, isRetriableSuiRpcError } from '@/services/sui-rpc-failover';
import type { TxEffectsLike, TxEventLike, TxExecutionLike } from './tx-transport';

// --- 2.x shapes (structural; see @mysten/sui 2.x client/types.d.mts) ---

export interface V2MoveAbort {
  abortCode: string;
  location?: {
    package: string;
    module: string;
    function: number;
    instruction: number;
    functionName?: string | null;
  };
}

export interface V2ExecutionError {
  $kind: string;
  message: string;
  command?: number;
  MoveAbort?: V2MoveAbort;
}

type V2ExecutionStatus = { success: true; error: null } | { success: false; error: V2ExecutionError };

type V2Owner =
  | { $kind: 'AddressOwner'; AddressOwner: string }
  | { $kind: 'ObjectOwner'; ObjectOwner: string }
  | { $kind: 'Shared'; Shared: { initialSharedVersion: string } }
  | { $kind: 'Immutable'; Immutable: true }
  | { $kind: 'ConsensusAddressOwner'; ConsensusAddressOwner: { startVersion: string; owner: string } }
  | { $kind: string; [key: string]: unknown };

interface V2ChangedObject {
  objectId: string;
  outputVersion: string | null;
  outputDigest: string | null;
  outputOwner: V2Owner | null;
  inputVersion?: string | null;
  inputDigest?: string | null;
  idOperation: 'Unknown' | 'None' | 'Created' | 'Deleted';
  outputState?: string;
}

interface V2Effects {
  status: V2ExecutionStatus;
  gasUsed: {
    computationCost: string;
    storageCost: string;
    storageRebate: string;
    nonRefundableStorageFee: string;
  };
  transactionDigest: string;
  changedObjects: V2ChangedObject[];
}

interface V2Event {
  packageId: string;
  module: string;
  sender: string;
  eventType: string;
  json: Record<string, unknown> | null;
}

export interface V2Transaction {
  digest: string;
  status: V2ExecutionStatus;
  effects?: V2Effects;
  events?: V2Event[];
}

export type V2TransactionResult =
  | { $kind: 'Transaction'; Transaction: V2Transaction }
  | { $kind: 'FailedTransaction'; FailedTransaction: V2Transaction };

export interface V2Coin {
  objectId: string;
  version: string;
  digest: string;
  type: string;
  balance: string;
}

// --- errors ---

/** JSON-RPC's rendering of an execution error (Sui's ExecutionFailureStatus). */
export function formatJsonRpcExecutionError(error: V2ExecutionError): string {
  const where = typeof error.command === 'number' ? ` in command ${error.command}` : '';
  const abort = error.MoveAbort;
  if (error.$kind === 'MoveAbort' && abort) {
    const loc = abort.location;
    if (!loc) return `MoveAbort(${abort.abortCode})${where}`;
    // JSON-RPC prints the address bare: full-width hex, no 0x.
    const address = loc.package.replace(/^0x/i, '').padStart(64, '0');
    const fn = loc.functionName ? `Some("${loc.functionName}")` : 'None';
    return (
      `MoveAbort(MoveLocation { module: ModuleId { address: ${address}, name: Identifier("${loc.module}") }, ` +
      `function: ${loc.function}, instruction: ${loc.instruction}, function_name: ${fn} }, ${abort.abortCode})${where}`
    );
  }
  return `${error.$kind}${where}`;
}

/**
 * A 2.x build that failed while simulating (it simulates to price gas and
 * resolve inputs) as 1.x's dry-run error, so the abort parsers keep matching.
 * Null when the error is not a simulation failure.
 */
export function toDryRunError(error: unknown): Error | null {
  const executionError = (error as { executionError?: V2ExecutionError } | null)?.executionError;
  if (!executionError || typeof executionError !== 'object' || !executionError.$kind) return null;
  const wrapped = new Error(
    `Dry run failed, could not automatically determine a budget: ${formatJsonRpcExecutionError(executionError)}`,
  );
  // Keep the structured error on the wrapper: it marks this as an answer
  // about the transaction, so failover does not retry it elsewhere.
  Object.assign(wrapped, { cause: error, executionError });
  return wrapped;
}

// gRPC status names and plain network failures. Anything else (a Move abort,
// a bad signature, an invalid transaction) is an answer about the transaction.
// Erring towards "transport" only costs a repeat: the next endpoint gets the
// same bytes and gives the same answer.
const TRANSPORT_FAILURE =
  /\b(UNAVAILABLE|DEADLINE_EXCEEDED|RESOURCE_EXHAUSTED|UNKNOWN|INTERNAL)\b|internal error|failed to fetch|fetch failed|networkerror|network request failed|load failed|econn|etimedout|socket hang up|timed? ?out|too many requests|\b(429|502|503|504)\b/i;

/** True when an endpoint failed, so the next one is worth asking. */
export function isTxTransportError(error: unknown): boolean {
  if (toDryRunError(error)) return false;
  if (error instanceof TypeError) return true;
  const message = error instanceof Error ? error.message : String(error ?? '');
  return isRetriableSuiRpcError(error) || isJsonRpcWithdrawnError(message) || TRANSPORT_FAILURE.test(message);
}

// --- results ---

function ownerToJsonRpc(owner: V2Owner | null): unknown {
  if (!owner) return null;
  switch (owner.$kind) {
    case 'AddressOwner':
      return { AddressOwner: (owner as { AddressOwner: string }).AddressOwner };
    case 'ObjectOwner':
      return { ObjectOwner: (owner as { ObjectOwner: string }).ObjectOwner };
    case 'Shared':
      return {
        Shared: {
          initial_shared_version: (owner as { Shared: { initialSharedVersion: string } }).Shared.initialSharedVersion,
        },
      };
    case 'Immutable':
      return 'Immutable';
    case 'ConsensusAddressOwner': {
      const c = (owner as { ConsensusAddressOwner: { startVersion: string; owner: string } }).ConsensusAddressOwner;
      return { ConsensusAddressOwner: { start_version: c.startVersion, owner: c.owner } };
    }
    default:
      return null;
  }
}

const ref = (o: V2ChangedObject, version: string | null | undefined, digest: string | null | undefined) => ({
  objectId: o.objectId,
  version: version ?? undefined,
  digest: digest ?? undefined,
});

/** JSON-RPC `effects` (the parts the app reads, plus object refs). */
export function toJsonRpcEffects(effects: V2Effects): TxEffectsLike {
  const changed = effects.changedObjects ?? [];
  return {
    status: effects.status.success
      ? { status: 'success' }
      : { status: 'failure', error: formatJsonRpcExecutionError(effects.status.error) },
    transactionDigest: effects.transactionDigest,
    gasUsed: effects.gasUsed,
    created: changed
      .filter((o) => o.idOperation === 'Created')
      .map((o) => ({ owner: ownerToJsonRpc(o.outputOwner), reference: ref(o, o.outputVersion, o.outputDigest) })),
    mutated: changed
      .filter((o) => o.idOperation === 'None' && o.outputState === 'ObjectWrite')
      .map((o) => ({ owner: ownerToJsonRpc(o.outputOwner), reference: ref(o, o.outputVersion, o.outputDigest) })),
    deleted: changed
      .filter((o) => o.idOperation === 'Deleted')
      .map((o) => ref(o, o.inputVersion, o.inputDigest)),
  };
}

/** JSON-RPC `events`. `parsedJson` is the 2.x `json`; fields that are IDs, numbers and strings read the same. */
export function toJsonRpcEvents(digest: string, events: V2Event[] | undefined): TxEventLike[] {
  return (events ?? []).map((event, index) => ({
    id: { txDigest: digest, eventSeq: String(index) },
    packageId: event.packageId,
    transactionModule: event.module,
    sender: event.sender,
    type: event.eventType,
    parsedJson: event.json,
  }));
}

/** A 2.x execute/wait result as `{ digest, effects, events }`. A failed transaction is a result, not a throw, as in JSON-RPC. */
export function toJsonRpcExecution(result: V2TransactionResult): TxExecutionLike {
  const tx = result.$kind === 'Transaction' ? result.Transaction : result.FailedTransaction;
  const effects: TxEffectsLike = tx.effects
    ? toJsonRpcEffects(tx.effects)
    : {
        status: tx.status.success
          ? { status: 'success' }
          : { status: 'failure', error: formatJsonRpcExecutionError(tx.status.error) },
        transactionDigest: tx.digest,
      };
  return { digest: tx.digest, effects, events: tx.events ? toJsonRpcEvents(tx.digest, tx.events) : null };
}

// --- reads used by the payment-coin builders ---

/** JSON-RPC `getCoins` page. */
export function toJsonRpcCoinPage(page: { objects: V2Coin[]; hasNextPage: boolean; cursor: string | null }) {
  return {
    data: page.objects.map((coin) => ({
      // 2.x reports the object type in long form: 0x000…0002::coin::Coin<T>.
      coinType: coin.type.replace(/^0x0*2::coin::Coin<(.+)>$/, '$1'),
      coinObjectId: coin.objectId,
      version: coin.version,
      digest: coin.digest,
      balance: coin.balance,
    })),
    hasNextPage: page.hasNextPage,
    nextCursor: page.cursor,
  };
}

/**
 * JSON-RPC `getBalance`. `totalBalance` is the COIN balance: 2.x also counts
 * address balances, which cannot be split from the gas coin, and the builders
 * use this figure to decide whether a split will succeed.
 */
export function toJsonRpcBalance(balance: { coinType: string; coinBalance: string }) {
  return { coinType: balance.coinType, totalBalance: balance.coinBalance, coinObjectCount: 0, lockedBalance: {} };
}
