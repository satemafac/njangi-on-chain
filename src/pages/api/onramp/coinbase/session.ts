import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import {
  CoinbaseOnrampError,
  CoinbaseOnrampService,
  type CoinbaseAssetIntent,
  maskWalletAddress,
} from '@/services/coinbase-onramp-service';
import {
  createOnrampRequestLogger,
  hashForLogs,
} from '@/lib/onramp-logging';
import { isSanctionedCountry } from '@/lib/ramp-geo';
import { getTrustedClientIp } from '@/lib/trusted-client-ip';

type ErrorResponse = {
  provider: 'coinbase';
  error: string;
  message: string;
  fallbackProvider: 'moonpay' | null;
};

type SuccessResponse = {
  provider: 'coinbase';
  token: string;
  channelId?: string;
  assetIntent: CoinbaseAssetIntent;
};

const REQUESTS_PER_MINUTE_PER_IP = 10;
const REQUESTS_PER_MINUTE_PER_WALLET = 20;
const REQUESTS_PER_DAY_PER_IP = 400;
const REQUESTS_PER_DAY_PER_WALLET = 100;
const MINUTE_WINDOW_MS = 60_000;
const DAY_WINDOW_MS = 24 * 60 * 60 * 1000;

const rateLimitByIpPerMinute = new Map<string, { count: number; resetAt: number }>();
const rateLimitByWalletPerMinute = new Map<string, { count: number; resetAt: number }>();
const rateLimitByIpPerDay = new Map<string, { count: number; resetAt: number }>();
const rateLimitByWalletPerDay = new Map<string, { count: number; resetAt: number }>();

const sessionPayloadSchema = z.object({
  walletAddress: z
    .string()
    .trim()
    .regex(/^0x[a-fA-F0-9]{1,64}$/, 'Invalid Sui wallet address format'),
  preferredAssetIntent: z.enum(['SUI', 'USDC_ON_SUI']).default('USDC_ON_SUI'),
  fiatAmount: z
    .preprocess((value) => {
      if (value === undefined || value === null || value === '') {
        return undefined;
      }
      if (typeof value === 'number') {
        return value;
      }
      if (typeof value === 'string') {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : value;
      }
      return value;
    }, z.number().positive().max(100000))
    .optional(),
  fiatCurrency: z
    .string()
    .trim()
    .toUpperCase()
    .length(3)
    .optional()
    .default('USD'),
  country: z.string().trim().toUpperCase().length(2).optional().default('US'),
  subdivision: z.string().trim().toUpperCase().min(2).max(3).optional(),
});


function checkRateLimit(
  store: Map<string, { count: number; resetAt: number }>,
  key: string,
  maxRequests: number,
  windowMs: number,
): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
  const now = Date.now();
  const current = store.get(key);

  if (!current || current.resetAt <= now) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true };
  }

  if (current.count >= maxRequests) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((current.resetAt - now) / 1000),
    );
    return { allowed: false, retryAfterSeconds };
  }

  current.count += 1;
  return { allowed: true };
}

function allowOrigin(
  req: NextApiRequest,
  res: NextApiResponse,
): boolean {
  const origin = req.headers.origin;
  if (!origin) {
    return true;
  }

  const configuredOrigins = (
    process.env.COINBASE_ONRAMP_ALLOWED_ORIGINS ?? ''
  )
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  const defaultOrigins = ['http://localhost:3000', 'https://localhost:3000'];
  const allowedOrigins = new Set([...configuredOrigins, ...defaultOrigins]);
  const requestHost = req.headers.host;

  if (requestHost) {
    try {
      const parsedOrigin = new URL(origin);
      if (parsedOrigin.host === requestHost) {
        allowedOrigins.add(origin);
      }
    } catch {
      // If origin cannot be parsed we reject below.
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
    'Content-Type, Authorization, X-Correlation-Id, X-Request-Id',
  );
  res.setHeader('Access-Control-Expose-Headers', 'X-Correlation-Id');
  res.setHeader('Access-Control-Max-Age', '600');
  return true;
}

function setSecurityHeaders(res: NextApiResponse): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
}

function getErrorMessage(code: string): string {
  if (code === 'UNSUPPORTED_REGION') {
    return 'Coinbase onramp is currently available for US users only.';
  }

  if (code === 'VALIDATION_ERROR') {
    return 'Invalid request payload.';
  }

  if (code === 'RATE_LIMITED') {
    return 'Too many requests. Please wait and try again.';
  }

  return 'Coinbase onramp is temporarily unavailable.';
}

