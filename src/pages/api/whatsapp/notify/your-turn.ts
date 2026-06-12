/**
 * POST /api/whatsapp/notify/your-turn
 *
 * Indexer / cron endpoint that fires when a CycleEscrow fills up. Phase 11
 * routes the actual lookup + send through the central
 * `sendMemberNotification` dispatcher so audit logging, dedupe, and PII
 * resolution stay in one place.
 *
 * Auth: shared-secret header `x-internal-auth: ${INTERNAL_NOTIFY_SECRET}`.
 *
 * Payload shape:
 *   {
 *     circleId: string,                 // required
 *     cycleNo: number,                  // required
 *     amount: string,                   // human-readable, e.g. "350 USDC"
 *     recipient?: string,               // optional Sui address override
 *     recipientPhone?: string,          // optional E.164 override
 *     locale?: 'en' | 'fr' | 'pcm' | 'sw' | 'am' | 'ar' | 'fa',
 *     network?: NetworkType,
 *   }
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { appLogger } from '../../../../utils/logger';
import { sendMemberNotification } from '../../../../lib/whatsapp-notifier';
import { timingSafeEqualStrings } from '../../../../lib/timing-safe';
import type { NetworkType } from '../../../../services/whatsapp-registry-service';

type SupportedLocale = 'en' | 'fr' | 'pcm' | 'sw' | 'am' | 'ar' | 'fa';

interface RequestBody {
  circleId?: string;
  cycleNo?: number;
  amount?: string;
  recipient?: string;
  recipientPhone?: string;
  locale?: SupportedLocale;
  network?: NetworkType;
}

const TEMPLATE_BY_LOCALE: Record<SupportedLocale, (vars: { circleShort: string; cycleNo: number; amount: string }) => string> = {
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

function templateBody(
  locale: SupportedLocale,
  circleId: string,
  cycleNo: number,
  amount: string,
): string {
  const fn = TEMPLATE_BY_LOCALE[locale] ?? TEMPLATE_BY_LOCALE.en;
  return fn({ circleShort: circleId.slice(0, 8), cycleNo, amount });
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const authHeader = req.headers['x-internal-auth'];
  const secret = process.env.INTERNAL_NOTIFY_SECRET;
  // Constant-time comparison — a plain `!==` short-circuits and leaks
  // timing information about the shared secret.
  if (!secret || !timingSafeEqualStrings(authHeader, secret)) {
    return res.status(401).json({ error: 'Invalid internal auth' });
  }

  const body = (req.body || {}) as RequestBody;
  const { circleId, cycleNo, amount } = body;
  const network = body.network ?? 'testnet';
  const locale: SupportedLocale = body.locale ?? 'en';

  if (!circleId || typeof cycleNo !== 'number' || !amount) {
    return res.status(400).json({ error: 'circleId, cycleNo, amount required' });
  }

  try {
    const result = await sendMemberNotification({
      memberAddress: body.recipient ?? circleId,
      phoneOverride: body.recipientPhone,
      body: templateBody(locale, circleId, cycleNo, amount),
      kind: 'cycle_finalized',
      network,
      // Round-scoped dedupe — a duplicate webhook or a notifier restart
      // won't double-send the same "your turn" message inside the
      // 24-hour window.
      dedupeKey: `${circleId}:${cycleNo}`,
      dedupeWindowMs: 24 * 60 * 60 * 1000,
    });

    return res.status(200).json({
      sent: result.sent,
      reason: result.reason,
    });
  } catch (error) {
    appLogger.error('[notify/your-turn] Unhandled error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'notify failed',
    });
  }
}
