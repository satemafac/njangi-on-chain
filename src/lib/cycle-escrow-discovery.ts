// cycle-escrow-discovery.ts — Auto-discover the live per-cycle escrow for a
// circle so members never have to copy/paste object ids.
//
// Two tiers, the durable one first, and every candidate VERIFIED before it
// is returned (the object exists, is a `njangi_cycle_escrow::CycleEscrow<T>`,
// and its `circle_id` points back at this circle):
//
//   1. the Circle's `escrow_history` dynamic field — a `vector<ID>` of every
//      escrow opened for the circle through the v1.1 indexed entries, oldest
//      first, so the LAST id is the current round. One object read, served
//      by every RPC endpoint, immune to event retention.
//
//      Tie-break: the NEWEST entry wins, unconditionally — never an older
//      entry that happens to be unfinalized. Production 2026-08-30 (circle
//      0xa3fada…675ed) minted two escrows for one round 34 seconds apart; the
//      newer one is the admin's latest intent, and resolving to it converges
//      every member's page onto a single pot, while "prefer the unfinalized
//      one" would resurrect the empty orphan the moment the real round
//      settled. The orphan reads as abandoned and its funds (if any) go back
//      through the ordinary cancel path. Once the package carrying the
//      duplicate-open guard (`E_ROUND_ALREADY_OPEN`) is published, two live
//      escrows for one round cannot exist and the tie-break is moot.
//   2. `CycleEscrowOpened` events — the historical path, kept as the fallback
//      for circles whose history field does not exist: they predate the
//      indexed opens, or their rounds were opened through the original
//      entries.
//
// Why the event scan could not stay primary: after Sui retired JSON-RPC on
// its public fullnodes, the configured primary (publicnode) prunes event
// history and answers EVERY `queryEvents` with "Could not find the
// referenced transaction events" — persistent, not transient — so the scan
// only ever succeeded on blockvision, which rations requests. Observed on
// production 2026-08-29/30: across one rotation lap of a three-member circle
// the contribute panel fell into its "couldn't reach the network" state four
// separate times, each clearing on reload, every one a 429 from the single
// endpoint that still served events.
//
// Doctrine (shared with custody-wallet-discovery.ts): a read that FAILED
// must surface as unknown — a thrown error here, which the panel renders as
// a retry — and must never be collapsed into "no escrow", which the panel
// renders as "this round hasn't been opened yet" and tells members to go
// chase an admin who already opened it.

import type { PaginatedEvents, SuiClient } from '@mysten/sui/client';
import type { NetworkType } from '../services/whatsapp-registry-service';
import { getNetworkConfig, getPackageIdForNetwork } from '../services/network-config';
import { getPublishedPackageMetadata } from './circle-chain';
import { getPooledSuiClient, withSuiRpcFailover } from '../services/sui-rpc-failover';
import type { CircleRotationPointer } from './cycle-round-progression';

/** Which discovery tier produced a summary. */
export type CycleEscrowDiscoverySource = 'escrow_history' | 'events';

export interface CycleEscrowSummary {
  escrowId: string;
  circleId: string;
  cycleNo: number;
  recipient: string;
  contributionAmount: string;
  requiredContributors: number;
  assetType: string;
  openedAtMs: number;
  source: CycleEscrowDiscoverySource;
}

export interface CycleEscrowLiveState {
  escrowId: string;
  cycleNo: number;
  recipient: string;
  contributionAmount: string;
  requiredContributors: number;
  contributorsSoFar: number;
  totalContributed: string;
  assetType: string;
  finalized: boolean;
  claimed: boolean;
  /**
   * Terminal: refunds began (cancel of an unfinalized escrow, or an expired
   * claim). Contributions, finalize and redeem all abort on chain from
   * here, so the panel must stop offering "pay your share" and instead let
   * the admin open the round again — chaining `release_open_round` once the
   * duplicate-open guard is published, because the refunded escrow still
   * pins its round until released.
   */
  refunded: boolean;
  contributedMembers: string[];
  /** Full rotation member list from the frozen snapshot (includes the
   *  recipient). The UI uses this to render a per-member progress ring. */
  members: string[];
  /** Phase 7: mirrors the on-chain `requires_attestation` flag. UI uses
   *  this to decide whether to route through the gated contribute/finalize
   *  paths that require a valid ComplianceAttestation. */
  requiresAttestation: boolean;
}

