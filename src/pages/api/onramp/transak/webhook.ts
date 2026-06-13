/**
 * POST /api/onramp/transak/webhook
 *
 * Transak signs webhook events as an HS256 JWT (partner API secret) and
 * the ENTIRE event payload lives inside that token: the decoded claims are
 * `{ eventID, createdAt, webhookData }`. We verify the signature with
 * TRANSAK_API_SECRET, then consume ONLY the verified claims — any plaintext
 * sibling fields in the HTTP body are attacker-writable (a holder of one
 * valid token could attach a forged `KYC_APPROVED` + arbitrary wallet) and
 * are ignored entirely (2026-06 GTM audit, HIGH: attestation payload must
 * be covered by the verified signature).
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { decodeTransakWebhook } from '../../../../services/transak-service';
import { recordOnrampEvent } from '../../../../lib/onramp-logging';
import {
  handleRampKycEvent,
  type RampKycEvidence,
  type RampKycOutcome,
} from '../../../../lib/ramp-kyc-bridge';
import { registerWebhookEvent, unregisterWebhookEvent } from '../../../../lib/webhook-dedupe';
import type { NetworkType } from '../../../../services/whatsapp-registry-service';

export const config = {
  api: {
    bodyParser: true,
  },
};

/**
 * Pulls the JWT out of the delivery. Transak posts either the raw token as
 * the request body or a JSON envelope of the shape `{ "data": "<jwt>" }`.
 * Nothing else in the body is trusted.
 */
function extractJwt(body: unknown): string | null {
  if (typeof body === 'string') return body.trim() || null;
  if (body && typeof body === 'object') {
    const data = (body as { data?: unknown }).data;
    if (typeof data === 'string') return data;
  }
  return null;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const claims = decodeTransakWebhook(extractJwt(req.body));
  if (!claims) {
    return res.status(403).json({ error: 'INVALID_SIGNATURE' });
  }

  // SOLE payload source: the signature-covered JWT claims. Real Transak
  // deliveries carry the order/KYC record in `claims.webhookData`.
  const payload: Record<string, unknown> =
    claims.webhookData &&
    typeof claims.webhookData === 'object' &&
    !Array.isArray(claims.webhookData)
      ? claims.webhookData
      : {};

  try {
    await recordOnrampEvent({
      provider: 'transak',
      payload: {
        eventID: claims.eventID,
        createdAt: claims.createdAt,
        webhookData: payload,
      },
      receivedAt: new Date(),
    });
  } catch (err) {
    console.error('[transak/webhook] persistence failed', err);
  }

  // Phase 11: queue an attestation + send the WhatsApp confirmation.
  // Transak delivers both dedicated KYC-status events (`KYC_APPROVED`,
  // `KYC_REJECTED`, ...) and order lifecycle events whose
  // `webhookData.status` mirrors the user-facing order status
  // (`COMPLETED`, `FAILED`, `PROCESSING`, ...). Per the truthful-
  // attestation rule (2026-06 GTM audit) we prefer the dedicated KYC
  // decision when Transak sends one — evidence:'partner_kyc_decision' —
  // and otherwise record a completed order as exactly what it is —
  // evidence:'purchase_completed', i.e. Transak's own KYC/AML program
  // settled a purchase for this buyer. Order events are kept as an
  // attestation source because KYC events may omit the destination wallet
  // address that binds the attestation subject.
  const transakEvent = transakEventId(claims.eventID);
  const isKycEvent = transakEvent?.startsWith('KYC') ?? false;
  const outcome = isKycEvent
    ? transakKycOutcome(transakEvent as string, payload)
    : transakOutcome(payload);
  const evidence: RampKycEvidence = isKycEvent
    ? 'partner_kyc_decision'
    : 'purchase_completed';
  const issuerAddress = process.env.NEXT_PUBLIC_NJANGI_ATTESTATION_ISSUER ?? '';
  const subjectAddress = transakSubject(payload);
  const providerCaseId = transakCaseId(payload);
  if (outcome && issuerAddress && providerCaseId) {
    // Transak retries deliveries; dedupe on the (case, outcome) transition
    // so a redelivery doesn't re-queue the attestation or re-send the
    // WhatsApp confirmation. This is also the replay containment for a
    // captured token (Transak JWTs carry no exp): the payload is
    // signature-bound, so a replay can only repeat this exact transition,
    // which the durable dedupe row suppresses.
    const dedupeId = `${providerCaseId}:${outcome}`;
    const duplicate = await registerWebhookEvent('transak', dedupeId);
    if (!duplicate) {
      const network = (process.env.NEXT_PUBLIC_SUI_NETWORK as NetworkType) ?? 'testnet';
      try {
        // Awaited before responding: on serverless the instance is frozen
        // once the response is sent, so a fire-and-forget call may never
        // run while the durable dedupe row above suppresses the retry.
        await handleRampKycEvent(
          {
            provider: 'transak',
            outcome,
            evidence,
            providerCaseId,
            subjectAddress,
            network,
          },
          issuerAddress,
        );
      } catch (err) {
        console.warn('[transak/webhook] ramp-kyc bridge failed', err);
        // Release the dedupe claim and return non-2xx so Transak redelivers;
        // the bridge is idempotent on retry.
        await unregisterWebhookEvent('transak', dedupeId);
        return res.status(500).json({ error: 'KYC_BRIDGE_FAILED' });
      }
    }
  }

  return res.status(200).json({ received: true });
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Uppercased Transak event id (e.g. `ORDER_COMPLETED`, `KYC_APPROVED`). */
function transakEventId(eventID: unknown): string | undefined {
  return asString(eventID)?.toUpperCase();
}

/**
 * Maps Transak's dedicated KYC-status events to an outcome. These are the
 * preferred attestation trigger because they are an explicit partner KYC
 * decision rather than an inference from a settled purchase.
 */
function transakKycOutcome(
  eventId: string,
  payload: Record<string, unknown>,
): RampKycOutcome | null {
  if (eventId === 'KYC_APPROVED') return 'approved';
  if (
    eventId === 'KYC_REJECTED' ||
    eventId === 'KYC_FAILED' ||
    eventId === 'KYC_DECLINED'
  ) {
    return 'declined';
  }
  // Other KYC_* events (KYC_SUBMITTED, KYC_UPDATED, ...) — consult any
  // status field before defaulting to in-flight.
  const status = asString(payload.status)?.toLowerCase();
  if (status === 'approved' || status === 'completed') return 'approved';
  if (status === 'rejected' || status === 'failed' || status === 'declined') {
    return 'declined';
  }
  return 'pending';
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

/**
 * The partner case id, taken ONLY from the verified order record
 * (`webhookData.id` / `webhookData.partnerOrderId`). The event-type
 * constant (`KYC_APPROVED`, `ORDER_COMPLETED`, ...) is never an acceptable
 * fallback: it is identical across users, so using one as the case id
 * would collapse the webhook dedupe key and the attestation-queue dedupe
 * key across unrelated members. Without a real case id the bridge is
 * skipped instead.
 */
function transakCaseId(payload: Record<string, unknown>): string | undefined {
  const explicit = asString(payload.id) ?? asString(payload.partnerOrderId);
  if (!explicit) return undefined;
  if (/^[A-Z][A-Z_]*$/.test(explicit)) return undefined;
  return explicit;
}
