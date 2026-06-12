/**
 * POST /api/onramp/moonpay/webhook
 *
 * Receives transaction status updates from MoonPay. We verify the
 * `Moonpay-Signature-V2` HMAC against the raw body before accepting the
 * payload. Successful events are persisted to the shared on/off-ramp
 * audit log used for reconciliation.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { verifyMoonPayWebhookSignature } from '../../../../services/moonpay-service';
import { recordOnrampEvent } from '../../../../lib/onramp-logging';
import { handleRampKycEvent, type RampKycOutcome } from '../../../../lib/ramp-kyc-bridge';
import { registerWebhookEvent, unregisterWebhookEvent } from '../../../../lib/webhook-dedupe';
import type { NetworkType } from '../../../../services/whatsapp-registry-service';

export const config = {
  api: {
    bodyParser: false,
  },
};

async function readRawBody(req: NextApiRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let rawBody: string;
  try {
    rawBody = await readRawBody(req);
  } catch (err) {
    console.error('[moonpay/webhook] failed to read raw body', err);
    return res.status(400).json({ error: 'INVALID_BODY' });
  }

  const signature = (req.headers['moonpay-signature-v2'] as string | undefined) ?? null;
  let verified = false;
  try {
    verified = verifyMoonPayWebhookSignature(rawBody, signature);
  } catch (err) {
    console.error('[moonpay/webhook] signature verification error', err);
    return res.status(500).json({ error: 'SIGNATURE_VERIFY_FAILED' });
  }

  if (!verified) {
    return res.status(403).json({ error: 'INVALID_SIGNATURE' });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch (err) {
    return res.status(400).json({ error: 'INVALID_JSON', details: (err as Error).message });
  }

  try {
    await recordOnrampEvent({
      provider: 'moonpay',
      payload: payload as Record<string, unknown>,
      receivedAt: new Date(),
    });
  } catch (err) {
    console.error('[moonpay/webhook] persistence failed', err);
    // 200 anyway — MoonPay retries on non-2xx and we don't want re-delivery
    // storms; the failure is captured in the application logger.
  }

  // Phase 11: queue an attestation + send a WhatsApp confirmation when
  // the customer just completed KYC. MoonPay sends `customer.kyc_completed`
  // (or `transaction.completed` after a fresh KYC). We accept any payload
  // shape that exposes a status string and a customer reference.
  const outcome = moonpayOutcome(payload);
  const issuerAddress = process.env.NEXT_PUBLIC_NJANGI_ATTESTATION_ISSUER ?? '';
  const subjectAddress = moonpaySubject(payload);
  const providerCaseId = moonpayCaseId(payload);
  if (outcome && issuerAddress && providerCaseId) {
    // MoonPay retries deliveries on non-2xx/timeouts; dedupe on the
    // (case, outcome) transition so a redelivery doesn't re-queue the
    // attestation or re-send the WhatsApp confirmation.
    const dedupeId = `${providerCaseId}:${outcome}`;
    const duplicate = await registerWebhookEvent('moonpay', dedupeId);
    if (!duplicate) {
      const network = (process.env.NEXT_PUBLIC_SUI_NETWORK as NetworkType) ?? 'testnet';
      try {
        // Awaited before responding: on serverless the instance is frozen
        // once the response is sent, so a fire-and-forget call may never
        // run while the durable dedupe row above suppresses the retry.
        await handleRampKycEvent(
          {
            provider: 'moonpay',
            outcome,
            providerCaseId,
            subjectAddress,
            network,
          },
          issuerAddress,
        );
      } catch (err) {
        console.warn('[moonpay/webhook] ramp-kyc bridge failed', err);
        // Release the dedupe claim and return non-2xx so MoonPay redelivers;
        // the bridge is idempotent on retry.
        await unregisterWebhookEvent('moonpay', dedupeId);
        return res.status(500).json({ error: 'KYC_BRIDGE_FAILED' });
      }
    }
  }

  return res.status(200).json({ received: true });
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function pickPath(payload: unknown, ...keys: string[]): unknown {
  let current: unknown = payload;
  for (const key of keys) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function moonpayOutcome(payload: unknown): RampKycOutcome | null {
  const status = asString(pickPath(payload, 'data', 'status'))
    ?? asString(pickPath(payload, 'data', 'kycStatus'))
    ?? asString(pickPath(payload, 'data', 'transactionStatus'));
  if (!status) return null;
  const lower = status.toLowerCase();
  if (lower === 'completed' || lower === 'approved' || lower === 'success') return 'approved';
  if (lower === 'failed' || lower === 'declined' || lower === 'rejected') return 'declined';
  if (lower === 'pending' || lower === 'waitingforauthorization' || lower === 'inreview') {
    return 'pending';
  }
  return null;
}

function moonpaySubject(payload: unknown): string | undefined {
  return asString(pickPath(payload, 'data', 'walletAddress'))
    ?? asString(pickPath(payload, 'data', 'customer', 'walletAddress'));
}

function moonpayCaseId(payload: unknown): string | undefined {
  return asString(pickPath(payload, 'data', 'id'))
    ?? asString(pickPath(payload, 'data', 'transactionId'))
    ?? asString(pickPath(payload, 'data', 'externalTransactionId'));
}