function packageIdFor(network: NetworkType): string {
  // Prefer the canonical resolver (handles legacy NEXT_PUBLIC_PACKAGE_ID
  // fallback). Browser bundles can return undefined from direct
  // process.env reads if the dev server was started before .env.local
  // was populated, which would silently break round discovery.
  const fromConfig = getPackageIdForNetwork(network);
  if (fromConfig && fromConfig.trim() !== '') return fromConfig;
  const envKey =
    network === 'mainnet'
      ? 'NEXT_PUBLIC_MAINNET_PACKAGE_ID'
      : 'NEXT_PUBLIC_TESTNET_PACKAGE_ID';
  const id = process.env[envKey];
  if (!id) {
    throw new Error(
      `Missing ${envKey}; cannot auto-discover CycleEscrow. Restart the dev server.`,
    );
  }
  return id;
}

// Move struct/event types are anchored to the package's ORIGINAL id, not the
// published-at, and that identity is preserved across upgrades. So a
// `MoveEventType` filter built from the (post-upgrade) published-at id matches
// nothing — querying `CycleEscrowOpened` events after a v1→v3 upgrade silently
// returned zero rows, which surfaced as a perpetual "round hasn't been opened
// yet" even though the open tx had landed. Prefer the original id for event
// queries; fall back to the published-at when no lineage is recorded.
export function eventTypePackageIdFor(network: NetworkType): string {
  const { originalId } = getPublishedPackageMetadata(network);
  if (originalId && originalId.trim() !== '') return originalId;
  return packageIdFor(network);
}

function decodeBytes(raw: unknown): Uint8Array {
  if (!raw) return new Uint8Array();
  if (raw instanceof Uint8Array) return raw;
  if (Array.isArray(raw)) return new Uint8Array(raw as number[]);
  if (typeof raw === 'string') {
    return /^[0-9a-fA-F]+$/.test(raw)
      ? new Uint8Array(Buffer.from(raw, 'hex'))
      : new Uint8Array(Buffer.from(raw, 'base64'));
  }
  return new Uint8Array();
}

function bytesToCanonicalType(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

// Pads as well as prefixing, so an id that arrives unpadded (a URL, an event
// payload) still compares equal to the 64-hex form the RPC returns. Not
// @mysten/sui's normalizeSuiObjectId, which does not strip an existing 0x —
// see custody-wallet-discovery.ts.
function normalizeAddress(value: string): string {
  return '0x' + value.trim().toLowerCase().replace(/^0x/, '').padStart(64, '0');
}

function matchesCircle(eventCircle: unknown, target: string): boolean {
  if (typeof eventCircle !== 'string') return false;
  return normalizeAddress(eventCircle) === normalizeAddress(target);
}

/** A nested Move struct arrives as `{ type, fields }` on most nodes and flattened on some. */
function unwrapStruct(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const inner = record.fields;
  if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
    return inner as Record<string, unknown>;
  }
  return record;
}

// ---------------------------------------------------------------------------
// Tier 1 — the circle's own escrow history
// ---------------------------------------------------------------------------

/**
 * `njangi_circles::FIELD_ESCROW_HISTORY` is `b"escrow_history"`: the field is
 * keyed by the raw `vector<u8>`, not a `0x1::string::String`, so the lookup
 * name is the byte array — `{ type: "vector<u8>", value: [101, 115, …] }` —
 * and a `String`-typed lookup derives a different child id and finds
 * nothing. (circle-record.ts documents the same pitfall from the listing
 * side: the name comes BACK as a byte array too.)
 */
export const ESCROW_HISTORY_FIELD_NAME: { type: string; value: number[] } = {
  type: 'vector<u8>',
  value: Array.from(new TextEncoder().encode('escrow_history')),
};

export type CircleEscrowHistoryRead =
  /** Oldest first, as recorded on chain; never empty. */
  | { kind: 'found'; escrowIds: string[] }
  /** The field does not exist: no round was ever opened through the indexed entries. */
  | { kind: 'absent' }
  /** The read failed. Nothing may be inferred. */
  | { kind: 'unknown' };

/**
 * The circle's on-chain escrow history.
 *
 * Tri-state on purpose. `absent` is a real answer, but a narrower one than
 * it looks: the circle may predate the indexed opens, or its rounds may have
 * been opened through the original entries, so the caller must ask the event
 * scan before concluding "no round". `unknown` is not an answer at all.
 */
