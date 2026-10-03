// circle-events.ts — Pure event-stream definitions for the
// /api/cron/whatsapp-circle-events Vercel cron, ported from the retired
// whatsapp-bot-backend's CircleLinkListenerService (a 5-second polling
// daemon that could never run in the serverless deploy layout — see
// whatsapp-bot-backend/DEPRECATED.md).
//
// Each stream maps one on-chain Move event type to a WhatsApp text
// notification for the circle's linked (admin) phone number. The cron
// drains every stream with its own durable Postgres cursor; this module
// stays pure (no I/O) so parsing and message copy are unit-testable.
//
// Differences from the legacy bot, on purpose:
//   * Each stream exposes BOTH shapes: a plain-text body (the legacy text
//     fallback, sent while WHATSAPP_TEMPLATES_ENABLED=false) and, where the
//     cron context can fill every approved placeholder, a Meta template
//     payload under the legacy template name (sent when the flag is on —
//     Meta rejects business-initiated freeform text outside the 24h
//     service window; see the approval workflow block in
//     src/lib/whatsapp-notifier.ts). Streams whose legacy templates need
//     aggregates the serverless cron does not compute (paid counts, member
//     totals, schedules) return null from buildTemplate and keep the text
//     fallback until a leaner template is approved.
//   * Phone resolution uses the current on-chain registry schema
//     (walrus_blob_id + Walrus decrypt). The bot read a plaintext
//     `admin_phone_number` field that no longer exists on chain.
//   * Dedupe/cursor state lives in Postgres (whatsapp_notifications +
//     cycle_finalized_cursor tables), not process memory.
//   * Contributions and payouts come from the per-round escrow rail
//     (njangi_cycle_escrow::ContributionRecorded / ClaimRedeemed). The bot
//     listened to the legacy njangi_payments rail's ContributionMade,
//     StablecoinContributionMade and PayoutProcessed, which no live circle
//     emits: that rail is switched off (isLegacyRailEnabled), and as of
//     2026-09-27 the testnet lineage had never emitted any of the three.
//     Escrow events name an escrow, not a circle, so those two streams
//     define `escrowIdOf` and the cron reads the escrow object first (see
//     EscrowSubject).

import type { WhatsAppTemplatePayload } from '../whatsapp-notifier';
import { buildLinkConfirmation } from '../../content/whatsapp-updates';

// ---------------------------------------------------------------------------
// Amount formatting (ported from the bot's formatTokenAmount helpers)
// ---------------------------------------------------------------------------

export function getCoinLabelFromType(coinType: string | null | undefined): string {
  const normalized = coinType?.trim();
  if (!normalized) return 'SUI';

  const upper = normalized.toUpperCase();
  if (upper === 'SUI' || upper.endsWith('::SUI')) return 'SUI';
  if (upper.includes('USDC')) return 'USDC';
  if (upper.includes('USDT')) return 'USDT';
  if (upper === 'STABLECOIN' || upper.endsWith('::STABLECOIN')) return 'Stablecoin';

  const lastSegment = normalized.split('::').filter(Boolean).pop();
  return lastSegment ? lastSegment.toUpperCase() : upper;
}

