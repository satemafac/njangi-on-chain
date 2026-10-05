// your-turn-notification.ts — Core "it's your turn to collect" WhatsApp
// notification used by both:
//
//   * POST /api/whatsapp/notify/your-turn  (external indexers / smoke test)
//   * GET  /api/cron/cycle-finalized       (Vercel cron, in-process)
//
// Extracted from the your-turn API route during the Vercel serverless
// migration (June 2026) so the cron can call the notify logic in-process
// instead of POSTing to itself over HTTP. Routing, audit logging, and
// dedupe all stay inside `sendMemberNotification`.
//
// The copy says the round's pot is full and the payout is ready to
// collect, so it is only true between the contribution that fills the pot
// and the recipient's collection. The cron sends it in that window (it
// reads the escrow first and skips a claimed or refunded one).
//
// The round is the circle-wide round number (round-number.ts), never the
// escrow's cycle_no: that counts laps, so every round of a lap used to say
// the same number. It stays the dedupe key's cycle part, which only has to
// be stable. Without a round number the message says the pot is full
// without one.
//
// Template: `payout_ready` (Utility, English `en`, approved in WhatsApp
// Manager 2026-10-03). Its body is the English copy below with {{1}} the
// circle's short id, {{2}} the round and {{3}} the payout, plus a dynamic
// URL button `https://njangionchain.com/circle/{{1}}` whose suffix we set
// to `<circleId>/contribute` (Meta only allows the variable at the end of
// the URL). It is attached only when the round and the payout figure are
// both known ({{2}} and {{3}} are required) and the recipient's locale is
// English (the template is
// English-only; other locales keep their localized freeform body until
// localized templates are approved). The dispatcher sends a template only
// when WHATSAPP_TEMPLATES_ENABLED=true; otherwise the freeform body goes
// out, which Meta delivers inside an open 24h service window. The nudge no
// longer reuses `payout_processed`, whose copy says the payout was sent.

import { sendMemberNotification } from './whatsapp-notifier';
import type { SendMemberNotificationResult, WhatsAppTemplatePayload } from './whatsapp-notifier';
import type { NetworkType } from '../services/whatsapp-registry-service';

export type SupportedLocale = 'en' | 'fr' | 'pcm' | 'sw' | 'am' | 'ar' | 'fa';

interface YourTurnMessageVars {
  circleShort: string;
  /** Circle-wide round number; null leaves the round out of the line. */
  round: number | null;
  /** Null when the payout cannot be stated exactly; the line omits it. */
  amount: string | null;
}

const TEMPLATE_BY_LOCALE: Record<SupportedLocale, (vars: YourTurnMessageVars) => string> = {
  en: ({ circleShort, round, amount }) =>
    `🎉 *It's your turn!*\n\n` +
    (round !== null
      ? `The pot for circle ${circleShort}… is full for round ${round}.\n`
      : `The pot for circle ${circleShort}… is full.\n`) +
    (amount
      ? `Your payout of ${amount} is ready to collect.`
      : `Your payout is ready to collect.`) +
    `\n\n` +
    `Open the Njangi app and tap "Collect my payout".`,
  fr: ({ circleShort, round, amount }) =>
    `🎉 *C'est votre tour !*\n\n` +
    (round !== null
      ? `La cagnotte du cercle ${circleShort}… est complète pour le tour ${round}.\n`
      : `La cagnotte du cercle ${circleShort}… est complète.\n`) +
    (amount
      ? `Votre versement de ${amount} est prêt à être récupéré.`
      : `Votre versement est prêt à être récupéré.`) +
    `\n\n` +
    `Ouvrez l'application Njangi et appuyez sur "Récupérer mon versement".`,
  pcm: ({ circleShort, round, amount }) =>
    `🎉 *Na your turn!*\n\n` +
    (round !== null
      ? `Di pot for circle ${circleShort}… don full for round ${round}.\n`
      : `Di pot for circle ${circleShort}… don full.\n`) +
    (amount ? `Your payout of ${amount} don ready.` : `Your payout don ready.`) +
    `\n\n` +
    `Open di Njangi app and tap "Collect my payout".`,
  sw: ({ circleShort, round, amount }) =>
    `🎉 *Ni zamu yako!*\n\n` +
    (round !== null
      ? `Kibanda cha duara ${circleShort}… kimejaa kwa raundi ${round}.\n`
      : `Kibanda cha duara ${circleShort}… kimejaa.\n`) +
    (amount ? `Malipo yako ya ${amount} yako tayari.` : `Malipo yako yako tayari.`) +
    `\n\n` +
    `Fungua programu ya Njangi na bonyeza "Chukua malipo yangu".`,
  am: ({ circleShort, round, amount }) =>
    `🎉 *የእርስዎ ተራ ነው!*\n\n` +
    (round !== null
      ? `የክበቡ ${circleShort}… ገንዘብ ለዙር ${round} ሞልቷል።\n`
      : `የክበቡ ${circleShort}… ገንዘብ ሞልቷል።\n`) +
    (amount ? `${amount} የእርስዎ ክፍያ ተዘጋጅቷል።` : `የእርስዎ ክፍያ ተዘጋጅቷል።`) +
    `\n\n` +
    `Njangi መተግበሪያን ይክፈቱ እና "ክፍያዬን ውሰድ" ይጫኑ።`,
  ar: ({ circleShort, round, amount }) =>
    `🎉 *إنه دورك!*\n\n` +
    (round !== null
      ? `صندوق الدائرة ${circleShort}… ممتلئ للجولة ${round}.\n`
      : `صندوق الدائرة ${circleShort}… ممتلئ.\n`) +
    (amount ? `مستحقاتك البالغة ${amount} جاهزة.` : `مستحقاتك جاهزة.`) +
    `\n\n` +
    `افتح تطبيق Njangi واضغط على "استلم مستحقاتي".`,
  fa: ({ circleShort, round, amount }) =>
    `🎉 *نوبت شماست!*\n\n` +
    (round !== null
      ? `صندوق حلقه ${circleShort}… برای دور ${round} پر شد.\n`
      : `صندوق حلقه ${circleShort}… پر شد.\n`) +
    (amount ? `مبلغ ${amount} شما آماده است.` : `مبلغ شما آماده است.`) +
    `\n\n` +
    `برنامه Njangi را باز کنید و روی "مبلغ خود را دریافت کن" بزنید.`,
};