export async function readCircleEscrowHistory(
  client: SuiClient,
  circleId: string,
): Promise<CircleEscrowHistoryRead> {
  try {
    const field = await client.getDynamicFieldObject({
      parentId: circleId,
      name: ESCROW_HISTORY_FIELD_NAME,
    });
    if (field.error) {
      const code = (field.error as { code?: string }).code ?? '';
      return code === 'dynamicFieldNotFound' ? { kind: 'absent' } : { kind: 'unknown' };
    }
    const content = field.data?.content;
    if (!content || content.dataType !== 'moveObject') return { kind: 'unknown' };
    const value = (content.fields as { value?: unknown }).value;
    if (!Array.isArray(value)) return { kind: 'unknown' };
    const escrowIds = value.filter(
      (id): id is string => typeof id === 'string' && id.trim() !== '',
    );
    // The contract creates the field holding its first id, so an empty
    // vector cannot occur on chain; read one as "nothing recorded" anyway.
    return escrowIds.length === 0 ? { kind: 'absent' } : { kind: 'found', escrowIds };
  } catch (err) {
    console.warn('[cycle-escrow-discovery] escrow_history read failed', { circleId, err });
    return { kind: 'unknown' };
  }
}

// ---------------------------------------------------------------------------
// Verification — every candidate passes through here, whichever tier named it
// ---------------------------------------------------------------------------

// Generic over the coin type, so the marker is matched rather than a suffix.
const CYCLE_ESCROW_TYPE_MARKER = '::njangi_cycle_escrow::CycleEscrow<';

export type CycleEscrowVerification =
  | { verdict: true; summary: Omit<CycleEscrowSummary, 'source'> }
  | { verdict: false }
  | { verdict: null };

/**
 * Reads a candidate and says whether it is this circle's escrow.
 *
 * Tri-state, mirroring `isCustodyWalletForCircle`: `false` must mean "read
 * it, and it is genuinely not this circle's escrow" (nonexistent, deleted,
 * some other object type, or a CycleEscrow whose `circle_id` points
 * elsewhere); `null` means "could not read". Collapsing a failed read to
 * `false` would reject a CORRECT candidate and push discovery down to a
 * weaker tier — or to "no round" — on the strength of a 429.
 *
 * On success the summary is built from the object itself rather than from
 * whatever named the candidate, so both tiers answer in the same shape from
 * the same source of truth.
 */
export async function verifyCycleEscrowForCircle(
  client: SuiClient,
  escrowId: string,
  circleId: string,
): Promise<CycleEscrowVerification> {
  try {
    const obj = await client.getObject({
      id: escrowId,
      options: { showType: true, showContent: true },
    });
    if (obj.error) {
      const code = (obj.error as { code?: string }).code ?? '';
      // A deleted/nonexistent object is a real answer; anything else is
      // an unknown.
      return code === 'deleted' || code === 'notExists' ? { verdict: false } : { verdict: null };
    }
    const type = obj.data?.type ?? '';
    if (!type) return { verdict: null };
    if (!type.includes(CYCLE_ESCROW_TYPE_MARKER)) return { verdict: false };

    const content = obj.data?.content;
    if (!content || content.dataType !== 'moveObject') return { verdict: null };
    const fields = content.fields as Record<string, unknown>;
    const circleIdField = fields.circle_id;
    if (
      typeof circleIdField !== 'string' ||
      normalizeAddress(circleIdField) !== normalizeAddress(circleId)
    ) {
      return { verdict: false };
    }

    // Every CycleEscrow carries its frozen snapshot; a read without one is
    // not a readable escrow and must not pass as one.
    const snapshot = unwrapStruct(fields.snapshot);
    if (!snapshot) return { verdict: null };

    return {
      verdict: true,
      summary: {
        escrowId: obj.data?.objectId ?? escrowId,
        circleId: circleIdField,
        cycleNo: Number(snapshot.cycle_no ?? 0),
        recipient: String(snapshot.recipient ?? ''),
        contributionAmount: String(snapshot.contribution_amount ?? '0'),
        requiredContributors: Number(snapshot.required_contributors ?? 0),
        assetType: bytesToCanonicalType(decodeBytes(snapshot.asset_type)),
        openedAtMs: Number(snapshot.opened_at_ms ?? 0),
      },
    };
  } catch (err) {
    console.warn('[cycle-escrow-discovery] escrow verification read failed', { escrowId, err });
    return { verdict: null };
  }
}

