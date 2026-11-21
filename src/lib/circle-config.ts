import type { SuiClient } from '@mysten/sui/client';
import type { NetworkType } from '@/config/public-env';
import { getCurrentNetwork, getGraphqlUrlForNetwork } from '@/services/network-config';
import {
  readDynamicFieldsViaGraphql,
  readDynamicFieldsViaJsonRpc,
  type DynamicFieldReading,
  type DynamicFieldsJsonRpcClient,
} from '@/lib/dynamic-fields-graphql';

export type CircleConfigFields = Record<string, unknown>;

export interface CircleConfigDynamicFieldLike {
  objectId?: string | null;
  objectType?: string | null;
  type?: string | null;
  name?: unknown;
}

type CircleConfigObjectClient = Pick<SuiClient, 'getObject'>;
type CircleConfigClient = Pick<SuiClient, 'getObject' | 'getDynamicFields'>;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function extractMoveStructFields(value: unknown): CircleConfigFields | null {
  const record = asRecord(value);
  return record ? asRecord(record.fields) : null;
}

export function isCircleConfigDynamicField(
  field: CircleConfigDynamicFieldLike | null | undefined,
): boolean {
  if (!field) {
    return false;
  }

  const objectType = typeof field.objectType === 'string' ? field.objectType : '';
  const fieldType = typeof field.type === 'string' ? field.type : '';
  const nameRecord = asRecord(field.name);
  const nameType = typeof nameRecord?.type === 'string' ? nameRecord.type : '';
  const nameValue = typeof nameRecord?.value === 'string' ? nameRecord.value : '';

  return (
    objectType.includes('CircleConfig') ||
    fieldType.includes('CircleConfig') ||
    nameType.includes('CircleConfig') ||
    nameValue === 'circle_config'
  );
}

export function getCircleConfigObjectId(
  dynamicFields: Iterable<CircleConfigDynamicFieldLike | null | undefined>,
): string | null {
  for (const field of dynamicFields) {
    if (
      isCircleConfigDynamicField(field) &&
      typeof field?.objectId === 'string' &&
      field.objectId.length > 0
    ) {
      return field.objectId;
    }
  }

  return null;
}

export function extractCircleConfigFieldsFromObjectContent(
  content: unknown,
): CircleConfigFields | null {
  const contentRecord = asRecord(content);
  const rootFields = contentRecord ? asRecord(contentRecord.fields) : null;

  if (!rootFields) {
    return null;
  }

  const nestedFields = extractMoveStructFields(rootFields.value);
  return nestedFields ? { ...rootFields, ...nestedFields } : rootFields;
}

/** Which network's Sui GraphQL service a CircleConfig read asks first. */
export interface CircleConfigReadOptions {
  /** The network whose GraphQL URL is used; the current network when absent. */
  network?: NetworkType;
}

/** How long one Sui GraphQL read of a CircleConfig field object may take before it counts as a failed read. */
const CIRCLE_CONFIG_GRAPHQL_TIMEOUT_MS = 8_000;

/** The CircleConfig dynamic-field object at its latest version, as its JSON fields. */
const CIRCLE_CONFIG_GRAPHQL_QUERY = `query ($address: SuiAddress!) {
  object(address: $address) {
    asMoveObject { contents { json } }
  }
}`;

interface GraphqlCircleConfigBody {
  data?: { object?: unknown } | null;
  errors?: unknown;
}

function describeCircleConfigReadError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The Sui GraphQL URL of `network` (the current network when absent), or
 * null when there is none (or no `fetch`): the caller then reads with
 * getObject only.
 */
function resolveCircleConfigGraphqlUrl(network?: NetworkType): string | null {
  try {
    if (typeof getGraphqlUrlForNetwork === 'function' && typeof fetch === 'function') {
      const configured: unknown = getGraphqlUrlForNetwork(network ?? getCurrentNetwork());
      return typeof configured === 'string' && configured !== '' ? configured : null;
    }
  } catch (error) {
    console.warn(
      `No Sui GraphQL URL for CircleConfig reads, reading them with getObject: ${describeCircleConfigReadError(error)}`,
    );
  }
  return null;
}

/**
 * The CircleConfig field object `objectId` read from Sui GraphQL, merged as
 * extractCircleConfigFieldsFromObjectContent merges the JSON-RPC shape: the
 * Field's root keys plus the keys of its `value`. Values are kept exactly as
 * GraphQL renders them (u64 strings, numeric enums, null or plain Options).
 *
 * Throws on a failed or unreadable read (error status, an `errors` body, no
 * object, no `contents.json` object, no `value` object, the timeout); it
 * never returns an empty, partial or default record.
 */
