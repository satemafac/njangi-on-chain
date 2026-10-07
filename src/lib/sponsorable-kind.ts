// sponsorable-kind.ts — what a sponsored transaction may contain, judged from
// the transaction itself.
//
// Under sponsorship the gas coin is the SPONSOR's coin. A kind that splits,
// merges, transfers or passes it would spend the sponsor's SUI as value: a
// SUI share is split from `txb.gas` (payment-coin-builder.ts), so sponsoring
// one would pay the member's contribution out of our pocket. No sponsored
// kind may touch the gas coin.
//
// The browser checks this before asking (sponsored-tx-client.ts), which saves
// a round trip for SUI payments, and /api/sponsor/prepare checks it again.
// The server's answer must come from the transaction, not from the
// `usesGasCoinForValue` flag the client sends along with it.
//
// Shared by the browser and the API route, so it must stay free of
// server-only imports (gas-sponsorship.ts pulls in Postgres).

import type { Transaction } from '@mysten/sui/transactions';
import { normalizeSuiObjectId } from '@mysten/sui/utils';

type TransactionData = ReturnType<Transaction['getData']>;

/** The commands a member action is built from. Publish and Upgrade never are. */
const SPONSORABLE_COMMAND_KINDS: ReadonlySet<string> = new Set([
  'MoveCall',
  'SplitCoins',
  'MergeCoins',
  'TransferObjects',
  'MakeMoveVec',
]);

function isGasCoinArgument(value: object): boolean {
  return (value as { $kind?: unknown }).$kind === 'GasCoin' || 'GasCoin' in value;
}

function referencesGasCoin(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(referencesGasCoin);
  if (typeof value !== 'object' || value === null) return false;
  if (isGasCoinArgument(value)) return true;
  return Object.values(value).some(referencesGasCoin);
}

/** True when any command splits, merges, transfers or passes the gas coin. */
export function kindUsesGasCoin(data: TransactionData): boolean {
  return data.commands.some(referencesGasCoin);
}

export type SponsorableKindVerdict =
  | { sponsorable: true; objectIds: Set<string> }
  | {
      sponsorable: false;
      reason: 'command_not_allowed' | 'target_not_allowed' | 'gas_coin_used';
      detail: string;
    };

/**
 * The server's whole reading of a kind: every command is one a member action
 * uses, every Move call is on the allowlist, and nothing touches the gas coin.
 *
 * Enoki enforces `allowedMoveCallTargets` too, so this is not the only guard,
 * but doing it here makes the decision auditable on our side and refuses a
 * kind before an Enoki call is spent on it. On success it returns every
 * object the kind touches, so the caller can prove the circle it wants billed
 * is one of them.
 */
export function judgeSponsorableKind(
  data: TransactionData,
  allowedTargets: readonly string[],
): SponsorableKindVerdict {
  const allowed = new Set(allowedTargets);

  for (const command of data.commands) {
    if (!SPONSORABLE_COMMAND_KINDS.has(command.$kind)) {
      return {
        sponsorable: false,
        reason: 'command_not_allowed',
        detail: `Command is not sponsorable: ${command.$kind}`,
      };
    }
    if (command.$kind === 'MoveCall' && command.MoveCall) {
      const { package: pkg, module, function: fn } = command.MoveCall;
      const target = `${pkg}::${module}::${fn}`;
      if (!allowed.has(target)) {
        return {
          sponsorable: false,
          reason: 'target_not_allowed',
          detail: `Move call target is not sponsorable: ${target}`,
        };
      }
    }
  }

  if (kindUsesGasCoin(data)) {
    return {
      sponsorable: false,
      reason: 'gas_coin_used',
      detail: "The transaction uses the gas coin, which would be the sponsor's SUI.",
    };
  }

  const objectIds = new Set<string>();
  for (const input of data.inputs) {
    if (input.$kind !== 'Object' || !input.Object) continue;
    const obj = input.Object as {
      SharedObject?: { objectId: string };
      ImmOrOwnedObject?: { objectId: string };
      Receiving?: { objectId: string };
    };
    const objectId =
      obj.SharedObject?.objectId ?? obj.ImmOrOwnedObject?.objectId ?? obj.Receiving?.objectId;
    if (objectId) objectIds.add(normalizeSuiObjectId(objectId));
  }
  return { sponsorable: true, objectIds };
}