/**
 * True only for a real CycleEscrow whose circle_id points at `circleId`;
 * null when it could not be read. The boolean view of
 * `verifyCycleEscrowForCircle`, for callers that hold an id and want a
 * verdict rather than a summary.
 */
export async function isCycleEscrowForCircle(
  client: SuiClient,
  escrowId: string,
  circleId: string,
): Promise<boolean | null> {
  return (await verifyCycleEscrowForCircle(client, escrowId, circleId)).verdict;
}

// ---------------------------------------------------------------------------
// Tier 2 — the event scan
// ---------------------------------------------------------------------------

/**
 * Scans recent `CycleEscrowOpened` events for the circle, newest first, and
 * returns the first candidate that verifies. Null means the scan completed
 * and nothing matched — which is only "no round" if the caller has ruled
 * out the durable tier. A scan that fails on every endpoint throws, and so
 * does a candidate that cannot be verified.
 */
async function findCycleEscrowFromEvents(
  network: NetworkType,
  circleId: string,
  client: SuiClient,
  opts: { cycleNo?: number; limit?: number },
): Promise<CycleEscrowSummary | null> {
  const packageId = eventTypePackageIdFor(network);
  const limit = opts.limit ?? 50;
  let events: PaginatedEvents;
  try {
    // Event history must go through the failover chain, NOT the caller's
    // client. The providers are not interchangeable: publicnode and suiscan
    // serve object reads but refuse event history, and they are deliberately
    // tried FIRST so ordinary reads do not burn blockvision's rationed budget
    // (see RATE_LIMITED_RPC_HOSTS). So a client pinned to the configured
    // primary — which is what every caller passes — sends the one query that
    // requires event history to the one endpoint that cannot serve it, and
    // fails 100% of the time rather than intermittently.
    events = await withSuiRpcFailover(network, 'findCurrentCycleEscrow', (failoverClient) =>
      failoverClient.queryEvents({
        query: { MoveEventType: `${packageId}::njangi_cycle_escrow::CycleEscrowOpened` },
        limit,
        order: 'descending',
      }),
    );
  } catch (err) {
    // Rethrow rather than reporting a failed read as "no escrow".
    //
    // Swallowing this returned null, which is indistinguishable from a circle
    // whose round genuinely has not been opened — so a rate-limited query
    // rendered "This round hasn't been opened yet" on a circle whose round WAS
    // open, telling members to go chase an admin who had already done it.
    //
    // Every caller already handles a throw (the panel surfaces a retry; the
    // alert and attestation sweeps skip the circle), which is the behaviour
    // they each wanted anyway.
    console.warn('[cycle-escrow-discovery] Failed to query CycleEscrowOpened', err);
    throw err;
  }

  for (const event of events.data) {
    const parsed = (event.parsedJson ?? {}) as Record<string, unknown>;
    if (!matchesCircle(parsed.circle_id, circleId)) continue;
    if (typeof opts.cycleNo === 'number' && Number(parsed.cycle_no) !== opts.cycleNo) continue;
    const escrowId = typeof parsed.escrow_id === 'string' ? parsed.escrow_id : '';
    if (!escrowId) continue;

    const verified = await verifyCycleEscrowForCircle(client, escrowId, circleId);
    if (verified.verdict === null) {
      throw new Error(
        `[cycle-escrow-discovery] Found a CycleEscrowOpened event for ${circleId} but could not read escrow ${escrowId} to verify it.`,
      );
    }
    if (verified.verdict === false) {
      console.warn(
        '[cycle-escrow-discovery] CycleEscrowOpened named an object that is not this circle’s escrow; skipping',
        { circleId, escrowId },
      );
      continue;
    }
    return { ...verified.summary, source: 'events' };
  }
  return null;
}

// ---------------------------------------------------------------------------
// The resolver
// ---------------------------------------------------------------------------

/**
 * The current round's escrow for a circle, or null when the circle has
 * genuinely not had a round opened. Optionally filters by cycle number; pass
 * `undefined` to pick the latest regardless.
 *
 * Throws when the answer is UNKNOWN — every tier failed, or the durable tier
 * failed and the lossy one found nothing in its window — rather than
 * returning null. Every caller already handles a throw (the panel surfaces
 * a retry; the alert and attestation sweeps skip the circle), and each of
 * them renders null as a confident statement about the round that a failed
 * read cannot back.
 *
 * Object reads share the pooled failover client (or the caller's, which is
 * the same thing for every page); the event scan picks its own endpoint —
 * see `findCycleEscrowFromEvents` for why the two must differ.
 */