async function readCircleConfigFieldsViaGraphql(
  url: string,
  objectId: string,
): Promise<CircleConfigFields> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CIRCLE_CONFIG_GRAPHQL_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        query: CIRCLE_CONFIG_GRAPHQL_QUERY,
        variables: { address: objectId },
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`GraphQL ${url} answered ${response.status}`);
    }
    const body = (await response.json()) as GraphqlCircleConfigBody | null;
    const errors = body?.errors;
    if (errors !== undefined && errors !== null && !(Array.isArray(errors) && errors.length === 0)) {
      const reason = Array.isArray(errors) ? (errors[0] as { message?: unknown } | null)?.message : undefined;
      throw new Error(`GraphQL ${url} returned errors${typeof reason === 'string' ? `: ${reason}` : ''}`);
    }
    const object = asRecord(body?.data?.object);
    if (!object) {
      throw new Error(`GraphQL ${url} returned no object`);
    }
    const contents = asRecord(asRecord(object.asMoveObject)?.contents);
    const json = asRecord(contents?.json);
    if (!json) {
      throw new Error(`GraphQL ${url} returned no readable contents.json`);
    }
    const value = asRecord(json.value);
    if (!value) {
      throw new Error(`GraphQL ${url} returned no readable CircleConfig value`);
    }
    return { ...json, ...value };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The CircleConfig of the dynamic-field object `objectId` as one flat record
 * (the Field's root keys plus its value's keys). It is read from the Sui
 * GraphQL service of `options.network` (the current network when absent)
 * first, since it answers when every endpoint refuses JSON-RPC (NJA-2830);
 * when GraphQL is unavailable or its answer is unreadable it is read with
 * getObject. Throws when the read fails; returns null only when getObject
 * reports an object without content.
 */
export async function getCircleConfigFieldsByObjectId(
  client: CircleConfigObjectClient,
  objectId: string,
  options?: CircleConfigReadOptions,
): Promise<CircleConfigFields | null> {
  const graphqlUrl = resolveCircleConfigGraphqlUrl(options?.network);
  if (graphqlUrl) {
    try {
      return await readCircleConfigFieldsViaGraphql(graphqlUrl, objectId);
    } catch (error) {
      console.warn(
        `Sui GraphQL could not read CircleConfig ${objectId}, reading it with getObject: ${describeCircleConfigReadError(error)}`,
      );
    }
  }

  const configObject = await client.getObject({
    id: objectId,
    options: { showContent: true },
  });

  return extractCircleConfigFieldsFromObjectContent(configObject.data?.content);
}

export async function getCircleConfigFieldsFromDynamicFields(
  client: CircleConfigObjectClient,
  dynamicFields: Iterable<CircleConfigDynamicFieldLike | null | undefined>,
  options?: CircleConfigReadOptions,
): Promise<CircleConfigFields | null> {
  const objectId = getCircleConfigObjectId(dynamicFields);

  if (!objectId) {
    return null;
  }

  return getCircleConfigFieldsByObjectId(client, objectId, options);
}

/**
 * Every dynamic field of `circleId`, listed completely. The Sui GraphQL
 * service of `options.network` (the current network when absent) is asked
 * first, since it answers when every endpoint refuses JSON-RPC (NJA-2830);
 * when there is no GraphQL URL (or no `fetch`), or its list is failed,
 * malformed or partial, the fields are listed with JSON-RPC getDynamicFields
 * across every page. Throws when both fail: the first page, or any partial
 * list, is never returned as the whole list.
 */
export async function readCircleDynamicFields(
  client: DynamicFieldsJsonRpcClient,
  circleId: string,
  options?: CircleConfigReadOptions,
): Promise<DynamicFieldReading[]> {
  if (resolveCircleConfigGraphqlUrl(options?.network)) {
    try {
      return await readDynamicFieldsViaGraphql(options?.network ?? getCurrentNetwork(), circleId);
    } catch (error) {
      console.warn(
        `Sui GraphQL could not list the dynamic fields of circle ${circleId}, listing them with JSON-RPC: ${describeCircleConfigReadError(error)}`,
      );
    }
  }
  return readDynamicFieldsViaJsonRpc(client, circleId);
}

/**
 * The CircleConfig of `circleId`: the CircleConfig field of its complete
 * dynamic-field list (readCircleDynamicFields), read as
 * getCircleConfigFieldsByObjectId reads it, both from `options.network` (the
 * current network when absent). Throws when the list or the config cannot be
 * read; null means only that the complete list has no CircleConfig field (or
 * that getObject reported it without content).
 */
export async function getCircleConfigFields(
  client: CircleConfigClient,
  circleId: string,
  options?: CircleConfigReadOptions,
): Promise<CircleConfigFields | null> {
  const dynamicFields = await readCircleDynamicFields(client, circleId, options);
  return getCircleConfigFieldsFromDynamicFields(client, dynamicFields, options);
}
