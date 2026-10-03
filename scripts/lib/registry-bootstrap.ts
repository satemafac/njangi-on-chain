/**
 * The decisions behind scripts/bootstrap-package.mjs: is the registry id in
 * the env file the live registry of the package being bootstrapped, or a
 * placeholder or stale id that a fresh `init_registry` call must replace?
 * And does the package's lineage already have its ComplianceConfig, or must
 * `njangi_compliance::create_config` make one?
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
    previousTransaction?: string | null;
    content?: { fields?: Record<string, unknown> } | null;
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

/**
 * A JSON-RPC call: resolves with the response's `result` and rejects on an
 * HTTP or JSON-RPC error (rpcCall in scripts/bootstrap-package.mjs).
 */
export type RpcCall = (method: string, params: unknown[]) => Promise<unknown>;

/** The fields this module reads from a `sui_getTransactionBlock` result. */
interface TransactionResponse {
  effects?: { created?: { owner?: unknown; reference?: { objectId?: string } }[] | null } | null;
}

/** The fields this module reads from a `suix_queryEvents` page. */
interface EventPage {
  data?: { parsedJson?: { config_id?: unknown } | null }[] | null;
}

/** Sui caps `sui_multiGetObjects` at 50 ids per request. */
const MAX_MULTIGET_IDS = 50;