export async function findCurrentCycleEscrow(
  network: NetworkType,
  circleId: string,
  opts?: { cycleNo?: number; limit?: number; client?: SuiClient },
): Promise<CycleEscrowSummary | null> {
  const client =
    opts?.client ??
    getPooledSuiClient({ network, rpcUrl: getNetworkConfig(network).rpcUrl });
  const wantedCycle = typeof opts?.cycleNo === 'number' ? opts.cycleNo : undefined;

  // Tier 1: the circle's own record of its escrows.
  const history = await readCircleEscrowHistory(client, circleId);
  let historyUnknown = history.kind === 'unknown';
  if (history.kind === 'found') {
    // Newest last on chain, and newest wins — see the tie-break in the
    // header: an older unfinalized entry is an orphan, not the round.
    // Without a cycle filter only the last id can be the current round, so
    // only it is read; with one, walk back to the newest escrow of that
    // cycle (a cycle number spans a whole rotation lap, so several escrows
    // share it).
    const newestFirst = [...history.escrowIds].reverse();
    const candidates = wantedCycle === undefined ? newestFirst.slice(0, 1) : newestFirst;
    for (const escrowId of candidates) {
      const verified = await verifyCycleEscrowForCircle(client, escrowId, circleId);
      if (verified.verdict === null) {
        historyUnknown = true;
        break;
      }
      if (verified.verdict === false) {
        // Cannot happen by construction — `record_escrow_opened` is
        // package-internal and only ever appends an id the package just
        // minted for THIS circle — so a failing entry earns a loud line,
        // and is skipped rather than trusted.
        console.warn(
          '[cycle-escrow-discovery] escrow_history entry did not verify as this circle’s escrow; skipping',
          { circleId, escrowId },
        );
        continue;
      }
      if (wantedCycle !== undefined && verified.summary.cycleNo !== wantedCycle) continue;
      return { ...verified.summary, source: 'escrow_history' };
    }
  }
  if (historyUnknown) {
    console.warn(
      '[cycle-escrow-discovery] escrow_history unreadable; falling back to CycleEscrowOpened events',
      { circleId },
    );
  }

  // Tier 2: the event scan, for circles the history cannot answer for.
  const fromEvents = await findCycleEscrowFromEvents(network, circleId, client, {
    cycleNo: wantedCycle,
    limit: opts?.limit,
  });
  if (fromEvents) return fromEvents;

  if (historyUnknown) {
    // The durable source could not be read and the lossy one found nothing
    // in its window. That is not "no round"; say so.
    throw new Error(
      `[cycle-escrow-discovery] Could not determine the current round for ${circleId}: escrow_history was unreadable and no CycleEscrowOpened event was found in the scan window.`,
    );
  }
  return null;
}

/**
 * Fetches the current on-chain state of a CycleEscrow for UI progress
 * displays ("4 of 7 members have paid in", "finalized / claimed").
 */
