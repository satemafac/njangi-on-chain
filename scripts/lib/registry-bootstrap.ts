/**
 * The decisions behind scripts/bootstrap-package.mjs: is the registry id in
 * the env file the live registry of the package being bootstrapped, or a
 * placeholder or stale id that a fresh `init_registry` call must replace?
 *
 * Node runs this file directly (type stripping; the package.json next to it
 * marks the folder as ESM, so Node does not warn), and jest runs
 * src/__tests__/scripts/registry-bootstrap.test.ts against it. Keep it
 * erasable TypeScript without imports: no enums, namespaces or parameter
 * properties.
 */

/** `0x` and 1 to 64 hex digits: the forms the RPC and `sui client` accept. */
export function isSuiObjectId(value: string): boolean {
  return /^0x[0-9a-fA-F]{1,64}$/.test(value);
}

/** Full length and lowercase, so ids that passed `isSuiObjectId` compare as strings. */
export function normalizeSuiId(id: string): string {
  return `0x${id.slice(2).toLowerCase().padStart(64, '0')}`;
}

/**
 * `0xADDR::module::Name` with the address normalized, or null for anything
 * else. Generic types are null too: neither registry takes type parameters.
 */
export function normalizeStructType(type: string): string | null {
  const match = /^(0x[0-9a-fA-F]{1,64})::(\w+)::(\w+)$/.exec(type);
  return match ? `${normalizeSuiId(match[1])}::${match[2]}::${match[3]}` : null;
}

/** One row of a package's type origin table. Older nodes say `struct_name`. */
export interface TypeOrigin {
  module_name: string;
  datatype_name?: string;
  struct_name?: string;
  package: string;
}

/** The fields this module reads from a `sui_getObject` result. */
export interface ObjectResponse {
  data?: {
    type?: string | null;
    owner?: unknown;
    bcs?: { dataType?: string; typeOriginTable?: TypeOrigin[] } | null;
  } | null;
  error?: { code?: string; [field: string]: unknown } | null;
}

/**
 * The full type of `moduleName::name` in the lineage of the package that
 * `pkg` describes (a `sui_getObject` result read with `showBcs`).
 *
 * Sui names every type after the package version that first declared it, and
 * every later version records that id in its type origin table. Calls go to
 * the newest version while objects keep the declaring id: testnet v9
 * (0xf8afd3df…) declares none of the bootstrap's types, which all carry the
 * original 0x89cddf4d…, while types added by later upgrades carry those
 * upgrades' ids. So neither `${packageId}::…` nor `${originalId}::…` is right
 * in general; the table is. A fresh publish starts a new lineage whose table
 * names its own id, which is what tells an old lineage's registry apart.
 */
export function definingType(pkg: ObjectResponse, moduleName: string, name: string): string {
  if (pkg.error) {
    throw new Error(`the package cannot be read (${JSON.stringify(pkg.error)}); wrong network or RPC?`);
  }
  const bcs = pkg.data?.bcs;
  if (bcs?.dataType !== 'package' || !Array.isArray(bcs.typeOriginTable)) {
    throw new Error('the object is not a package (the RPC returned no type origin table)');
  }
  const origin = bcs.typeOriginTable.find(
    (row) => row.module_name === moduleName && (row.datatype_name ?? row.struct_name) === name,
  );
  if (!origin || !isSuiObjectId(origin.package)) {
    throw new Error(`the package does not declare ${moduleName}::${name}`);
  }
  return `${normalizeSuiId(origin.package)}::${moduleName}::${name}`;
}

export type RegistryPlan =
  | { action: 'keep' }
  | { action: 'create'; reason: string }
  | { action: 'stop'; reason: string };

/**
 * What to do with the registry id `configured` (the env file's value), given
 * `expectedType` from `definingType`.
 *
 * Keep it only when it is a live shared object of exactly that type. Create a
 * new registry when the value is empty, an .env.example placeholder such as
 * `0xyour_testnet_whatsapp_registry_id`, an id that does not exist on this
 * network, a deleted object, or an object of another type (another lineage's
 * registry included). Stop when the read fails: the answer is unknown, and a
 * registry created on a guess would point the app at an empty registry while
 * the live one keeps every link.
 */
export async function planRegistry(
  configured: string | undefined,
  expectedType: string,
  readObject: (id: string) => Promise<ObjectResponse>,
): Promise<RegistryPlan> {
  const value = configured?.trim() ?? '';
  if (value === '') return { action: 'create', reason: 'it is not set' };
  if (!isSuiObjectId(value)) {
    return { action: 'create', reason: `${value} is a placeholder, not an object id` };
  }

  let response: ObjectResponse;
  try {
    response = await readObject(value);
  } catch (err) {
    return {
      action: 'stop',
      reason: `reading ${value} failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const code = response.error?.code;
  if (code === 'notExists') return { action: 'create', reason: `${value} does not exist on this network` };
  if (code === 'deleted') return { action: 'create', reason: `${value} was deleted` };
  if (response.error) {
    return { action: 'stop', reason: `reading ${value} failed: ${JSON.stringify(response.error)}` };
  }

  const type = response.data?.type;
  const owner = response.data?.owner;
  if (!type || owner == null) {
    return { action: 'stop', reason: `the RPC returned ${value} without its type and owner` };
  }
  if (normalizeStructType(type) !== normalizeStructType(expectedType)) {
    return { action: 'create', reason: `${value} is a ${type}, not a ${expectedType}` };
  }
  if (typeof owner !== 'object' || !('Shared' in owner)) {
    return { action: 'create', reason: `${value} is not a shared object (owner: ${JSON.stringify(owner)})` };
  }
  return { action: 'keep' };
}