function isShared(owner: unknown): boolean {
  return typeof owner === 'object' && owner !== null && 'Shared' in owner;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The package id of a type that `definingType` returned. */
function packageOf(structType: string): string {
  return normalizeSuiId(structType.slice(0, structType.indexOf('::')));
}

/**
 * The shared objects of `structType` made by the transaction that created
 * `packageId`. For a package's first version that transaction is the
 * publish, where `njangi_compliance::init` shares the ComplianceConfig; an
 * upgrade runs no `init`, so its transaction makes none. Throws when the
 * transaction cannot be read: publicnode prunes transactions after a few
 * weeks (-32602), and can return them without their created objects.
 */
async function sharedObjectsCreatedWith(packageId: string, structType: string, rpc: RpcCall): Promise<string[]> {
  const pkg = (await rpc('sui_getObject', [packageId, { showPreviousTransaction: true }])) as ObjectResponse;
  if (pkg.error) throw new Error(`reading ${packageId} failed: ${JSON.stringify(pkg.error)}`);
  const digest = pkg.data?.previousTransaction;
  if (!digest) throw new Error(`the RPC returned ${packageId} without the transaction that created it`);

  const tx = (await rpc('sui_getTransactionBlock', [digest, { showEffects: true }])) as TransactionResponse;
  const created = tx.effects?.created ?? [];
  // Publishing creates at least the package's UpgradeCap.
  if (created.length === 0) {
    throw new Error(`the RPC returned transaction ${digest}, which created ${packageId}, without its created objects`);
  }

  const sharedIds = new Set<string>();
  for (const change of created) {
    const id = change.reference?.objectId;
    if (isShared(change.owner) && typeof id === 'string' && isSuiObjectId(id)) sharedIds.add(normalizeSuiId(id));
  }
  const ids = Array.from(sharedIds);
  const matches: string[] = [];
  for (let start = 0; start < ids.length; start += MAX_MULTIGET_IDS) {
    const chunk = ids.slice(start, start + MAX_MULTIGET_IDS);
    const responses = (await rpc('sui_multiGetObjects', [chunk, { showType: true, showOwner: true }])) as ObjectResponse[];
    if (!Array.isArray(responses) || responses.length !== chunk.length) {
      throw new Error(`the RPC answered ${chunk.length} object reads with ${JSON.stringify(responses)}`);
    }
    for (const [index, id] of chunk.entries()) {
      const { data, error } = responses[index];
      // Another module's shared object may have been deleted since. A
      // ComplianceConfig cannot be: the module never destroys one.
      if (error?.code === 'deleted') continue;
      if (error || !data?.type) throw new Error(`reading ${id} failed: ${JSON.stringify(error ?? responses[index])}`);
      if (normalizeStructType(data.type) === normalizeStructType(structType) && isShared(data.owner)) matches.push(id);
    }
  }
  return matches;
}

export type ComplianceConfigPlan =
  | { action: 'keep' }
  | { action: 'record'; id: string; reason: string }
  | { action: 'create'; reason: string }
  | { action: 'stop'; reason: string };

/**
 * What to do with the ComplianceConfig id `configured` (the env file's
 * value), given the lineage's full types of `ComplianceConfig` and of its
 * `ComplianceConfigCreated` event from `definingType`.
 *
 * A live shared config of exactly that type is kept, as `planRegistry` keeps
 * a registry. Anything else is not simply replaced, because a lineage must
 * keep ONE config: `njangi_compliance::init` already shares one on every
 * fresh publish, revocations and the expected issuer live in each config
 * separately, and a gated escrow accepts only the config it pinned. An app
 * pointed at a second config would record revocations that no gate reads. So
 * the lineage's existing config is looked up and recorded:
 *
 *   1. the config made with the package version that declares the type
 *      (`init`, on a fresh publish);
 *   2. failing that, the config named by the lineage's first
 *      `ComplianceConfigCreated` event (a `create_config` call), which is
 *      the one `resolveComplianceConfigId` in src/lib/compliance-gate.ts
 *      falls back to.
 *
 * The plan says create only when both find none. Step 1 also vouches for an
 * empty answer in step 2: a node that still serves the transaction that
 * introduced the type keeps every event since, and publicnode, which prunes
 * old transactions, fails event queries over pruned history instead of
 * leaving events out. Any read that fails stops the plan, as in
 * `planRegistry`.
 */
export async function planComplianceConfig(
  configured: string | undefined,
  types: { config: string; createdEvent: string },
  rpc: RpcCall,
): Promise<ComplianceConfigPlan> {
  const readObject = (id: string) =>
    rpc('sui_getObject', [id, { showType: true, showOwner: true }]) as Promise<ObjectResponse>;
  const current = await planRegistry(configured, types.config, readObject);
  if (current.action !== 'create') return current;
  const unusable = current.reason;

  const declaringPackage = packageOf(types.config);
  if (packageOf(types.createdEvent) !== declaringPackage) {
    return {
      action: 'stop',
      reason: `${unusable}, and ComplianceConfigCreated was declared after ComplianceConfig, so its events may miss a config`,
    };
  }

  let fromPublish: string[];
  try {
    fromPublish = await sharedObjectsCreatedWith(declaringPackage, types.config, rpc);
  } catch (err) {
    return { action: 'stop', reason: `${unusable}, and finding the lineage's config failed: ${errorMessage(err)}` };
  }
  if (fromPublish.length === 1) {
    const [id] = fromPublish;
    return { action: 'record', id, reason: `${unusable}; ${id} was created when ${declaringPackage} was published` };
  }
  if (fromPublish.length > 1) {
    return {
      action: 'stop',
      reason: `${unusable}, and publishing ${declaringPackage} created ${fromPublish.length} configs (${fromPublish.join(', ')})`,
    };
  }

  let page: EventPage;
  try {
    page = (await rpc('suix_queryEvents', [{ MoveEventType: types.createdEvent }, null, 1, false])) as EventPage;
  } catch (err) {
    return { action: 'stop', reason: `${unusable}, and querying ${types.createdEvent} events failed: ${errorMessage(err)}` };
  }
  if (!Array.isArray(page?.data)) {
    return { action: 'stop', reason: `${unusable}, and the RPC returned no ${types.createdEvent} event page` };
  }
  if (page.data.length === 0) {
    return { action: 'create', reason: `${unusable}, and this lineage has no ComplianceConfig yet` };
  }

  const announced = page.data[0]?.parsedJson?.config_id;
  if (typeof announced !== 'string' || !isSuiObjectId(announced)) {
    return { action: 'stop', reason: `${unusable}, and the first ${types.createdEvent} event names no config id` };
  }
  const check = await planRegistry(announced, types.config, readObject);
  if (check.action !== 'keep') {
    return {
      action: 'stop',
      reason: `${unusable}, and the config that the first ComplianceConfigCreated event announced is unusable: ${check.reason}`,
    };
  }
  const id = normalizeSuiId(announced);
  return { action: 'record', id, reason: `${unusable}; ${id} is the config the lineage's first ComplianceConfigCreated event announced` };
}

/**
 * `key = "value"` from the `[published.<network>]` table of a
 * move/Published.toml, or undefined. The Sui CLI writes that file, so this
 * reads only its flat `key = "string"` lines.
 */
export function publishedValue(toml: string, network: string, key: string): string | undefined {
  let inTable = false;
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      inTable = line === `[published.${network}]`;
      continue;
    }
    const match = inTable ? /^([\w-]+)\s*=\s*"([^"]*)"/.exec(line) : null;
    if (match && match[1] === key) return match[2];
  }
  return undefined;
}

