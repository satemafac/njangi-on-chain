import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import type { CoinbaseAssetIntent } from '@/types/coinbase-onramp';
import { maskWalletAddress } from '@/services/coinbase-onramp-service';
import { createOnrampRequestLogger } from '@/lib/onramp-logging';

type CallbackStatus =
  | 'success'
  | 'pending'
  | 'failed'
  | 'cancelled'
  | 'unknown';

interface CallbackResponse {
  provider: 'coinbase';
  status: CallbackStatus;
  transactionId?: string;
  sessionId?: string;
  walletAddress?: string;
  assetIntent?: CoinbaseAssetIntent;
  message: string;
  receivedAt: string;
}

interface CallbackErrorResponse {
  provider: 'coinbase';
  error: string;
  message: string;
}

const callbackQuerySchema = z.object({
  status: z.string().trim().optional(),
  transactionId: z.string().trim().optional(),
  sessionId: z.string().trim().optional(),
  walletAddress: z
    .string()
    .trim()
    .regex(/^0x[a-fA-F0-9]{1,64}$/)
    .optional(),
  assetIntent: z.enum(['SUI', 'USDC_ON_SUI']).optional(),
});

function firstQueryValue(
  value: string | string[] | undefined,
): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
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
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, X-Correlation-Id, X-Request-Id',
  );
  res.setHeader('Access-Control-Expose-Headers', 'X-Correlation-Id');
  res.setHeader('Access-Control-Max-Age', '600');
  return true;
}

function normalizeStatus(value: string | undefined): CallbackStatus {
  const status = value?.trim().toLowerCase();
  if (!status) {
    return 'unknown';
  }
  if (status === 'success' || status === 'completed' || status === 'complete') {
    return 'success';
  }
  if (status === 'pending' || status === 'processing') {
    return 'pending';
  }
  if (status === 'failed' || status === 'error') {
    return 'failed';
  }
  if (status === 'cancelled' || status === 'canceled') {
    return 'cancelled';
  }
  return 'unknown';
}

function normalizeAssetIntent(value: string | undefined): CoinbaseAssetIntent | undefined {
  const normalized = value?.trim().toUpperCase();
  if (normalized === 'SUI') {
    return 'SUI';
  }
  if (normalized === 'USDC_ON_SUI' || normalized === 'USDC') {
    return 'USDC_ON_SUI';
  }
  return undefined;
}

function normalizeCallbackMessage(status: CallbackStatus): string {
  if (status === 'success') {
    return 'Onramp purchase completed successfully.';
  }
  if (status === 'pending') {
    return 'Onramp purchase is pending confirmation.';
  }
  if (status === 'failed') {
    return 'Onramp purchase failed.';
  }
  if (status === 'cancelled') {
    return 'Onramp purchase was cancelled.';
  }
  return 'Onramp callback received.';
}

export default function handler(
  req: NextApiRequest,
  res: NextApiResponse<CallbackResponse | CallbackErrorResponse>,
) {
  setSecurityHeaders(res);
  const logger = createOnrampRequestLogger(
    req,
    res,
    '/api/onramp/coinbase/callback',
  );

  if (!allowOrigin(req, res)) {
    logger.warn('callback_cors_forbidden', {
      origin: req.headers.origin,
    });
    return res.status(403).json({
      provider: 'coinbase',
      error: 'CORS_FORBIDDEN',
      message: 'Origin is not allowed.',
    });
  }

  if (req.method === 'OPTIONS') {
    logger.info('callback_preflight');
    return res.status(204).end();
  }

  if (req.method !== 'GET') {
    logger.warn('callback_method_not_allowed', {
      method: req.method,
    });
    return res.status(405).json({
      provider: 'coinbase',
      error: 'METHOD_NOT_ALLOWED',
      message: 'Method not allowed.',
    });
  }

  const rawQuery = {
    status: firstQueryValue(req.query.status as string | string[] | undefined),
    transactionId: firstQueryValue(
      (req.query.transactionId ??
        req.query.transaction_id ??
        req.query.txId) as string | string[] | undefined,
    ),
    sessionId: firstQueryValue(
      (req.query.sessionId ?? req.query.session_id) as string | string[] | undefined,
    ),
    walletAddress: firstQueryValue(
      (req.query.walletAddress ??
        req.query.wallet ??
        req.query.address) as string | string[] | undefined,
    ),
    assetIntent: firstQueryValue(
      (req.query.assetIntent ??
        req.query.asset ??
        req.query.assetSymbol) as string | string[] | undefined,
    ),
  };

  const parsed = callbackQuerySchema.safeParse({
    ...rawQuery,
    assetIntent: normalizeAssetIntent(rawQuery.assetIntent),
  });

  if (!parsed.success) {
    logger.warn('callback_validation_failed');
    return res.status(400).json({
      provider: 'coinbase',
      error: 'VALIDATION_ERROR',
      message: 'Invalid callback query parameters.',
    });
  }

  const normalizedStatus = normalizeStatus(parsed.data.status);
  const payload: CallbackResponse = {
    provider: 'coinbase',
    status: normalizedStatus,
    transactionId: parsed.data.transactionId,
    sessionId: parsed.data.sessionId,
    walletAddress: parsed.data.walletAddress,
    assetIntent: parsed.data.assetIntent,
    message: normalizeCallbackMessage(normalizedStatus),
    receivedAt: new Date().toISOString(),
  };

  logger.info('callback_received', {
    status: payload.status,
    transactionId: payload.transactionId,
    sessionId: payload.sessionId,
    walletAddress: payload.walletAddress
      ? maskWalletAddress(payload.walletAddress)
      : undefined,
    assetIntent: payload.assetIntent,
  });

  return res.status(200).json(payload);
}
