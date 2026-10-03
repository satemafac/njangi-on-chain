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
// No Meta template is attached. The nudge used to reuse the approved
// `payout_processed` template, whose fixed copy reads "Payout Distributed!
// … Payout sent to {{3}}": false for a payout that is waiting to be
// collected, so with WHATSAPP_TEMPLATES_ENABLED=true it would contradict
// the nudge. No legacy template says "your payout is ready to collect" for
// a round the recipient collects themselves, so the nudge sends its
// freeform body, which Meta delivers inside an open 24h service window.
// Delivery outside that window needs a template approved for this copy,
// wired in here.

import { sendMemberNotification } from './whatsapp-notifier';
import type { SendMemberNotificationResult } from './whatsapp-notifier';
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
  return sendMemberNotification({
    memberAddress: input.recipient,
    phoneOverride: input.recipientPhone,
    body: buildYourTurnMessage(
      input.locale ?? 'en',
      input.circleId,
      input.cycleNo,
      input.amount,
    ),
    // No `template`: see the header. The body is the send shape whether or
    // not WHATSAPP_TEMPLATES_ENABLED is set.
    kind: 'cycle_finalized',
    network: input.network,
    // Round-scoped dedupe — a duplicate webhook or a notifier restart
    // won't double-send the same "your turn" message inside the
    // 24-hour window.
    dedupeKey: input.dedupeKey ?? `${input.circleId}:${input.cycleNo}`,
    dedupeWindowMs: 24 * 60 * 60 * 1000,
  });
}