export type UpgradeCapPlan = { action: 'use'; id: string } | { action: 'stop'; reason: string };

/**
 * The UpgradeCap to call `njangi_compliance::create_config` with: `override`
 * (NJANGI_BOOTSTRAP_UPGRADE_CAP_ID), else move/Published.toml's
 * `upgrade-capability` for `network`. It must be an UpgradeCap owned by the
 * address that signs, governing the package being bootstrapped (the cap's
 * `package` is its lineage's latest version). The contract checks the cap's
 * lineage itself (E_FOREIGN_UPGRADE_CAP, abort 306); these reads catch the
 * plain mistakes before anything is signed.
 */
export async function planUpgradeCap(
  source: { override?: string; publishedToml: string; network: string },
  expected: { owner: string; packageId: string },
  readObject: (id: string) => Promise<ObjectResponse>,
): Promise<UpgradeCapPlan> {
  const override = source.override?.trim();
  const tableKey = `upgrade-capability under [published.${source.network}] in move/Published.toml`;
  const from = override ? 'NJANGI_BOOTSTRAP_UPGRADE_CAP_ID' : tableKey;
  const id = override || publishedValue(source.publishedToml, source.network, 'upgrade-capability');
  if (!id) {
    return {
      action: 'stop',
      reason: `create_config needs the package's UpgradeCap: set NJANGI_BOOTSTRAP_UPGRADE_CAP_ID or the ${tableKey}`,
    };
  }
  if (!isSuiObjectId(id)) return { action: 'stop', reason: `${from} is "${id}", not an object id` };

  let response: ObjectResponse;
  try {
    response = await readObject(id);
  } catch (err) {
    return { action: 'stop', reason: `reading the UpgradeCap ${id} failed: ${errorMessage(err)}` };
  }
  if (response.error) {
    return { action: 'stop', reason: `the UpgradeCap ${id} (${from}) cannot be read: ${JSON.stringify(response.error)}` };
  }
  const type = response.data?.type ?? '';
  if (normalizeStructType(type) !== normalizeStructType('0x2::package::UpgradeCap')) {
    return { action: 'stop', reason: `${id} (${from}) is a ${type || 'object without a type'}, not an UpgradeCap` };
  }
  const owner = response.data?.owner;
  const holder =
    typeof owner === 'object' && owner !== null && 'AddressOwner' in owner
      ? String((owner as { AddressOwner: unknown }).AddressOwner)
      : '';
  if (!isSuiObjectId(holder) || !isSuiObjectId(expected.owner) || normalizeSuiId(holder) !== normalizeSuiId(expected.owner)) {
    return {
      action: 'stop',
      reason: `the UpgradeCap ${id} is owned by ${JSON.stringify(owner)}, not by the active address ${expected.owner}, which signs create_config`,
    };
  }
  const governed = response.data?.content?.fields?.package;
  if (typeof governed !== 'string' || !isSuiObjectId(governed) || normalizeSuiId(governed) !== normalizeSuiId(expected.packageId)) {
    return {
      action: 'stop',
      reason:
        `the UpgradeCap ${id} (${from}) governs ${String(governed)}, not ${expected.packageId}. ` +
        "Pass the latest package id of the cap's lineage, or the right UpgradeCap",
    };
  }
  return { action: 'use', id };
}
