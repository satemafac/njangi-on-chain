// tx-transport.ts — how a transaction the member signs is built, submitted and
// confirmed, independent of which Sui API serves it.
//
// The signer used to do all three over JSON-RPC (`txb.build({ client })`,
// `executeTransactionBlock`, `waitForTransaction`). Testnet JSON-RPC is gone
// (Sui's fullnodes retired it 2026-08, publicnode 2026-10-16), so the signing
// client now carries a transport that tries Sui's gRPC, then GraphQL, then
// JSON-RPC (v2-sui-client.ts, sui-rpc-failover.ts getSigningSuiClient). A
// client without one (tests, any other SuiClient) keeps the JSON-RPC behaviour.
//
// Results keep the JSON-RPC shape callers already read: `effects.status.status`
// and `effects.status.error` (tx-effects-status.ts, abort-code parsers),
// `events[].type` / `parsedJson`.

import type { SuiClient } from '@mysten/sui/client';
import type { Transaction } from '@mysten/sui/transactions';

export interface TxEffectsLike {
  status: { status: 'success' | 'failure'; error?: string };
  transactionDigest?: string;
  [key: string]: unknown;
}

export interface TxEventLike {
  type: string;
  parsedJson: unknown;
  [key: string]: unknown;
}

export interface TxExecutionLike {
  digest: string;
  effects?: TxEffectsLike | null;
  events?: TxEventLike[] | null;
}

export interface TxTransport {
  readonly name: string;
  /** Serialises a transaction, resolving objects, gas and budget as needed. */
  build(tx: Transaction, opts?: { onlyTransactionKind?: boolean }): Promise<Uint8Array>;
  /** Submits signed bytes. Resubmitting the same bytes is safe: same digest. */
  execute(bytes: Uint8Array, signature: string): Promise<TxExecutionLike>;
  /** Resolves once the digest is final; throws if it never shows up. */
  waitForTransaction(digest: string, opts?: { timeoutMs?: number }): Promise<TxExecutionLike>;
}

/**
 * Chain reads the signing path's builders make, served off JSON-RPC. Only
 * shapes that convert exactly: coin pages, balances, and a dynamic field's raw
 * JSON for callers that parse it themselves (v11-circle-tx.ts). Object
 * `content.fields` is NOT offered: 2.x JSON flattens structs and renders
 * vector<u8> as base64, so a generic conversion would misread fields silently.
 */
export interface V2Reads {
  getCoins(input: { owner: string; coinType?: string | null; cursor?: string | null; limit?: number | null }): Promise<{
    data: Array<{ coinType: string; coinObjectId: string; version: string; digest: string; balance: string }>;
    hasNextPage: boolean;
    nextCursor: string | null;
  }>;
  getBalance(input: { owner: string; coinType?: string | null }): Promise<{
    coinType: string;
    totalBalance: string;
    coinObjectCount: number;
    lockedBalance: Record<string, string>;
  }>;
  /** The JSON value of `parentId`'s dynamic field whose key type ends with `keyTypeSuffix`, or null when it has none. */
  dynamicFieldValueJson(parentId: string, keyTypeSuffix: string): Promise<unknown | null>;
}

const TX_TRANSPORT = Symbol.for('njangi.txTransport');
const V2_READS = Symbol.for('njangi.v2Reads');
export const V2_READS_KEY = V2_READS;

/** The off-JSON-RPC reads attached to a signing client, if it has them. */
export function attachedV2Reads(client: object): V2Reads | undefined {
  return (client as Record<symbol, V2Reads | undefined>)[V2_READS];
}

/** The transport attached to a signing client, if it has one. */
export function attachedTxTransport(client: object): TxTransport | undefined {
  return (client as Record<symbol, TxTransport | undefined>)[TX_TRANSPORT];
}

export const TX_TRANSPORT_KEY = TX_TRANSPORT;

/** The client's transport, or JSON-RPC through the client itself. */
export function txTransportFor(client: SuiClient): TxTransport {
  return attachedTxTransport(client) ?? jsonRpcTxTransport(client);
}

/** Today's behaviour: everything through a 1.x JSON-RPC SuiClient. */
export function jsonRpcTxTransport(client: SuiClient): TxTransport {
  return {
    name: 'json-rpc',
    build: (tx, opts) => tx.build({ client, onlyTransactionKind: opts?.onlyTransactionKind }),
    async execute(bytes, signature) {
      const result = await client.executeTransactionBlock({
        transactionBlock: bytes,
        signature,
        options: { showEffects: true, showEvents: true },
      });
      return {
        digest: result.digest,
        effects: result.effects as unknown as TxEffectsLike | null,
        events: result.events as unknown as TxEventLike[] | null,
      };
    },
    async waitForTransaction(digest, opts) {
      const result = await client.waitForTransaction({
        digest,
        options: { showEffects: true },
        ...(opts?.timeoutMs ? { timeout: opts.timeoutMs } : {}),
      });
      return { digest: result.digest, effects: result.effects as unknown as TxEffectsLike | null };
    },
  };
}

/**
 * Tries each transport in order, moving on only when `isTransportError` says
 * the failure was the endpoint's (unreachable, rate-limited, retired API).
 * A Move abort, a bad signature or any other answer about the transaction
 * itself is final: another endpoint would give the same answer.
 */
export function failoverTxTransport(
  transports: TxTransport[],
  isTransportError: (error: unknown) => boolean,
): TxTransport {
  if (transports.length === 0) throw new Error('failoverTxTransport needs at least one transport');

  async function attempt<T>(operation: string, run: (t: TxTransport) => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (const [index, transport] of transports.entries()) {
      try {
        return await run(transport);
      } catch (error) {
        lastError = error;
        if (index === transports.length - 1 || !isTransportError(error)) throw error;
        console.warn(
          `[tx-transport] ${operation} via ${transport.name} failed, trying ${transports[index + 1].name}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
    throw lastError;
  }

  return {
    name: transports.map((t) => t.name).join('>'),
    build: (tx, opts) => attempt('build', (t) => t.build(tx, opts)),
    execute: (bytes, signature) => attempt('execute', (t) => t.execute(bytes, signature)),
    waitForTransaction: (digest, opts) => attempt('wait', (t) => t.waitForTransaction(digest, opts)),
  };
}
