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
// Template: `payout_ready` (Utility, English `en`, approved in WhatsApp
// Manager 2026-10-03). Its body is the English copy below with {{1}} the
// circle's short id, {{2}} the round and {{3}} the payout, plus a dynamic
// URL button `https://njangionchain.com/circle/{{1}}` whose suffix we set
// to `<circleId>/contribute` (Meta only allows the variable at the end of
// the URL). It is attached only when the payout figure is known ({{3}} is
// required) and the recipient's locale is English (the template is
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
  cycleNo: number;
  /** Null when the payout cannot be stated exactly; the line omits it. */
  amount: string | null;
}

const TEMPLATE_BY_LOCALE: Record<SupportedLocale, (vars: YourTurnMessageVars) => string> = {
  en: ({ circleShort, cycleNo, amount }) =>
    `🎉 *It's your turn!*\n\n` +
    `The pot for circle ${circleShort}… is full for round ${cycleNo}.\n` +
    (amount
      ? `Your payout of ${amount} is ready to collect.`
      : `Your payout is ready to collect.`) +
    `\n\n` +
    `Open the Njangi app and tap "Collect my payout".`,
  fr: ({ circleShort, cycleNo, amount }) =>
    `🎉 *C'est votre tour !*\n\n` +
    `La cagnotte du cercle ${circleShort}… est complète pour le tour ${cycleNo}.\n` +
    (amount
      ? `Votre versement de ${amount} est prêt à être récupéré.`
      : `Votre versement est prêt à être récupéré.`) +
    `\n\n` +
    `Ouvrez l'application Njangi et appuyez sur "Récupérer mon versement".`,
  pcm: ({ circleShort, cycleNo, amount }) =>
    `🎉 *Na your turn!*\n\n` +
    `Di pot for circle ${circleShort}… don full for round ${cycleNo}.\n` +
    (amount ? `Your payout of ${amount} don ready.` : `Your payout don ready.`) +
    `\n\n` +
    `Open di Njangi app and tap "Collect my payout".`,
  sw: ({ circleShort, cycleNo, amount }) =>
    `🎉 *Ni zamu yako!*\n\n` +
    `Kibanda cha duara ${circleShort}… kimejaa kwa raundi ${cycleNo}.\n` +
    (amount ? `Malipo yako ya ${amount} yako tayari.` : `Malipo yako yako tayari.`) +
    `\n\n` +
    `Fungua programu ya Njangi na bonyeza "Chukua malipo yangu".`,
  am: ({ circleShort, cycleNo, amount }) =>
    `🎉 *የእርስዎ ተራ ነው!*\n\n` +
    `የክበቡ ${circleShort}… ገንዘብ ለዙር ${cycleNo} ሞልቷል።\n` +
    (amount ? `${amount} የእርስዎ ክፍያ ተዘጋጅቷል።` : `የእርስዎ ክፍያ ተዘጋጅቷል።`) +
    `\n\n` +
    `Njangi መተግበሪያን ይክፈቱ እና "ክፍያዬን ውሰድ" ይጫኑ።`,
  ar: ({ circleShort, cycleNo, amount }) =>
    `🎉 *إنه دورك!*\n\n` +
    `صندوق الدائرة ${circleShort}… ممتلئ للجولة ${cycleNo}.\n` +
    (amount ? `مستحقاتك البالغة ${amount} جاهزة.` : `مستحقاتك جاهزة.`) +
    `\n\n` +
    `افتح تطبيق Njangi واضغط على "استلم مستحقاتي".`,
  fa: ({ circleShort, cycleNo, amount }) =>
    `🎉 *نوبت شماست!*\n\n` +
    `صندوق حلقه ${circleShort}… برای دور ${cycleNo} پر شد.\n` +
    (amount ? `مبلغ ${amount} شما آماده است.` : `مبلغ شما آماده است.`) +
    `\n\n` +
    `برنامه Njangi را باز کنید و روی "مبلغ خود را دریافت کن" بزنید.`,
};

export function buildYourTurnMessage(
  locale: SupportedLocale,
  circleId: string,
  cycleNo: number,
  amount: string | null,
): string {
  const fn = TEMPLATE_BY_LOCALE[locale] ?? TEMPLATE_BY_LOCALE.en;
  return fn({ circleShort: circleId.slice(0, 8), cycleNo, amount });
}

/**
 * The approved `payout_ready` template for a known payout (see the header).
 * The {{1}} short id matches the freeform body's "circle 0xa3fada…".
 */
export function buildYourTurnTemplate(
  circleId: string,
  cycleNo: number,
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
          { type: 'text', text: String(cycleNo) },
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
  cycleNo: number;
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
  return sendMemberNotification({
    memberAddress: input.recipient,
    phoneOverride: input.recipientPhone,
    body: buildYourTurnMessage(locale, input.circleId, input.cycleNo, input.amount),
    // `payout_ready` only for a known payout in English; see the header.
    // The dispatcher ignores it unless WHATSAPP_TEMPLATES_ENABLED=true.
    template:
      input.amount && locale === 'en'
        ? buildYourTurnTemplate(input.circleId, input.cycleNo, input.amount)
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
