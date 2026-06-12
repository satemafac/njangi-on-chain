/**
 * POST /api/onramp/transak/webhook
 *
 * Transak signs order updates with a partner JWT in the request body.
 * We verify the signature with TRANSAK_API_SECRET and append accepted
 * events to the shared on/off-ramp audit log.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { verifyTransakWebhookJwt } from '../../../../services/transak-service';
import { recordOnrampEvent } from '../../../../lib/onramp-logging';
import { handleRampKycEvent, type RampKycOutcome } from '../../../../lib/ramp-kyc-bridge';
import type { NetworkType } from '../../../../services/whatsapp-registry-service';

export const config = {
  api: {
    bodyParser: true,
  },
};

interface TransakWebhookEnvelope {
  data?: string; // JWT
  webhookData?: Record<string, unknown>;
  eventID?: string;
  status?: string;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = (req.body || {}) as TransakWebhookEnvelope;
  const jwt = typeof body.data === 'string' ? body.data : null;
  if (!verifyTransakWebhookJwt(jwt)) {
    return res.status(403).json({ error: 'INVALID_SIGNATURE' });
  }

  const payload =
    body.webhookData && typeof body.webhookData === 'object'
      ? body.webhookData
      : { eventID: body.eventID, status: body.status };

  try {
    await recordOnrampEvent({
      provider: 'transak',
      payload: payload as Record<string, unknown>,
      receivedAt: new Date(),
    });
  } catch (err) {
    console.error('[transak/webhook] persistence failed', err);
  }

  // Phase 11: queue an attestation + send the WhatsApp confirmation when
  // Transak finishes KYC. Their `webhookData.status` mirrors the user-
  // facing order status (`COMPLETED`, `FAILED`, `PROCESSING`, etc.).
  const outcome = transakOutcome(payload);
  const issuerAddress = process.env.NEXT_PUBLIC_NJANGI_ATTESTATION_ISSUER ?? '';
  const subjectAddress = transakSubject(payload);
  const providerCaseId = transakCaseId(payload, body);
  if (outcome && issuerAddress && providerCaseId) {
    const network = (process.env.NEXT_PUBLIC_SUI_NETWORK as NetworkType) ?? 'testnet';
    void handleRampKycEvent(
      {
        provider: 'transak',
        outcome,
        providerCaseId,
        subjectAddress,
        network,
      },
      issuerAddress,
    ).catch((err) => {
      console.warn('[transak/webhook] ramp-kyc bridge failed', err);
    });
  }

  return res.status(200).json({ received: true });
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function transakOutcome(payload: Record<string, unknown>): RampKycOutcome | null {
  const status = asString(payload.status) ?? asString(payload.transactionStatus);
  if (!status) return null;
  const lower = status.toLowerCase();
  if (lower === 'completed' || lower === 'success') return 'approved';
  if (lower === 'failed' || lower === 'cancelled' || lower === 'rejected') return 'declined';
  if (lower === 'processing' || lower === 'awaiting_payment_from_user' || lower === 'pending') {
    return 'pending';
  }
  return null;
}

function transakSubject(payload: Record<string, unknown>): string | undefined {
  return asString(payload.walletAddress) ?? asString(payload.cryptoWalletAddress);
}

function transakCaseId(
  payload: Record<string, unknown>,
  envelope: TransakWebhookEnvelope,
): string | undefined {
  return asString(payload.id)
    ?? asString(payload.partnerOrderId)
    ?? asString(envelope.eventID);
}
