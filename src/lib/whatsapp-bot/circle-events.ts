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

import type { WhatsAppTemplatePayload } from '../whatsapp-notifier';

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
   * template names — circle_link, member_joins, payout_processed, …).
   * Returns null when the cron context cannot faithfully fill the
   * approved placeholder layout; the dispatcher then falls back to
   * `buildBody` text even when WHATSAPP_TEMPLATES_ENABLED=true.
   */
  buildTemplate?(ctx: CircleEventMessageContext): WhatsAppTemplatePayload | null;
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
  /** Returns null for malformed or filtered payloads (advance, no send). */
  parse(parsedJson: unknown): ParsedCircleEvent | null;
}

type RawEvent = Record<string, unknown>;

function asRecord(parsedJson: unknown): RawEvent | null {
  return parsedJson && typeof parsedJson === 'object' ? (parsedJson as RawEvent) : null;
}

function stringField(raw: RawEvent, key: string): string | null {
  const value = raw[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
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

function templateDate(): string {
  // Mirrors the legacy bot's payout/deposit date formatting.
  return new Date().toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

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
    language: 'en',
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
        buildBody: (ctx) =>
          `Circle connected.\n` +
          `${ctx.circleName} is now linked to this WhatsApp number. ` +
          `You will receive contribution, payout and membership updates here.\n` +
          `Open circle: ${circleLink(ctx, circleId)}`,
        buildTemplate: (ctx) => legacyTemplate('circle_link', [ctx.circleName], circleId),
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
      // is covered by the ContributionMade/StablecoinContributionMade
      // streams; other operations are internal transfers.
      if (parseNumericField(raw.operation_type) !== 3) return null;
      const circleId = stringField(raw, 'circle_id');
      const member = stringField(raw, 'member') ?? stringField(raw, 'depositor');
      if (!circleId || !member) return null;
      const amountRaw = raw.amount;
      return {
        circleId,
        memberAddress: member,
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
      };
    },
  },
  {
    name: 'contribution',
    source: 'core',
    eventType: (pkg) => `${pkg}::njangi_payments::ContributionMade`,
    parse: (parsedJson) => parseContribution(parsedJson, /* hasCoinType */ false),
  },
  {
    name: 'contribution_stablecoin',
    source: 'core',
    eventType: (pkg) => `${pkg}::njangi_circles::StablecoinContributionMade`,
    parse: (parsedJson) => parseContribution(parsedJson, /* hasCoinType */ true),
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
        buildBody: (ctx) =>
          `${ctx.circleName} is now live!\n` +
          `The rotation has started and contributions for the first cycle are open.\n` +
          `Open circle: ${circleLink(ctx, circleId)}`,
      };
    },
  },
  {
    name: 'payout_processed',
    source: 'core',
    eventType: (pkg) => `${pkg}::njangi_payments::PayoutProcessed`,
    parse(parsedJson) {
      const raw = asRecord(parsedJson);
      const circleId = raw && stringField(raw, 'circle_id');
      const recipient = raw && stringField(raw, 'recipient');
      if (!circleId || !recipient) return null;
      // Legacy payout path settles in SUI (no coin_type on the event).
      const amount = formatTokenAmount(raw.amount, null);
      const cycle = parseNumericField(raw.cycle);
      return {
        circleId,
        memberAddress: recipient,
        buildBody: (ctx) =>
          `Payout sent in ${ctx.circleName}.\n` +
          `${cycle !== null ? `Cycle ${cycle}: ` : ''}` +
          `${memberDisplay(ctx, recipient)} received ${amount ?? 'their payout'}.\n` +
          `View circle: ${circleLink(ctx, circleId)}`,
      };
    },
  },
];

function parseContribution(
  parsedJson: unknown,
  hasCoinType: boolean,
): ParsedCircleEvent | null {
  const raw = asRecord(parsedJson);
  const circleId = raw && stringField(raw, 'circle_id');
  const member = raw && stringField(raw, 'member');
  if (!raw || !circleId || !member) return null;
  const amount = formatTokenAmount(
    raw.amount,
    hasCoinType ? stringField(raw, 'coin_type') : null,
  );
  if (!amount) return null;
  const cycle = parseNumericField(raw.cycle);
  return {
    circleId,
    memberAddress: member,
    buildBody: (ctx) =>
      `Contribution received in ${ctx.circleName}.\n` +
      `${cycle !== null ? `Cycle ${cycle}: ` : ''}` +
      `${memberDisplay(ctx, member)} paid ${amount}.\n` +
      `View progress: ${circleLink(ctx, circleId)}`,
  };
}

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