export function buildYourTurnMessage(
  locale: SupportedLocale,
  circleId: string,
  round: number | null,
  amount: string | null,
): string {
  const fn = TEMPLATE_BY_LOCALE[locale] ?? TEMPLATE_BY_LOCALE.en;
  return fn({ circleShort: circleId.slice(0, 8), round, amount });
}

/**
 * The approved `payout_ready` template for a known payout (see the header).
 * The {{1}} short id matches the freeform body's "circle 0xa3fada…".
 */
export function buildYourTurnTemplate(
  circleId: string,
  round: number,
  amount: string,
): WhatsAppTemplatePayload {
  return {
    name: 'payout_ready',
    // The language the template was approved under (English, `en`).
    language: 'en',
    components: [
      {
        type: 'body',
        parameters: [
          { type: 'text', text: `${circleId.slice(0, 8)}…` },
          { type: 'text', text: String(round) },
          { type: 'text', text: amount },
        ],
      },
      {
        type: 'button',
        sub_type: 'url',
        index: '0',
        parameters: [{ type: 'text', text: `${circleId}/contribute` }],
      },
    ],
  };
}

export interface YourTurnNotificationInput {
  circleId: string;
  /** The escrow's cycle_no (a lap). Only the default dedupe key uses it. */
  cycleNo: number;
  /**
   * The circle-wide round number shown to the member (round-number.ts).
   * Null or absent when it could not be worked out: the message then omits
   * the round, and the `payout_ready` template (whose {{2}} is the round)
   * is not attached.
   */
  roundNo?: number | null;
  /**
   * Human-readable payout, e.g. "350 USDC". Null when it cannot be stated
   * exactly (the cron passes null for a coin whose decimals it does not
   * know); the message then says the payout is ready without a figure.
   */
  amount: string | null;
  /**
   * Sui address of the payout recipient. Required — the June 2026
   * ops-readiness audit found the old worker omitted it, making the
   * endpoint fall back to looking up a WhatsApp link for the *circle id*,
   * which can never match a member link, so every nudge silently no-oped.
   */
  recipient: string;
  /** Optional pre-resolved E.164 phone, skipping the on-chain lookup. */
  recipientPhone?: string;
  /**
   * Overrides the `${circleId}:${cycleNo}` dedupe key. The cron passes an
   * escrow-id-based key: every event names its escrow, and the key has to
   * stay identical across retries and deploys or a round can be nudged
   * twice.
   */
  dedupeKey?: string;
  locale?: SupportedLocale;
  network: NetworkType;
}

/**
 * Sends the localized "your turn" nudge to the round's payout recipient.
 * Idempotent per `(recipient, circleId:cycleNo)` inside a 24-hour window:
 * the dispatcher atomically CLAIMS the dedupe row in
 * `whatsapp_notifications` before sending (single upsert with a
 * conditional WHERE — see `claimNotificationSlot`), so a cron re-run, a
 * webhook retry storm, or an overlapping invocation resolves to exactly
 * one send; every loser returns `{ sent: false, reason: 'duplicate' }`.
 * The cron route additionally holds a Postgres run lease so overlapping
 * drains skip entirely instead of racing event-by-event.
 */
export async function sendYourTurnNotification(
  input: YourTurnNotificationInput,
): Promise<SendMemberNotificationResult> {
  const locale = input.locale ?? 'en';
  const round = input.roundNo ?? null;
  return sendMemberNotification({
    memberAddress: input.recipient,
    phoneOverride: input.recipientPhone,
    body: buildYourTurnMessage(locale, input.circleId, round, input.amount),
    // `payout_ready` only for a known round and payout in English; see the
    // header. The dispatcher ignores it unless WHATSAPP_TEMPLATES_ENABLED=true.
    template:
      input.amount && round !== null && locale === 'en'
        ? buildYourTurnTemplate(input.circleId, round, input.amount)
        : undefined,
    kind: 'cycle_finalized',
    network: input.network,
    // Round-scoped dedupe — a duplicate webhook or a notifier restart
    // won't double-send the same "your turn" message inside the
    // 24-hour window.
    dedupeKey: input.dedupeKey ?? `${input.circleId}:${input.cycleNo}`,
    dedupeWindowMs: 24 * 60 * 60 * 1000,
  });
}