export async function readCycleEscrowState(
  escrowId: string,
  network: NetworkType,
  client?: SuiClient,
): Promise<CycleEscrowLiveState | null> {
  const rpcClient =
    client ??
    getPooledSuiClient({
      network,
      rpcUrl: getNetworkConfig(network).rpcUrl,
    });
  const obj = await rpcClient.getObject({
    id: escrowId,
    options: { showContent: true },
  });
  if (!obj.data?.content || obj.data.content.dataType !== 'moveObject') {
    return null;
  }
  const fields =
    (obj.data.content as { fields: Record<string, unknown> }).fields;

  const snapshotWrapper = (fields.snapshot as { fields?: Record<string, unknown> } | undefined)
    ?.fields;
  const snapshot = snapshotWrapper ?? (fields.snapshot as Record<string, unknown> | undefined);
  if (!snapshot) return null;

  const membersRaw = snapshot.members;
  const members = Array.isArray(membersRaw) ? membersRaw.map((m) => String(m)) : [];
  const assetBytes = decodeBytes(snapshot.asset_type);

  const contributedTable = fields.contributed as Record<string, unknown> | undefined;
  // `Table<address, bool>` surfaces size via `fields.size` in RPC output;
  // fall back to the separate contributors_count field we track on chain.
  const tableSize = contributedTable && typeof contributedTable === 'object'
    ? Number((contributedTable as { fields?: { size?: unknown } }).fields?.size ?? 0)
    : 0;
  const contributorsCount = Number(fields.contributors_count ?? tableSize ?? 0);

  const balance = fields.balance as { fields?: { value?: unknown } } | undefined;
  const totalContributed = balance && balance.fields?.value !== undefined
    ? String(balance.fields.value)
    : '0';

  const contributedMembers: string[] = [];
  // The full contributor list is only retrievable via dynamic field pagination
  // which is expensive; the webhook / UI can reconstruct it from
  // ContributionRecorded events if needed. Leave empty here.

  // The recipient sits out the round they collect, so the on-chain
  // finalize gate uses `required_contributors = members - 1` (the v3 fix).
  // Read it straight from the frozen snapshot rather than re-deriving from
  // members.length, which over-counted by one and showed "0/3" instead of
  // "0/2" in the UI.
  const requiredContributors = Number(
    snapshot.required_contributors ?? Math.max(0, members.length - 1),
  );

  return {
    escrowId,
    cycleNo: Number(snapshot.cycle_no ?? 0),
    recipient: String(snapshot.recipient ?? ''),
    contributionAmount: String(snapshot.contribution_amount ?? '0'),
    requiredContributors,
    contributorsSoFar: contributorsCount,
    totalContributed,
    assetType: bytesToCanonicalType(assetBytes),
    finalized: Boolean(fields.finalized),
    claimed: Boolean(fields.claimed),
    refunded: Boolean(fields.refunded),
    contributedMembers,
    members,
    requiresAttestation: Boolean(fields.requires_attestation),
  };
}

/** Pages of the `contributed` table read before the listing is declared unreadable. */
const MAX_CONTRIBUTED_TABLE_PAGES = 20;

type ContributedTableRead =
  | { kind: 'found'; contributors: string[] }
  | { kind: 'unknown' };

/**
 * Tier 1 for `listContributors`: the escrow's own `contributed` table.
 *
 * `contribute` adds `true` under the sender and the refund paths remove
 * entries as they pay out (njangi_cycle_escrow.move), so the table's key
 * set IS the current contributor set and its `size` is authoritative. The
 * table's entries are dynamic fields keyed by address, listed by an
 * object-level call every endpoint serves.
 *
 * The listing is accepted only when it accounts for every entry the table
 * reports. A short page is not "fewer contributors" — it is an unreadable
 * table, and reads as unknown.
 */
async function readContributedTable(
  client: SuiClient,
  escrowId: string,
): Promise<ContributedTableRead> {
  try {
    const obj = await client.getObject({ id: escrowId, options: { showContent: true } });
    const content = obj.data?.content;
    if (!content || content.dataType !== 'moveObject') return { kind: 'unknown' };
    const fields = content.fields as Record<string, unknown>;
    const table = unwrapStruct(fields.contributed);
    const idRaw = table?.id;
    const tableId = typeof idRaw === 'string' ? idRaw : unwrapStruct(idRaw)?.id;
    const size = Number(table?.size);
    if (typeof tableId !== 'string' || !Number.isInteger(size) || size < 0) {
      return { kind: 'unknown' };
    }
    if (size === 0) return { kind: 'found', contributors: [] };

    const contributors: string[] = [];
    let cursor: string | null | undefined;
    for (let page = 0; page < MAX_CONTRIBUTED_TABLE_PAGES; page += 1) {
      const res = await client.getDynamicFields({ parentId: tableId, cursor: cursor ?? undefined });
      for (const entry of res.data) {
        const name = entry.name as { type?: string; value?: unknown } | undefined;
        if (name?.type === 'address' && typeof name.value === 'string') {
          contributors.push(name.value);
        }
      }
      if (!res.hasNextPage || !res.nextCursor) break;
      cursor = res.nextCursor;
    }

    if (contributors.length !== size) {
      console.warn(
        '[cycle-escrow-discovery] contributed table listing did not match its size; treating as unreadable',
        { escrowId, size, listed: contributors.length },
      );
      return { kind: 'unknown' };
    }
    return { kind: 'found', contributors };
  } catch (err) {
    console.warn('[cycle-escrow-discovery] contributed table read failed', { escrowId, err });
    return { kind: 'unknown' };
  }
}

