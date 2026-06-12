/**
 * POST /api/whatsapp/notify/your-turn
 *
 * Indexer / cron endpoint that fires when a CycleEscrow fills up. Phase 11
 * routes the actual lookup + send through the central
 * `sendMemberNotification` dispatcher so audit logging, dedupe, and PII
 * resolution stay in one place. The message template + dedupe policy live
 * in src/lib/your-turn-notification.ts, shared with the Vercel cron
 * (/api/cron/cycle-finalized) which calls the same core in-process.
 *
 * Auth: shared-secret header `x-internal-auth: ${INTERNAL_NOTIFY_SECRET}`.
 *
 * Payload shape:
 *   {
 *     circleId: string,                 // required
 *     cycleNo: number,                  // required
 *     amount: string,                   // human-readable, e.g. "350 USDC"
 *     recipient: string,                // required Sui address of the payout
 *                                       // recipient. June 2026 audit: the
 *                                       // old fallback to circleId could
 *                                       // never match a member link, so
 *                                       // requests without it are rejected.
 *     recipientPhone?: string,          // optional E.164 override
 *     locale?: 'en' | 'fr' | 'pcm' | 'sw' | 'am' | 'ar' | 'fa',
 *     network?: NetworkType,
 *   }
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { appLogger } from '../../../../utils/logger';
import { timingSafeEqualStrings } from '../../../../lib/timing-safe';
import {
  sendYourTurnNotification,
  type SupportedLocale,
} from '../../../../lib/your-turn-notification';
import type { NetworkType } from '../../../../services/whatsapp-registry-service';

interface RequestBody {
  circleId?: string;
  cycleNo?: number;
  amount?: string;
  recipient?: string;
  recipientPhone?: string;
  locale?: SupportedLocale;
  network?: NetworkType;
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
  const { circleId, cycleNo, amount, recipient } = body;
  const network = body.network ?? 'testnet';
  const locale: SupportedLocale = body.locale ?? 'en';

  if (!circleId || typeof cycleNo !== 'number' || !amount) {
    return res.status(400).json({ error: 'circleId, cycleNo, amount required' });
  }
  if (!recipient || typeof recipient !== 'string') {
    // Hard requirement (June 2026 ops audit): without the recipient address
    // the lookup used to fall back to the circle id, which can never have a
    // member WhatsApp link — every nudge silently no-oped as `no_link`.
    return res.status(400).json({ error: 'recipient (Sui address) required' });
  }

  try {
    const result = await sendYourTurnNotification({
      circleId,
      cycleNo,
      amount,
      recipient,
      recipientPhone: body.recipientPhone,
      locale,
      network,
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
