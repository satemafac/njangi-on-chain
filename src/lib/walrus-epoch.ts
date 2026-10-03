// walrus-epoch.ts — The current WALRUS epoch, for /api/cron/walrus-renewal.
//
// A Walrus storage lease ends at a Walrus epoch. The end epoch the publisher
// returns for a blob (walrus-pii.ts), and whatsapp_phone_index.walrus_end_epoch
// stores, counts Walrus epochs: a day each on testnet, two weeks on mainnet.
// They are not Sui epochs. The renewal cron once compared end epochs with the
// Sui epoch (testnet, 2026-10-02: Walrus 538, Sui 1240), so every lease looked
// long expired and every blob was re-stored on every run.
//
// Neither the publisher nor the aggregator reports the current epoch, so it
// is read from chain. The Walrus System object (shared) keeps its state in a
// dynamic field keyed by its `version` field. That SystemStateInnerV1 holds
// the current committee, and `committee.epoch` is the epoch that storage
// start and end epochs count in. A lease's end epoch is exclusive: the blob
// is served while the current epoch is below it. Both reads are object reads
// (no event query), which publicnode-class endpoints serve.
//
// Anything unexpected in those reads throws. The epoch decides which leases
// get renewed, so a guessed epoch is worse than a failed run.

import type { SuiClient, SuiObjectResponse } from '@mysten/sui/client';
import { normalizeSuiObjectId } from '@mysten/sui/utils';
import type { NetworkType } from '../config/public-env';
import { isResolvedSuiObjectId } from './sui-object-id';

/**
 * The Walrus System object of each network, from the Walrus network
 * reference (https://docs.wal.app/docs/network-reference) and the client
 * config it publishes (https://docs.wal.app/setup/client_config.yaml).
 * Checked on chain 2026-10-02: each is a `::system::System` object of the
 * documented Walrus package, at Walrus epoch 538 (testnet) and 40 (mainnet).
 */
export const DEFAULT_WALRUS_SYSTEM_OBJECT_IDS: Readonly<Record<NetworkType, string>> = {
  testnet: '0x6c2547cbbc38025cf3adac45f63cb0a8d12ecf777cdc75a4971612bf97fdf6af',
  mainnet: '0x2134d52768ea07e8c43570ef975eb3e4c27a39fa6396bef985b5abc58d03ddd2',
};

/**
 * Per-network overrides, for when WALRUS_PUBLISHER_URL writes to a Walrus
 * deployment other than the documented one (a testnet redeploy, say).
 */
export const WALRUS_SYSTEM_OBJECT_ID_ENV: Readonly<Record<NetworkType, string>> = {
  testnet: 'WALRUS_SYSTEM_OBJECT_ID_TESTNET',
  mainnet: 'WALRUS_SYSTEM_OBJECT_ID_MAINNET',
};

/** The two reads the lookup makes; a SuiClient provides both. */
export type WalrusEpochClient = Pick<SuiClient, 'getObject' | 'getDynamicFieldObject'>;

const SYSTEM_TYPE_SUFFIX = '::system::System';
const SYSTEM_STATE_TYPE_MARKER = '::system_state_inner::SystemStateInner';

/**
 * The System object id for `network`: its override variable when set,
 * otherwise the documented default. A malformed override throws rather than
 * falling back, so a typo can't quietly point the cron somewhere else.
 */
export function resolveWalrusSystemObjectId(
  network: NetworkType,
  env: Record<string, string | undefined> = process.env,
): string {
  const name = WALRUS_SYSTEM_OBJECT_ID_ENV[network];
  const raw = env[name]?.trim();
  if (!raw) return DEFAULT_WALRUS_SYSTEM_OBJECT_IDS[network];
  if (!isResolvedSuiObjectId(raw)) {
    throw new Error(
      `${name} is not a Sui object id. Unset it to use the documented Walrus ${network} System object.`,
    );
  }
  return normalizeSuiObjectId(raw);
}

interface MoveObject {
  type: string;
  fields: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The Move object in an RPC response, or a throw naming what was missing. */
function moveObject(response: SuiObjectResponse, label: string): MoveObject {
  if (response.error) {
    const code = (response.error as { code?: string }).code ?? 'unknown error';
    throw new Error(`${label} could not be read (${code}).`);
  }
  const content = response.data?.content;
  if (!content || content.dataType !== 'moveObject' || !isRecord(content.fields)) {
    throw new Error(`${label} came back without Move object content.`);
  }
  return { type: content.type, fields: content.fields };
}

/** A nested Move struct as the JSON-RPC renders it: `{ type, fields }`. */
function moveStruct(value: unknown): MoveObject | null {
  if (!isRecord(value) || typeof value.type !== 'string' || !isRecord(value.fields)) {
    return null;
  }
  return { type: value.type, fields: value.fields };
}

/** u32/u64 values arrive as JSON numbers or decimal strings. */
function wholeNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Reads the current epoch of the Walrus deployment whose System object is
 * `systemObjectId`. Throws on any failed read or unexpected shape.
 */
export async function readWalrusEpoch(
  client: WalrusEpochClient,
  systemObjectId: string,
): Promise<number> {
  const system = moveObject(
    await client.getObject({ id: systemObjectId, options: { showContent: true } }),
    `Walrus System object ${systemObjectId}`,
  );
  if (!system.type.endsWith(SYSTEM_TYPE_SUFFIX)) {
    throw new Error(
      `Object ${systemObjectId} is a ${system.type}, not a Walrus ${SYSTEM_TYPE_SUFFIX} object.`,
    );
  }

  const version = wholeNumber(system.fields.version);
  if (version === null) {
    throw new Error(`Walrus System object ${systemObjectId} has no whole-number version field.`);
  }

  const state = moveObject(
    await client.getDynamicFieldObject({
      parentId: systemObjectId,
      name: { type: 'u64', value: String(version) },
    }),
    `Walrus system state v${version} of ${systemObjectId}`,
  );
  const inner = moveStruct(state.fields.value);
  if (!inner || !inner.type.includes(SYSTEM_STATE_TYPE_MARKER)) {
    throw new Error(
      `Walrus system state v${version} of ${systemObjectId} is not a SystemStateInner (got ${
        inner?.type ?? 'no struct'
      }).`,
    );
  }

  const epoch = wholeNumber(moveStruct(inner.fields.committee)?.fields.epoch);
  if (epoch === null) {
    throw new Error(
      `Walrus system state v${version} of ${systemObjectId} has no whole-number committee.epoch.`,
    );
  }
  return epoch;
}

/**
 * The current Walrus epoch of the active network's deployment, for the
 * renewal cron. Errors name the network, the object and its override
 * variable, since a wrong object is the likeliest cause.
 */
export async function readCurrentWalrusEpoch(
  client: WalrusEpochClient,
  network: NetworkType,
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  const systemObjectId = resolveWalrusSystemObjectId(network, env);
  try {
    return await readWalrusEpoch(client, systemObjectId);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Could not read the current Walrus epoch on ${network} from System object ${systemObjectId} ` +
        `(override: ${WALRUS_SYSTEM_OBJECT_ID_ENV[network]}): ${reason}`,
    );
  }
}
