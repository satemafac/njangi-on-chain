import type { NextApiRequest, NextApiResponse } from 'next';
import { isIP } from 'node:net';
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

function normalizeIp(rawIp: string | undefined): string | null {
  if (!rawIp) {
    return null;
  }

  const trimmed = rawIp.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed === '::1') {
    return '127.0.0.1';
  }

  if (trimmed.startsWith('::ffff:')) {
    return trimmed.replace('::ffff:', '');
  }

  return trimmed;
}

function parseIpCandidate(rawValue: string): string | null {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    return null;
  }

  const bracketedIpv6 = trimmed.match(/^\[(.+)](?::\d+)?$/);
  if (bracketedIpv6?.[1]) {
    return normalizeIp(bracketedIpv6[1]);
  }

  const ipv4WithPort = trimmed.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
  if (ipv4WithPort?.[1]) {
    return normalizeIp(ipv4WithPort[1]);
  }

  return normalizeIp(trimmed);
}

function isPrivateIpv4(ip: string): boolean {
  const segments = ip.split('.').map((segment) => Number(segment));
  if (
    segments.length !== 4 ||
    segments.some((segment) => !Number.isInteger(segment) || segment < 0 || segment > 255)
  ) {
    return false;
  }

  const [first, second] = segments;
  if (first === 10 || first === 127 || first === 0) {
    return true;
  }
  if (first === 169 && second === 254) {
    return true;
  }
  if (first === 172 && second >= 16 && second <= 31) {
    return true;
  }
  if (first === 192 && second === 168) {
    return true;
  }
  if (first === 100 && second >= 64 && second <= 127) {
    return true;
  }

  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === '::1' || normalized === '::') {
    return true;
  }
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) {
    return true;
  }
  if (
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb')
  ) {
    return true;
  }

  return false;
}

function isPrivateIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) {
    return isPrivateIpv4(ip);
  }
  if (version === 6) {
    return isPrivateIpv6(ip);
  }
  return false;
}

function getHeaderValue(req: NextApiRequest, headerName: string): string | undefined {
  const value = req.headers[headerName];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function readForwardedClientIp(req: NextApiRequest): string | null {
  const headerCandidates = [
    getHeaderValue(req, 'x-forwarded-for'),
    getHeaderValue(req, 'x-real-ip'),
    getHeaderValue(req, 'cf-connecting-ip'),
    getHeaderValue(req, 'fly-client-ip'),
    getHeaderValue(req, 'x-client-ip'),
  ];

  for (const candidate of headerCandidates) {
    if (!candidate) {
      continue;
    }

    const parts = candidate.split(',').map((part) => part.trim()).filter(Boolean);
    for (const part of parts) {
      const parsed = parseIpCandidate(part);
      if (parsed && isIP(parsed) !== 0 && !isPrivateIp(parsed)) {
        return parsed;
      }
    }
  }

  return null;
}

function getTrustedClientIp(req: NextApiRequest): string | null {
  const socketIp = parseIpCandidate(req.socket?.remoteAddress ?? '');
  if (socketIp && isIP(socketIp) !== 0 && !isPrivateIp(socketIp)) {
    return socketIp;
  }

  // In proxy environments (e.g., Heroku), the socket IP is often private.
  // Prefer a forwarded public client IP in that case.
  const forwardedIp = readForwardedClientIp(req);
  if (forwardedIp) {
    return forwardedIp;
  }

  return socketIp && isIP(socketIp) !== 0 ? socketIp : null;
}

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