function readBody(req: NextApiRequest): unknown {
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body) as unknown;
    } catch {
      return req.body;
    }
  }

  return req.body;
}

function respondRateLimited(
  res: NextApiResponse<SuccessResponse | ErrorResponse>,
  retryAfterSeconds: number,
) {
  res.setHeader('Retry-After', String(retryAfterSeconds));
  return res.status(429).json({
    provider: 'coinbase',
    error: 'RATE_LIMITED',
    message: getErrorMessage('RATE_LIMITED'),
    fallbackProvider: 'moonpay',
  });
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<SuccessResponse | ErrorResponse>,
) {
  setSecurityHeaders(res);
  const logger = createOnrampRequestLogger(
    req,
    res,
    '/api/onramp/coinbase/session',
  );

  if (!allowOrigin(req, res)) {
    logger.warn('session_cors_forbidden', {
      origin: req.headers.origin,
    });
    return res.status(403).json({
      provider: 'coinbase',
      error: 'CORS_FORBIDDEN',
      message: 'Origin is not allowed.',
      fallbackProvider: 'moonpay',
    });
  }

  if (req.method === 'OPTIONS') {
    logger.info('session_preflight');
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    logger.warn('session_method_not_allowed', {
      method: req.method,
    });
    return res.status(405).json({
      provider: 'coinbase',
      error: 'METHOD_NOT_ALLOWED',
      message: 'Method not allowed',
      fallbackProvider: 'moonpay',
    });
  }

  const clientIp = getTrustedClientIp(req);
  if (!clientIp) {
    logger.warn('session_ip_missing');
    return res.status(400).json({
      provider: 'coinbase',
      error: 'IP_REQUIRED',
      message: 'Unable to determine client IP.',
      fallbackProvider: 'moonpay',
    });
  }

  const ipPerMinuteLimitResult = checkRateLimit(
    rateLimitByIpPerMinute,
    clientIp,
    REQUESTS_PER_MINUTE_PER_IP,
    MINUTE_WINDOW_MS,
  );
  if (!ipPerMinuteLimitResult.allowed) {
    logger.warn('session_rate_limit_exceeded', {
      scope: 'ip_per_minute',
      ipHash: hashForLogs(clientIp),
      retryAfterSeconds: ipPerMinuteLimitResult.retryAfterSeconds,
    });
    return respondRateLimited(res, ipPerMinuteLimitResult.retryAfterSeconds);
  }

  const ipPerDayLimitResult = checkRateLimit(
    rateLimitByIpPerDay,
    clientIp,
    REQUESTS_PER_DAY_PER_IP,
    DAY_WINDOW_MS,
  );
  if (!ipPerDayLimitResult.allowed) {
    logger.warn('session_rate_limit_exceeded', {
      scope: 'ip_per_day',
      ipHash: hashForLogs(clientIp),
      retryAfterSeconds: ipPerDayLimitResult.retryAfterSeconds,
    });
    return respondRateLimited(res, ipPerDayLimitResult.retryAfterSeconds);
  }

  const rawBody = readBody(req);
  const parsedBody = sessionPayloadSchema.safeParse(rawBody);
  if (!parsedBody.success) {
    logger.warn('session_validation_failed', {
      ipHash: hashForLogs(clientIp),
    });
    return res.status(400).json({
      provider: 'coinbase',
      error: 'VALIDATION_ERROR',
      message: getErrorMessage('VALIDATION_ERROR'),
      fallbackProvider: 'moonpay',
    });
  }

  // Sanctions screen on the edge-detected IP country — the body `country`
  // is client-supplied and could claim 'US' from anywhere. Coordinator-level
  // block ahead of Coinbase's own KYC.
  const edgeIpCountry = (req.headers['x-vercel-ip-country'] as string | undefined)
    ?.trim()
    .toUpperCase();
  if (isSanctionedCountry(edgeIpCountry)) {
    logger.info('session_blocked_region', {
      ipHash: hashForLogs(clientIp),
    });
    return res.status(403).json({
      provider: 'coinbase',
      error: 'BLOCKED_REGION',
      message: 'This service is not available in your region.',
      fallbackProvider: null,
    });
  }

  if (parsedBody.data.country !== 'US') {
    logger.info('session_unsupported_region', {
      country: parsedBody.data.country,
      ipHash: hashForLogs(clientIp),
      walletAddress: maskWalletAddress(parsedBody.data.walletAddress),
    });
    return res.status(400).json({
      provider: 'coinbase',
      error: 'UNSUPPORTED_REGION',
      message: getErrorMessage('UNSUPPORTED_REGION'),
      fallbackProvider: 'moonpay',
    });
  }

  const walletRateLimitKey = `${parsedBody.data.walletAddress}:${clientIp}`;
  const walletPerMinuteLimitResult = checkRateLimit(
    rateLimitByWalletPerMinute,
    walletRateLimitKey,
    REQUESTS_PER_MINUTE_PER_WALLET,
    MINUTE_WINDOW_MS,
  );
  if (!walletPerMinuteLimitResult.allowed) {
    logger.warn('session_rate_limit_exceeded', {
      scope: 'wallet_per_minute',
      ipHash: hashForLogs(clientIp),
      walletAddress: maskWalletAddress(parsedBody.data.walletAddress),
      retryAfterSeconds: walletPerMinuteLimitResult.retryAfterSeconds,
    });
    return respondRateLimited(res, walletPerMinuteLimitResult.retryAfterSeconds);
  }

  const walletPerDayLimitResult = checkRateLimit(
    rateLimitByWalletPerDay,
    parsedBody.data.walletAddress.toLowerCase(),
    REQUESTS_PER_DAY_PER_WALLET,
    DAY_WINDOW_MS,
  );
  if (!walletPerDayLimitResult.allowed) {
    logger.warn('session_rate_limit_exceeded', {
      scope: 'wallet_per_day',
      ipHash: hashForLogs(clientIp),
      walletAddress: maskWalletAddress(parsedBody.data.walletAddress),
      retryAfterSeconds: walletPerDayLimitResult.retryAfterSeconds,
    });
    return respondRateLimited(res, walletPerDayLimitResult.retryAfterSeconds);
  }

  try {
    const service = new CoinbaseOnrampService();
    const session = await service.createSessionToken({
      walletAddress: parsedBody.data.walletAddress,
      preferredAssetIntent: parsedBody.data.preferredAssetIntent,
      clientIp,
      correlationId: logger.correlationId,
    });

    logger.info('session_created', {
      ipHash: hashForLogs(clientIp),
      walletAddress: maskWalletAddress(parsedBody.data.walletAddress),
      assetIntent: parsedBody.data.preferredAssetIntent,
      hasChannelId: Boolean(session.channelId),
    });

    return res.status(200).json({
      provider: 'coinbase',
      token: session.token,
      channelId: session.channelId,
      assetIntent: session.assetIntent,
    });
  } catch (error) {
    if (error instanceof CoinbaseOnrampError) {
      const upstreamCause =
        (error as Error & { cause?: unknown }).cause &&
        typeof (error as Error & { cause?: unknown }).cause === 'object'
          ? ((error as Error & { cause?: unknown }).cause as {
              status?: unknown;
              body?: unknown;
            })
          : undefined;
      const upstreamStatus =
        typeof upstreamCause?.status === 'number' ? upstreamCause.status : undefined;
      const upstreamBodyPreview =
        typeof upstreamCause?.body === 'string'
          ? upstreamCause.body.slice(0, 300)
          : undefined;

      logger.error('session_failed', {
        code: error.code,
        statusCode: error.statusCode,
        upstreamStatus,
        upstreamBodyPreview,
        ipHash: hashForLogs(clientIp),
        walletAddress: maskWalletAddress(parsedBody.data.walletAddress),
        assetIntent: parsedBody.data.preferredAssetIntent,
      });

      return res.status(error.statusCode).json({
        provider: 'coinbase',
        error: error.code,
        message: error.exposeMessage ? error.message : getErrorMessage(error.code),
        fallbackProvider: error.fallbackProvider,
      });
    }

    logger.error('session_unexpected_failure', {
      ipHash: hashForLogs(clientIp),
      walletAddress: maskWalletAddress(parsedBody.data.walletAddress),
      assetIntent: parsedBody.data.preferredAssetIntent,
      error,
    });

    return res.status(500).json({
      provider: 'coinbase',
      error: 'INTERNAL_ERROR',
      message: 'Unable to create Coinbase session token.',
      fallbackProvider: 'moonpay',
    });
  }
}
