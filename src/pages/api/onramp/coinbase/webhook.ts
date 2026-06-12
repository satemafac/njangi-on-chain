import type { NextApiRequest, NextApiResponse } from 'next';
import crypto from 'crypto';
import { maskWalletAddress } from '@/services/coinbase-onramp-service';
import { createOnrampRequestLogger } from '@/lib/onramp-logging';
import { handleRampKycEvent, type RampKycOutcome } from '@/lib/ramp-kyc-bridge';
import { registerWebhookEvent, unregisterWebhookEvent } from '@/lib/webhook-dedupe';
import type { NetworkType } from '@/services/whatsapp-registry-service';

interface WebhookSuccessResponse {
  provider: 'coinbase';
  ok: true;
  duplicate: boolean;
  eventId: string;
  eventType: string;
  status: string;
}

interface WebhookErrorResponse {
  provider: 'coinbase';
  ok: false;
  error: string;
  message: string;
}

interface CoinbaseWebhookPayload {
  id?: string;
  event_id?: string;
  type?: string;
  event_type?: string;
  data?: {
    id?: string;
    transaction_id?: string;
    tx_id?: string;
    status?: string;
    walletAddress?: string;
    wallet_address?: string;
  };
  event?: {
    id?: string;
    type?: string;
    status?: string;
    transaction_id?: string;
  };
}

function setSecurityHeaders(res: NextApiResponse): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
}

function allowOrigin(req: NextApiRequest, res: NextApiResponse): boolean {
  const origin = req.headers.origin;
  if (!origin) {
    return true;
  }

  const configuredOrigins = (process.env.COINBASE_ONRAMP_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const defaultOrigins = ['http://localhost:3000', 'https://localhost:3000'];
  const allowedOrigins = new Set([...configuredOrigins, ...defaultOrigins]);
  const hostHeader = req.headers.host;

  if (hostHeader) {
    try {
      const parsed = new URL(origin);
      if (parsed.host === hostHeader) {
        allowedOrigins.add(origin);
      }
    } catch {
      // Handled below.
    }
  }

  if (!allowedOrigins.has(origin)) {
    return false;
  }

  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, X-CC-Webhook-Signature, X-Coinbase-Signature, X-Correlation-Id, X-Request-Id',
  );
  res.setHeader('Access-Control-Expose-Headers', 'X-Correlation-Id');
  res.setHeader('Access-Control-Max-Age', '600');
  return true;
}

function getRawBody(req: NextApiRequest): string {
  if (typeof req.body === 'string') {
    return req.body;
  }
  if (Buffer.isBuffer(req.body)) {
    return req.body.toString('utf8');
  }
  return JSON.stringify(req.body ?? {});
}

function parsePayload(req: NextApiRequest): CoinbaseWebhookPayload | null {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    return req.body as CoinbaseWebhookPayload;
  }

  const rawBody = getRawBody(req);
  if (!rawBody) {
    return null;
  }

  try {
    return JSON.parse(rawBody) as CoinbaseWebhookPayload;
  } catch {
    return null;
  }
}

function getSignature(req: NextApiRequest): string | null {
  const candidates = [
    req.headers['x-cc-webhook-signature'],
    req.headers['x-coinbase-signature'],
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      if (candidate[0]) {
        return candidate[0];
      }
      continue;
    }
    if (candidate) {
      return candidate;
    }
  }

  return null;
}

function normalizeSignature(signature: string): string {
  const trimmed = signature.trim();
  if (trimmed.startsWith('sha256=')) {
    return trimmed.slice('sha256='.length);
  }
  return trimmed;
}

function verifySignature(
  rawBody: string,
  signature: string,
  secret: string,
): boolean {
  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');
  const provided = normalizeSignature(signature);

  if (expected.length !== provided.length) {
    return false;
  }

  return crypto.timingSafeEqual(
    Buffer.from(expected, 'utf8'),
    Buffer.from(provided, 'utf8'),
  );
}

function normalizeEvent(payload: CoinbaseWebhookPayload): {
  eventId: string;
  eventType: string;
  status: string;
  transactionId?: string;
  walletAddress?: string;
} {
  const eventId =
    payload.id ??
    payload.event_id ??
    payload.data?.id ??
    payload.event?.id ??
    `evt_${Date.now()}`;
  const eventType =
    payload.type ??
    payload.event_type ??
    payload.event?.type ??
    'unknown';
  const status =
    payload.data?.status ?? payload.event?.status ?? 'unknown';
  const transactionId =
    payload.data?.transaction_id ??
    payload.data?.tx_id ??
    payload.event?.transaction_id;
  const walletAddress = payload.data?.walletAddress ?? payload.data?.wallet_address;

  return {
    eventId,
    eventType,
    status,
    transactionId,
    walletAddress,
  };
}