function parseNumericField(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * "1500000000" + "0x…::sui::SUI" → "1.5000 SUI". Stablecoins use 6
 * decimals / 2 fraction digits; SUI uses 9 / 4 (legacy bot behavior).
 * Returns null when the raw amount cannot be parsed.
 */
export function formatTokenAmount(
  rawAmount: unknown,
  coinType?: string | null,
): string | null {
  const amountValue = parseNumericField(rawAmount);
  if (amountValue === null) return null;

  const label = getCoinLabelFromType(coinType);
  const decimals = label === 'USDC' || label === 'USDT' || label === 'Stablecoin' ? 6 : 9;
  const fractionDigits = label === 'SUI' ? 4 : 2;
  return `${(amountValue / Math.pow(10, decimals)).toFixed(fractionDigits)} ${label}`;
}

export function shortAddress(address: string): string {
  if (typeof address !== 'string' || address.length < 11) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

/** Labels whose decimals formatTokenAmount knows rather than guesses. */
const KNOWN_DECIMALS_LABELS = new Set(['SUI', 'USDC', 'USDT']);

/**
 * formatTokenAmount for an escrow's coin, or null when the coin is not one
 * whose decimals are known. Opening an escrow is permissionless and generic
 * over `T`, and formatTokenAmount's 9-decimal default would misreport any
 * other coin by orders of magnitude — so the copy omits the figure instead.
 */
function formatEscrowAmount(rawAmount: unknown, coinType: string): string | null {
  return KNOWN_DECIMALS_LABELS.has(getCoinLabelFromType(coinType))
    ? formatTokenAmount(rawAmount, coinType)
    : null;
}

// ---------------------------------------------------------------------------
// Stream definitions
// ---------------------------------------------------------------------------

/** Enrichment the cron resolves before building the body. */
export interface CircleEventMessageContext {
  /** Circle display name; falls back to 'Your circle'. */
  circleName: string;
  /** Display name from the join-requests DB, when one exists. */
  memberName: string | null;
  /** Coin type resolved from the surrounding transaction (deposits only). */
  resolvedCoinType: string | null;
  /** Web app origin for deep links, e.g. https://njangionchain.com */
  appBaseUrl: string;
}

export interface ParsedCircleEvent {
  circleId: string;
  /**
   * Member the notification talks about; the cron looks up their display
   * name in the join-requests DB. Undefined for circle-scoped events.
   */
  memberAddress?: string;
  /**
   * Unlink confirmations must resolve the phone from a now-DISABLED
   * registry link (the Postgres index row is deleted on unlink).
   */
  includeDisabledLink?: boolean;
  /** Builds the final WhatsApp text body once enrichment is resolved. */
  buildBody(ctx: CircleEventMessageContext): string;
  /**
   * Builds the Meta-approved template payload for this event (legacy
   * template names — circle_unlink, member_joins, payout_processed, …).
   * Returns null when the cron context cannot faithfully fill the
   * approved placeholder layout; the dispatcher then falls back to
   * `buildBody` text even when WHATSAPP_TEMPLATES_ENABLED=true.
   */
  buildTemplate?(ctx: CircleEventMessageContext): WhatsAppTemplatePayload | null;
}

/**
 * What the cron reads off a `njangi_cycle_escrow::CycleEscrow<T>` for the
 * escrow-rail streams, whose events carry the escrow id but neither the
 * circle id nor the coin type. All three fields are frozen when the escrow
 * opens (the circle id and snapshot never change; `T` is the object's
 * type), and escrows are shared objects that are never deleted — so a read
 * made any time after the event returns what the event was emitted under.
 */
export interface EscrowSubject {
  circleId: string;
  /** `T` of `CycleEscrow<T>`, e.g. `0x…::usdc::USDC` or `0x2::sui::SUI`. */
  coinType: string;
  /** Members who pay into the round (all but the recipient); null if unreadable. */
  requiredContributors: number | null;
}

export interface CircleEventStream {
  /** Stable stream name — cursor key suffix + audit kind detail. */
  name: string;
  /**
   * Which package defines the event's module: the core njangi package or
   * the whatsapp_integration package (derived from the registry object's
   * type at runtime — they may share one package id today, but the
   * registry survives republish cycles where the env var lags).
   */
  source: 'core' | 'whatsapp';
  /** Builds the Move event type tag from the DEFINING package id. */
  eventType(definingPackageId: string): string;
  /**
   * Escrow-rail streams only: the escrow the event names. The cron reads
   * that object and passes the result to `parse`. Null for a payload with
   * no escrow id (advance, no send).
   */
  escrowIdOf?(parsedJson: unknown): string | null;
  /**
   * Returns null for malformed or filtered payloads (advance, no send).
   * `escrow` is supplied exactly for streams that define `escrowIdOf`.
   */
  parse(parsedJson: unknown, escrow?: EscrowSubject): ParsedCircleEvent | null;
}

type RawEvent = Record<string, unknown>;

function asRecord(parsedJson: unknown): RawEvent | null {
  return parsedJson && typeof parsedJson === 'object' ? (parsedJson as RawEvent) : null;
}

function stringField(raw: RawEvent, key: string): string | null {
  const value = raw[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function escrowIdField(parsedJson: unknown): string | null {
  const raw = asRecord(parsedJson);
  return raw ? stringField(raw, 'escrow_id') : null;
}

const CYCLE_ESCROW_TYPE = /::njangi_cycle_escrow::CycleEscrow<(.+)>$/;

/**
 * Parses a `getObject({ showType, showContent })` response for a
 * CycleEscrow<T>. Null when the response holds no such escrow (the RPC's
 * `notExists` error, another type, no circle id); the cron skips those
 * events. Transport failures never get here — the cron lets them throw.
 */
export function parseEscrowSubject(objectResponse: unknown): EscrowSubject | null {
  const data = asRecord(asRecord(objectResponse)?.data);
  const content = asRecord(data?.content);
  const typeTag = typeof data?.type === 'string' ? data.type : content?.type;
  const coinType =
    typeof typeTag === 'string' ? (typeTag.match(CYCLE_ESCROW_TYPE)?.[1] ?? null) : null;
  const fields = asRecord(content?.fields);
  const circleId = fields ? stringField(fields, 'circle_id') : null;
  if (!coinType || !circleId) return null;

  // Nested structs arrive as { type, fields }; u64s arrive as strings.
  const snapshot = asRecord(fields?.snapshot);
  const snapshotFields = asRecord(snapshot?.fields) ?? snapshot;
  return {
    circleId,
    coinType,
    requiredContributors: parseNumericField(snapshotFields?.required_contributors),
  };
}

function circleLink(ctx: CircleEventMessageContext, circleId: string, suffix = ''): string {
  return `${ctx.appBaseUrl.replace(/\/$/, '')}/circle/${circleId}${suffix}`;
}

function memberDisplay(ctx: CircleEventMessageContext, memberAddress: string): string {
  const short = shortAddress(memberAddress);
  return ctx.memberName ? `${ctx.memberName} (${short})` : short;
}

// ---------------------------------------------------------------------------
// Template payload helpers (legacy Meta template shapes)
//
// Circle-event notifications go to the circle's linked admin phone, for
// which no locale preference exists, so templates send the 'en' variant —
// exactly what the legacy bot's approved templates used. The "your turn"
// member nudge (your-turn-notification.ts) is the locale-aware one.
// ---------------------------------------------------------------------------

function textParams(values: string[]): Array<{ type: 'text'; text: string }> {
  return values.map((text) => ({ type: 'text' as const, text }));
}

/**
 * Legacy template component layout: one body component with positional
 * text parameters, plus (optionally) a dynamic-URL button whose suffix
 * deep-links into the app (the approved button URL is
 * `https://<app>/circle/{{1}}`).
 */
function legacyTemplate(
  name: string,
  bodyParams: string[],
  urlButtonParam?: string,
): WhatsAppTemplatePayload {
  return {
    name,
    // Must match the language the templates were approved under in WhatsApp
    // Manager: English (US). Meta fails a send in any other language (132001).
    language: 'en_US',
    components: [
      { type: 'body', parameters: textParams(bodyParams) },
      ...(urlButtonParam
        ? [
            {
              type: 'button' as const,
              sub_type: 'url' as const,
              index: '0',
              parameters: textParams([urlButtonParam]),
            },
          ]
        : []),
    ],
  };
}

/**
 * Send-time date label for the templates whose approved layout ends with a
 * date placeholder (deposit_returned, member_removed, order_changed,
 * payout_processed all carry one). Mirrors the legacy bot's
 * `new Date().toLocaleDateString('en-US', …)` calls. The value is "now" by
 * design, so it is the one intentionally non-deterministic input to an
 * otherwise pure module — every other parameter comes from the event or the
 * resolved context.
 */
function sendDateLabel(includeWeekday = false): string {
  return new Date().toLocaleDateString('en-US', {
    ...(includeWeekday ? { weekday: 'short' as const } : {}),
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export const CIRCLE_EVENT_STREAMS: CircleEventStream[] = [
  {
    name: 'circle_linked',
    source: 'whatsapp',
    eventType: (pkg) => `${pkg}::whatsapp_integration::CircleLinked`,
    parse(parsedJson) {
      const raw = asRecord(parsedJson);
      const circleId = raw && stringField(raw, 'circle_id');
      if (!circleId) return null;
      return {
        circleId,
        // Lists what src/content/whatsapp-updates.ts says a linked number
        // gets, like the help reply and the manage card, so it promises no
        // more than they do.
        buildBody: (ctx) => buildLinkConfirmation(ctx.circleName, circleLink(ctx, circleId)),
        // No buildTemplate: the approved `circle_link` body (WHATSAPP_TEMPLATES.md)
        // promises cycle deadlines and "important alerts", which nothing
        // sends. Send a template here again only once Meta approves a body
        // that names no updates of its own; the template doc proposes one.
      };
    },
  },
  {
    name: 'circle_unlinked',
    source: 'whatsapp',
    eventType: (pkg) => `${pkg}::whatsapp_integration::CircleUnlinked`,
    parse(parsedJson) {
      const raw = asRecord(parsedJson);
      const circleId = raw && stringField(raw, 'circle_id');
      if (!circleId) return null;
      return {
        circleId,
        includeDisabledLink: true,
        buildBody: (ctx) =>
          `Circle disconnected.\n` +
          `${ctx.circleName} is no longer linked to this WhatsApp number.\n` +
          `Reconnect here: ${circleLink(ctx, circleId, '/manage')}`,
        // Approved button URL is `https://<app>/circle/{{1}}`, so the suffix
        // `<circleId>/manage` deep-links to the manage page like the legacy bot.
        buildTemplate: (ctx) =>
          legacyTemplate('circle_unlink', [ctx.circleName], `${circleId}/manage`),
      };
    },
  },
  {
    name: 'member_joined',
    source: 'core',
    eventType: (pkg) => `${pkg}::njangi_circles::MemberJoined`,
    parse(parsedJson) {
      const raw = asRecord(parsedJson);
      const circleId = raw && stringField(raw, 'circle_id');
      const member = raw && stringField(raw, 'member');
      if (!circleId || !member) return null;
      return {
        circleId,
        memberAddress: member,
        buildBody: (ctx) =>
          `New member in ${ctx.circleName}.\n` +
          `${memberDisplay(ctx, member)} just joined the circle.\n` +
          `View members: ${circleLink(ctx, circleId)}`,
        // member_joins body params: {{1}} circle, {{2}} member name,
        // {{3}} short address; URL button suffix is the circle id.
        buildTemplate: (ctx) =>
          legacyTemplate(
            'member_joins',
            [ctx.circleName, ctx.memberName || 'New Member', shortAddress(member)],
            circleId,
          ),
      };
    },
  },
  {
    name: 'security_deposit',
    source: 'core',
    eventType: (pkg) => `${pkg}::njangi_custody::CustodyDeposited`,
    parse(parsedJson) {
      const raw = asRecord(parsedJson);
      if (!raw) return null;
      // operation_type 3 = security deposit. Type 1 (cycle contributions)
      // belongs to the retired legacy rail — contributions now land in the
      // per-round escrow (contribution_recorded stream); other operations
      // are internal transfers.
      if (parseNumericField(raw.operation_type) !== 3) return null;
      const circleId = stringField(raw, 'circle_id');
      const member = stringField(raw, 'member') ?? stringField(raw, 'depositor');
      if (!circleId || !member) return null;
      const amountRaw = raw.amount;
      return {
        circleId,
        memberAddress: member,
        // No buildTemplate: the legacy `deposit_received` template body needs
        // a running deposit count and member total ({{5}}/{{6}}) that the
        // serverless cron does not compute. Keep the freeform fallback until a
        // leaner template without those aggregates is approved (see the module
        // doc block and whatsapp-notifier.ts — deposit_received is absent from
        // its curated reuse list for exactly this reason).
        buildBody: (ctx) => {
          // CustodyDeposited carries no coin type; the cron resolves it
          // from the CoinDeposited event in the same transaction. Without
          // a resolution, omit the figure rather than misreport units.
          const amount = formatTokenAmount(
            amountRaw,
            ctx.resolvedCoinType ?? undefined,
          );
          const amountClause = ctx.resolvedCoinType && amount
            ? ` of ${amount}`
            : '';
          return (
            `Security deposit received for ${ctx.circleName}.\n` +
            `${memberDisplay(ctx, member)} paid their security deposit${amountClause}.\n` +
            `View circle: ${circleLink(ctx, circleId)}`
          );
        },
      };
    },
  },
  {
    name: 'deposit_returned',
    source: 'core',
    eventType: (pkg) => `${pkg}::njangi_circles::SecurityDepositReturned`,
    parse(parsedJson) {
      const raw = asRecord(parsedJson);
      const circleId = raw && stringField(raw, 'circle_id');
      const member = raw && stringField(raw, 'member');
      if (!circleId || !member) return null;
      const amount = formatTokenAmount(raw.amount, stringField(raw, 'coin_type'));
      return {
        circleId,
        memberAddress: member,
        buildBody: (ctx) =>
          `Security deposit returned in ${ctx.circleName}.\n` +
          `${memberDisplay(ctx, member)} received ${amount ?? 'their deposit'} back.\n` +
          `View circle: ${circleLink(ctx, circleId)}`,
        // deposit_returned body params: {{1}} circle, {{2}} amount,
        // {{3}} date. Only send the template when the amount parsed — an
        // approved positional layout cannot carry an empty {{2}}.
        buildTemplate: (ctx) =>
          amount
            ? legacyTemplate('deposit_returned', [ctx.circleName, amount, sendDateLabel()], circleId)
            : null,
      };
    },
  },
  {
    // A member paid into a round's escrow (njangi_cycle_escrow::contribute*).
    // Replaces the legacy rail's `contribution` / `contribution_stablecoin`
    // streams; the new name gives it a fresh cursor key, so a cursor paged
    // over another event type is never reused.
    name: 'contribution_recorded',
    source: 'core',
    eventType: (pkg) => `${pkg}::njangi_cycle_escrow::ContributionRecorded`,
    escrowIdOf: escrowIdField,
    parse(parsedJson, escrow) {
      const raw = asRecord(parsedJson);
      const contributor = raw && stringField(raw, 'contributor');
      if (!raw || !contributor || !escrow) return null;
      const { circleId } = escrow;
      const amount = formatEscrowAmount(raw.amount, escrow.coinType);
      const round = parseNumericField(raw.cycle_no);
      // Count as of this contribution (the escrow's live count drops again
      // if the round is refunded); the target is frozen in the snapshot.
      const paid = parseNumericField(raw.contributors_so_far);
      const required = escrow.requiredContributors;
      return {
        circleId,
        memberAddress: contributor,
        // No buildTemplate: the legacy `recieve_contribution` template is not
        // on whatsapp-notifier.ts's approved reuse list. The escrow read now
        // supplies its paid/total/remaining placeholders ({{5}}–{{7}}), so it
        // can be wired once its approval and {{8}} beneficiary are confirmed.
        buildBody: (ctx) =>
          `Contribution received in ${ctx.circleName}.\n` +
          `${round !== null ? `Round ${round}: ` : ''}` +
          `${memberDisplay(ctx, contributor)} paid ${amount ?? 'their share'}.` +
          (paid !== null && required !== null
            ? ` ${paid} of ${required} members have paid in for this round.`
            : '') +
          `\nView progress: ${circleLink(ctx, circleId)}`,
      };
    },
  },
  {
    name: 'member_removed',
    source: 'core',
    eventType: (pkg) => `${pkg}::njangi_circles::MemberRemoved`,
    parse(parsedJson) {
      const raw = asRecord(parsedJson);
      const circleId = raw && stringField(raw, 'circle_id');
      const member = raw && stringField(raw, 'member');
      if (!circleId || !member) return null;
      const depositReturned = raw.deposit_returned === true;
      return {
        circleId,
        memberAddress: member,
        buildBody: (ctx) =>
          `Member removed from ${ctx.circleName}.\n` +
          `${memberDisplay(ctx, member)} is no longer part of the circle.` +
          (depositReturned ? ` Their security deposit was returned.` : '') +
          `\nView members: ${circleLink(ctx, circleId)}`,
        // member_removed body params: {{1}} member name, {{2}} short address,
        // {{3}} circle, {{4}} date; URL button suffix is the circle id.
        buildTemplate: (ctx) =>
          legacyTemplate(
            'member_removed',
            [ctx.memberName || 'Member', shortAddress(member), ctx.circleName, sendDateLabel()],
            circleId,
          ),
      };
    },
  },
  {
    name: 'rotation_changed',
    source: 'core',
    eventType: (pkg) => `${pkg}::njangi_circles::RotationOrderChanged`,
    parse(parsedJson) {
      const raw = asRecord(parsedJson);
      const circleId = raw && stringField(raw, 'circle_id');
      if (!circleId) return null;
      const memberCount = parseNumericField(raw?.member_count);
      return {
        circleId,
        buildBody: (ctx) =>
          `Payout order updated in ${ctx.circleName}.` +
          (memberCount ? ` ${memberCount} members are in the new rotation.` : '') +
          `\nReview the order: ${circleLink(ctx, circleId)}`,
        // order_changed body params: {{1}} circle, {{2}} member count,
        // {{3}} date. The count rides on the event; without it an approved
        // positional layout cannot carry an empty {{2}}, so fall back to text.
        buildTemplate: (ctx) =>
          memberCount !== null
            ? legacyTemplate(
                'order_changed',
                [ctx.circleName, String(memberCount), sendDateLabel()],
                circleId,
              )
            : null,
      };
    },
  },
  {
    name: 'circle_activated',
    source: 'core',
    eventType: (pkg) => `${pkg}::njangi_circles::CircleActivated`,
    parse(parsedJson) {
      const raw = asRecord(parsedJson);
      const circleId = raw && stringField(raw, 'circle_id');
      if (!circleId) return null;
      return {
        circleId,
        // No buildTemplate: the legacy `live_circle` template body needs the
        // member count, per-cycle contribution amount and first payout date
        // ({{2}}–{{4}}) — none of which the serverless cron computes. Keep the
        // freeform fallback until a leaner template is approved (live_circle is
        // intentionally absent from whatsapp-notifier.ts's reuse list).
        buildBody: (ctx) =>
          `${ctx.circleName} is now live!\n` +
          `The rotation has started and contributions for the first cycle are open.\n` +
          `Open circle: ${circleLink(ctx, circleId)}`,
      };
    },
  },
  {
    // The recipient collected a round's payout (njangi_cycle_escrow::
    // redeem_claim, also reached through finalize_and_redeem). Replaces the
    // legacy rail's `payout_processed` stream. The rail is recipient-pull,
    // so this fires on collection; CycleFinalized, which drives the separate
    // "your turn" nudge (/api/cron/cycle-finalized), is not relayed here.
    name: 'claim_redeemed',
    source: 'core',
    eventType: (pkg) => `${pkg}::njangi_cycle_escrow::ClaimRedeemed`,
    escrowIdOf: escrowIdField,
    parse(parsedJson, escrow) {
      const raw = asRecord(parsedJson);
      const recipient = raw && stringField(raw, 'recipient');
      if (!raw || !recipient || !escrow) return null;
      const { circleId } = escrow;
      const amount = formatEscrowAmount(raw.amount, escrow.coinType);
      const round = parseNumericField(raw.cycle_no);
      return {
        circleId,
        memberAddress: recipient,
        buildBody: (ctx) =>
          `Payout collected in ${ctx.circleName}.\n` +
          `${round !== null ? `Round ${round}: ` : ''}` +
          `${memberDisplay(ctx, recipient)} received ${amount ?? 'their payout'}.\n` +
          `View circle: ${circleLink(ctx, circleId)}`,
        // payout_processed body params: {{1}} circle, {{2}} cycle number,
        // {{3}} recipient, {{4}} amount, {{5}} date (same approved template
        // buildYourTurnTemplate reuses). Send only when amount + cycle parsed.
        buildTemplate: (ctx) =>
          amount && round !== null
            ? legacyTemplate(
                'payout_processed',
                [
                  ctx.circleName,
                  String(round),
                  ctx.memberName || shortAddress(recipient),
                  amount,
                  sendDateLabel(true),
                ],
                circleId,
              )
            : null,
      };
    },
  },
];

/** Stable per-event dedupe key for the whatsapp_notifications claim row. */
export function circleEventDedupeKey(
  streamName: string,
  txDigest: string,
  eventSeq: string,
): string {
  return `${streamName}:${txDigest}:${eventSeq}`;
}

/** Cursor row key in cycle_finalized_cursor (shared cursor/lease table). */
export function circleEventCursorKey(
  streamName: string,
  definingPackageId: string,
  network: string,
): string {
  return `whatsapp-events:${streamName}:${definingPackageId}:${network}`;
}

/** The link a CircleUnlinked event disabled: its circle and its anchor nonce. */
export interface UnlinkedLinkRef {
  circleId: string;
  /** Lowercase hex of the 32-byte `link_nonce` the link was anchored with. */
  linkNonceHex: string;
}

/**
 * Reads the circle and link nonce out of a CircleUnlinked event, or null
 * when either is missing. The nonce names the link's data key row
 * (src/lib/whatsapp-pii-keys.ts), which the cron deletes once the unlink
 * confirmation is settled. JSON-RPC renders a `vector<u8>` as an array of
 * byte values; a hex or base64 string is accepted too.
 */
export function parseUnlinkedLinkRef(parsedJson: unknown): UnlinkedLinkRef | null {
  const raw = asRecord(parsedJson);
  const circleId = raw && stringField(raw, 'circle_id');
  if (!raw || !circleId) return null;
  const nonce = raw.link_nonce;
  let bytes: Buffer | null = null;
  if (Array.isArray(nonce)) {
    const valid = nonce.every((b) => Number.isInteger(b) && b >= 0 && b <= 255);
    bytes = valid ? Buffer.from(nonce as number[]) : null;
  } else if (typeof nonce === 'string') {
    const hex = nonce.replace(/^0x/, '');
    bytes = /^(?:[0-9a-fA-F]{2})+$/.test(hex) ? Buffer.from(hex, 'hex') : Buffer.from(nonce, 'base64');
  }
  if (!bytes || bytes.length === 0) return null;
  return { circleId, linkNonceHex: bytes.toString('hex') };
}
