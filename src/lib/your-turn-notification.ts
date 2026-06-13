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

import { sendMemberNotification } from './whatsapp-notifier';
import type {
  SendMemberNotificationResult,
  WhatsAppTemplatePayload,
} from './whatsapp-notifier';
import type { NetworkType } from '../services/whatsapp-registry-service';

export type SupportedLocale = 'en' | 'fr' | 'pcm' | 'sw' | 'am' | 'ar' | 'fa';

const TEMPLATE_BY_LOCALE: Record<
  SupportedLocale,
  (vars: { circleShort: string; cycleNo: number; amount: string }) => string
> = {
  en: ({ circleShort, cycleNo, amount }) =>
    `🎉 *It's your turn!*\n\n` +
    `The pot for circle ${circleShort}… is full for round ${cycleNo}.\n` +
    `Your payout of ${amount} is ready to collect.\n\n` +
    `Open the Njangi app and tap "Collect my payout".`,
  fr: ({ circleShort, cycleNo, amount }) =>
    `🎉 *C'est votre tour !*\n\n` +
    `La cagnotte du cercle ${circleShort}… est complète pour le tour ${cycleNo}.\n` +
    `Votre versement de ${amount} est prêt à être récupéré.\n\n` +
    `Ouvrez l'application Njangi et appuyez sur "Récupérer mon versement".`,
  pcm: ({ circleShort, cycleNo, amount }) =>
    `🎉 *Na your turn!*\n\n` +
    `Di pot for circle ${circleShort}… don full for round ${cycleNo}.\n` +
    `Your payout of ${amount} don ready.\n\n` +
    `Open di Njangi app and tap "Collect my payout".`,
  sw: ({ circleShort, cycleNo, amount }) =>
    `🎉 *Ni zamu yako!*\n\n` +
    `Kibanda cha duara ${circleShort}… kimejaa kwa raundi ${cycleNo}.\n` +
    `Malipo yako ya ${amount} yako tayari.\n\n` +
    `Fungua programu ya Njangi na bonyeza "Chukua malipo yangu".`,
  am: ({ circleShort, cycleNo, amount }) =>
    `🎉 *የእርስዎ ተራ ነው!*\n\n` +
    `የክበቡ ${circleShort}… ገንዘብ ለዙር ${cycleNo} ሞልቷል።\n` +
    `${amount} የእርስዎ ክፍያ ተዘጋጅቷል።\n\n` +
    `Njangi መተግበሪያን ይክፈቱ እና "ክፍያዬን ውሰድ" ይጫኑ።`,
  ar: ({ circleShort, cycleNo, amount }) =>
    `🎉 *إنه دورك!*\n\n` +
    `صندوق الدائرة ${circleShort}… ممتلئ للجولة ${cycleNo}.\n` +
    `مستحقاتك البالغة ${amount} جاهزة.\n\n` +
    `افتح تطبيق Njangi واضغط على "استلم مستحقاتي".`,
  fa: ({ circleShort, cycleNo, amount }) =>
    `🎉 *نوبت شماست!*\n\n` +
    `صندوق حلقه ${circleShort}… برای دور ${cycleNo} پر شد.\n` +
    `مبلغ ${amount} شما آماده است.\n\n` +
    `برنامه Njangi را باز کنید و روی "مبلغ خود را دریافت کن" بزنید.`,
};

export function buildYourTurnMessage(
  locale: SupportedLocale,
  circleId: string,
  cycleNo: number,
  amount: string,
): string {
  const fn = TEMPLATE_BY_LOCALE[locale] ?? TEMPLATE_BY_LOCALE.en;
  return fn({ circleShort: circleId.slice(0, 8), cycleNo, amount });
}

/**
 * Meta template language per app locale. Only languages with an APPROVED
 * variant of `payout_processed` in Meta Business Manager may appear here —
 * Meta does not fall back across languages (error 132001 for a missing
 * variant). 'en' + 'fr' cover the Cameroon/CEMAC launch; the remaining app
 * locales send the 'en' variant until their translations are approved.
 */
const META_TEMPLATE_LANGUAGE_BY_LOCALE: Partial<Record<SupportedLocale, string>> = {
  en: 'en',
  fr: 'fr',
};

/**
 * Business-initiated template payload for the "your turn" nudge, used when
 * WHATSAPP_TEMPLATES_ENABLED=true (Meta rejects the freeform fallback
 * outside the 24h service window — see the approval workflow block in
 * whatsapp-notifier.ts). Reuses the legacy bot's approved
 * `payout_processed` template; its body placeholders are
 * {{1}} circle, {{2}} cycle, {{3}} recipient, {{4}} amount, {{5}} date,
 * plus a dynamic-URL button whose suffix is the circle id.
 */
export function buildYourTurnTemplate(
  locale: SupportedLocale,
  circleId: string,
  cycleNo: number,
  amount: string,
  recipient: string,
): WhatsAppTemplatePayload {
  const language = META_TEMPLATE_LANGUAGE_BY_LOCALE[locale] ?? 'en';
  const shortRecipient =
    recipient.length > 10 ? `${recipient.slice(0, 6)}...${recipient.slice(-4)}` : recipient;
  const payoutDate = new Date().toLocaleDateString(language === 'fr' ? 'fr-FR' : 'en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  return {
    name: 'payout_processed',
    language,
    components: [
      {
        type: 'body',
        parameters: [
          { type: 'text', text: `${circleId.slice(0, 8)}…` },
          { type: 'text', text: String(cycleNo) },
          { type: 'text', text: shortRecipient },
          { type: 'text', text: amount },
          { type: 'text', text: payoutDate },
        ],
      },
      {
        type: 'button',
        sub_type: 'url',
        index: '0',
        parameters: [{ type: 'text', text: circleId }],
      },
    ],
  };
}

export interface YourTurnNotificationInput {
  circleId: string;
  cycleNo: number;
  /** Human-readable amount, e.g. "350 USDC". */
  amount: string;
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
   * escrow-id-based key because its circleId can fall back to the escrow
   * id on a failed read — a key that flaps between identities across
   * retries can dedupe-miss and double-send.
   */
  dedupeKey?: string;
  locale?: SupportedLocale;
  network: NetworkType;
}

/**
 * Sends the localized "your turn" nudge to the cycle's payout recipient.
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
  return sendMemberNotification({
    memberAddress: input.recipient,
    phoneOverride: input.recipientPhone,
    body: buildYourTurnMessage(
      input.locale ?? 'en',
      input.circleId,
      input.cycleNo,
      input.amount,
    ),
    // Sent INSTEAD of the body when WHATSAPP_TEMPLATES_ENABLED=true —
    // business-initiated freeform texts are rejected by Meta outside the
    // 24h service window, so production nudges must be template sends.
    template: buildYourTurnTemplate(
      input.locale ?? 'en',
      input.circleId,
      input.cycleNo,
      input.amount,
      input.recipient,
    ),
    kind: 'cycle_finalized',
    network: input.network,
    // Round-scoped dedupe — a duplicate webhook or a notifier restart
    // won't double-send the same "your turn" message inside the
    // 24-hour window.
    dedupeKey: input.dedupeKey ?? `${input.circleId}:${input.cycleNo}`,
    dedupeWindowMs: 24 * 60 * 60 * 1000,
  });
}