function coinbaseStatusToOutcome(status: string): RampKycOutcome | null {
  const lower = status.toLowerCase();
  if (lower.includes('success') || lower === 'completed' || lower === 'approved') {
    return 'approved';
  }
  if (lower === 'declined' || lower === 'failed' || lower === 'rejected') {
    return 'declined';
  }
  if (lower === 'pending' || lower === 'processing') {
    return 'pending';
  }
  return null;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<WebhookSuccessResponse | WebhookErrorResponse>,
) {
  setSecurityHeaders(res);
  const logger = createOnrampRequestLogger(
    req,
    res,
    '/api/onramp/coinbase/webhook',
  );

  if (!allowOrigin(req, res)) {
    logger.warn('webhook_cors_forbidden', {
      origin: req.headers.origin,
    });
    return res.status(403).json({
      provider: 'coinbase',
      ok: false,
      error: 'CORS_FORBIDDEN',
      message: 'Origin is not allowed.',
    });
  }

  if (req.method === 'OPTIONS') {
    logger.info('webhook_preflight');
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    logger.warn('webhook_method_not_allowed', {
      method: req.method,
    });
    return res.status(405).json({
      provider: 'coinbase',
      ok: false,
      error: 'METHOD_NOT_ALLOWED',
      message: 'Method not allowed.',
    });
  }

  const webhookSecret = process.env.COINBASE_ONRAMP_WEBHOOK_SECRET;
  if (!webhookSecret) {
    logger.error('webhook_secret_missing');
    return res.status(503).json({
      provider: 'coinbase',
      ok: false,
      error: 'WEBHOOK_SECRET_MISSING',
      message: 'Coinbase webhook secret is not configured.',
    });
  }

  const signature = getSignature(req);
  if (!signature) {
    logger.warn('webhook_signature_missing');
    return res.status(401).json({
      provider: 'coinbase',
      ok: false,
      error: 'SIGNATURE_REQUIRED',
      message: 'Missing Coinbase webhook signature.',
    });
  }

  const rawBody = getRawBody(req);
  if (!verifySignature(rawBody, signature, webhookSecret)) {
    logger.warn('webhook_signature_invalid');
    return res.status(401).json({
      provider: 'coinbase',
      ok: false,
      error: 'INVALID_SIGNATURE',
      message: 'Invalid Coinbase webhook signature.',
    });
  }

  const payload = parsePayload(req);
  if (!payload) {
    logger.warn('webhook_payload_invalid');
    return res.status(400).json({
      provider: 'coinbase',
      ok: false,
      error: 'INVALID_PAYLOAD',
      message: 'Webhook payload is missing or invalid.',
    });
  }

  // Durable dedupe across serverless instances (webhook_events table when
  // DATABASE_URL is set; in-memory TTL cache in dev).
  const normalized = normalizeEvent(payload);
  const duplicate = await registerWebhookEvent('coinbase', normalized.eventId);

  logger.info('webhook_processed', {
    eventId: normalized.eventId,
    eventType: normalized.eventType,
    status: normalized.status,
    duplicate,
    transactionId: normalized.transactionId,
    walletAddress: normalized.walletAddress
      ? maskWalletAddress(normalized.walletAddress)
      : undefined,
  });

  // Phase 11: when this event represents a final KYC decision, run the
  // central ramp-KYC bridge so an attestation gets queued and the member
  // receives a WhatsApp confirmation. Skip duplicates so a webhook retry
  // doesn't re-send the message.
  //
  // The bridge is awaited BEFORE the response: on serverless the function
  // instance is frozen once the response is sent, so a fire-and-forget
  // promise may never run — and the durable dedupe row written above would
  // suppress the provider's retry, losing the side effect permanently.
  // Coinbase tolerates multi-second webhook responses.
  if (!duplicate) {
    const outcome = coinbaseStatusToOutcome(normalized.status);
    const issuerAddress = process.env.NEXT_PUBLIC_NJANGI_ATTESTATION_ISSUER ?? '';
    if (outcome && issuerAddress) {
      const network = (process.env.NEXT_PUBLIC_SUI_NETWORK as NetworkType) ?? 'testnet';
      try {
        await handleRampKycEvent(
          {
            provider: 'coinbase',
            outcome,
            providerCaseId: normalized.transactionId ?? normalized.eventId,
            subjectAddress: normalized.walletAddress,
            network,
          },
          issuerAddress,
        );
      } catch (err) {
        logger.warn('ramp_kyc_bridge_failed', {
          eventId: normalized.eventId,
          error: err instanceof Error ? err.message : String(err),
        });
        // Release the dedupe claim and signal failure so Coinbase retries
        // the delivery; the bridge is idempotent on retry.
        await unregisterWebhookEvent('coinbase', normalized.eventId);
        return res.status(500).json({
          provider: 'coinbase',
          ok: false,
          error: 'KYC_BRIDGE_FAILED',
          message:
            'KYC side effects failed; the event was released for provider retry.',
        });
      }
    }
  }

  return res.status(duplicate ? 200 : 201).json({
    provider: 'coinbase',
    ok: true,
    duplicate,
    eventId: normalized.eventId,
    eventType: normalized.eventType,
    status: normalized.status,
  });
}
