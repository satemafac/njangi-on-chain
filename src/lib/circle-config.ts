import type { SuiClient } from '@mysten/sui/client';

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

export async function getCircleConfigFieldsByObjectId(
  client: CircleConfigObjectClient,
  objectId: string,
): Promise<CircleConfigFields | null> {
  const configObject = await client.getObject({
    id: objectId,
    options: { showContent: true },
  });

  return extractCircleConfigFieldsFromObjectContent(configObject.data?.content);
}

export async function getCircleConfigFieldsFromDynamicFields(
  client: CircleConfigObjectClient,
  dynamicFields: Iterable<CircleConfigDynamicFieldLike | null | undefined>,
): Promise<CircleConfigFields | null> {
  const objectId = getCircleConfigObjectId(dynamicFields);

  if (!objectId) {
    return null;
  }

  return getCircleConfigFieldsByObjectId(client, objectId);
}

export async function getCircleConfigFields(
  client: CircleConfigClient,
  circleId: string,
): Promise<CircleConfigFields | null> {
  const dynamicFields = await client.getDynamicFields({ parentId: circleId });
  return getCircleConfigFieldsFromDynamicFields(client, dynamicFields.data);
}