/**
 * Members who have paid into an escrow, so the UI can render a per-member
 * "paid / not paid" progress grid and decide whether to offer "Pay your
 * share".
 *
 * Primary: the escrow's `contributed` table (`readContributedTable`), a
 * plain object read. Fallback: `ContributionRecorded` events, which only
 * some endpoints serve — the same routing rule as `findCurrentCycleEscrow`.
 *
 * Throws when the answer is unknown. Returning [] for a failed read told
 * members who HAD paid that their share was still due (NjangiRoundAlerts);
 * every caller already has a per-circle catch that skips the circle rather
 * than asserting a falsehood about it.
 */
export async function listContributors(
  escrowId: string,
  network: NetworkType,
  client?: SuiClient,
): Promise<string[]> {
  const rpcClient =
    client ??
    getPooledSuiClient({
      network,
      rpcUrl: getNetworkConfig(network).rpcUrl,
    });

  const table = await readContributedTable(rpcClient, escrowId);
  if (table.kind === 'found') return table.contributors;
  console.warn(
    '[cycle-escrow-discovery] contributed table unreadable; falling back to ContributionRecorded events',
    { escrowId },
  );

  const packageId = eventTypePackageIdFor(network);
  let events: PaginatedEvents;
  try {
    events = await withSuiRpcFailover(network, 'listContributors', (failoverClient) =>
      failoverClient.queryEvents({
        query: {
          MoveEventType: `${packageId}::njangi_cycle_escrow::ContributionRecorded`,
        },
        limit: 200,
        order: 'descending',
      }),
    );
  } catch (err) {
    console.warn('[cycle-escrow-discovery] Failed to list contributors', err);
    throw err;
  }

  const contributors: string[] = [];
  for (const event of events.data) {
    const parsed = (event.parsedJson ?? {}) as Record<string, unknown>;
    if (!matchesCircle(parsed.escrow_id, escrowId)) continue;
    const who = parsed.contributor;
    if (typeof who === 'string' && !contributors.includes(who)) {
      contributors.push(who);
    }
  }
  if (contributors.length === 0) {
    // The table could not be read and the scan window holds nothing for
    // this escrow. That is not "nobody has paid"; say so.
    throw new Error(
      `[cycle-escrow-discovery] Could not determine who has paid into ${escrowId}: the contributed table was unreadable and no ContributionRecorded event was found in the scan window.`,
    );
  }
  return contributors;
}

/**
 * Reads where a circle's rotation pointer stands. Needed to tell a settled
 * round that the circle has moved on (so the admin can open the next one)
 * from one whose rotation stalled (so the recovery advance is the right
 * call) — a settled escrow alone cannot distinguish them, which is why the
 * UI was stuck on round 1. See `resolveNextRoundAction` for the decision.
 *
 * Mirrors `njangi_circles::get_next_payout_recipient`: the pointer is
 * `rotation_order[current_position]`, and a past-the-end index or the 0x0
 * placeholder both mean "no valid recipient".
 *
 * Throws on RPC failure rather than returning null. Null means "read the
 * circle, and it is not a Move object" — a genuine fact. Collapsing the two
 * would let an outage present as a rotation state and put a control in
 * front of the admin that double-pays a member.
 */
export async function readCircleRotationPointer(
  circleId: string,
  network: NetworkType,
  client?: SuiClient,
): Promise<CircleRotationPointer | null> {
  const rpcClient =
    client ??
    getPooledSuiClient({
      network,
      rpcUrl: getNetworkConfig(network).rpcUrl,
    });
  const obj = await rpcClient.getObject({ id: circleId, options: { showContent: true } });
  if (!obj.data?.content || obj.data.content.dataType !== 'moveObject') return null;
  const fields = (obj.data.content as { fields: Record<string, unknown> }).fields;

  const currentCycle = Number(fields.current_cycle ?? 0);
  const currentPosition = Number(fields.current_position ?? 0);
  const rotationRaw = fields.rotation_order;
  const rotationOrder = Array.isArray(rotationRaw) ? rotationRaw.map((a) => String(a)) : [];

  const at =
    Number.isInteger(currentPosition) && currentPosition >= 0
      ? rotationOrder[currentPosition]
      : undefined;
  const nextRecipient =
    typeof at === 'string' && at.trim() !== '' && !/^0x0+$/.test(at.trim()) ? at : null;

  return {
    currentCycle,
    currentPosition,
    nextRecipient,
    pausedAfterCycle: Boolean(fields.paused_after_cycle),
  };
}
