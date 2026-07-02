import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import {
  CoinbaseOnrampError,
  CoinbaseOnrampService,
  type CoinbaseAssetIntent,
  type CoinbaseBuyConfigCountry,
  type CoinbaseBuyOptionsPaymentCurrency,
  type CoinbaseBuyOptionsPurchaseCurrency,
  maskWalletAddress,
} from '@/services/coinbase-onramp-service';
import {
  createOnrampRequestLogger,
  hashForLogs,
} from '@/lib/onramp-logging';
import { getTrustedClientIp } from '@/lib/trusted-client-ip';

type SupportedAsset = {
  intent: CoinbaseAssetIntent;
  symbol: 'SUI' | 'USDC';
  network: 'sui';
  assetId?: string;
  iconUrl?: string;
};

type PaymentMethod = {
  id: string;
  min: string | null;
  max: string | null;
};

type OptionsSuccessResponse = {
  provider: 'coinbase';
  eligible: boolean;
  country: string;
  subdivision?: string;
  supportedAssets: SupportedAsset[];
  supportedIntents: CoinbaseAssetIntent[];
  paymentMethods: PaymentMethod[];
  fallbackProvider: 'moonpay' | null;
  reasonCode?: string;
  message?: string;
};

type OptionsErrorResponse = {
  provider: 'coinbase';
  error: string;
  message: string;
  fallbackProvider: 'moonpay' | null;
};

type CachedOptionsValue = {
  expiresAt: number;
  data: OptionsSuccessResponse;
};

const CACHE_TTL_MS = 5 * 60 * 1000;
const OPTIONS_TIMEOUT_MS = 5000;
const OPTIONS_RETRIES = 1;
const REQUESTS_PER_MINUTE_PER_IP = 20;
const REQUESTS_PER_DAY_PER_IP = 800;
const REQUESTS_PER_MINUTE_PER_WALLET = 40;
const REQUESTS_PER_DAY_PER_WALLET = 200;
const MINUTE_WINDOW_MS = 60_000;
const DAY_WINDOW_MS = 24 * 60 * 60 * 1000;

const optionsCache = new Map<string, CachedOptionsValue>();
const rateLimitByIpPerMinute = new Map<string, { count: number; resetAt: number }>();
const rateLimitByIpPerDay = new Map<string, { count: number; resetAt: number }>();
const rateLimitByWalletPerMinute = new Map<string, { count: number; resetAt: number }>();
const rateLimitByWalletPerDay = new Map<string, { count: number; resetAt: number }>();

const optionsQuerySchema = z.object({
  walletAddress: z
    .string()
    .trim()
    .regex(/^0x[a-fA-F0-9]{1,64}$/, 'Invalid Sui wallet address format'),
  country: z.string().trim().toUpperCase().length(2).optional().default('US'),
  subdivision: z.string().trim().toUpperCase().min(2).max(3).optional(),
});

function firstQueryValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}


function checkRateLimit(
  store: Map<string, { count: number; resetAt: number }>,
  key: string,
  maxRequests: number,
  windowMs: number,
): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
  const now = Date.now();
  const existing = store.get(key);

  if (!existing || existing.resetAt <= now) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true };
  }

  if (existing.count >= maxRequests) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
    };
  }

  existing.count += 1;
  return { allowed: true };
}

function getHeaderValue(req: NextApiRequest, header: string): string | undefined {
  const value = req.headers[header];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function inferCountry(req: NextApiRequest): string {
  const candidates = [
    getHeaderValue(req, 'x-user-country'),
    getHeaderValue(req, 'x-vercel-ip-country'),
    getHeaderValue(req, 'cf-ipcountry'),
    getHeaderValue(req, 'x-country'),
  ];

  for (const candidate of candidates) {
    if (candidate && candidate.trim().length === 2) {
      return candidate.trim().toUpperCase();
    }
  }

  return 'US';
}

function inferSubdivision(req: NextApiRequest): string | undefined {
  const candidates = [
    getHeaderValue(req, 'x-user-subdivision'),
    getHeaderValue(req, 'x-vercel-ip-country-region'),
    getHeaderValue(req, 'x-region'),
  ];

  for (const candidate of candidates) {
    const normalized = candidate?.trim().toUpperCase();
    if (normalized && normalized.length >= 2 && normalized.length <= 3) {
      return normalized;
    }
  }

  return undefined;
}

function setCommonHeaders(res: NextApiResponse): void {
  res.setHeader('Cache-Control', 'private, max-age=60');
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
      // Invalid origin will be rejected below.
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
    'Content-Type, Authorization, X-Correlation-Id, X-Request-Id',
  );
  res.setHeader('Access-Control-Expose-Headers', 'X-Correlation-Id');
  res.setHeader('Access-Control-Max-Age', '600');
  return true;
}

function getCacheKey(
  walletAddress: string,
  country: string,
  subdivision?: string,
): string {
  return `${walletAddress}:${country}:${subdivision ?? ''}`;
}

function getCachedOptions(
  key: string,
): OptionsSuccessResponse | null {
  const cached = optionsCache.get(key);
  if (!cached) {
    return null;
  }
  if (cached.expiresAt <= Date.now()) {
    optionsCache.delete(key);
    return null;
  }
  return cached.data;
}

function setCachedOptions(
  key: string,
  data: OptionsSuccessResponse,
): void {
  optionsCache.set(key, {
    data,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

function normalizeCountryConfig(
  countryConfig: CoinbaseBuyConfigCountry | undefined,
): {
  subdivisionAllowed: (subdivision: string | undefined) => boolean;
  paymentMethodIds: string[];
} {
  const subdivisionSet = new Set(
    (countryConfig?.subdivisions ?? [])
      .map((value) => value.trim().toUpperCase())
      .filter(Boolean),
  );

  const paymentMethodIds = (countryConfig?.payment_methods ?? [])
    .map((method) => method.id?.trim().toUpperCase())
    .filter((value): value is string => Boolean(value));

  return {
    subdivisionAllowed: (subdivision) => {
      if (!subdivision) {
        return true;
      }
      if (subdivisionSet.size === 0) {
        return true;
      }
      return subdivisionSet.has(subdivision);
    },
    paymentMethodIds,
  };
}

function isSuiNetwork(network: { name?: string; display_name?: string }): boolean {
  const value = `${network.name ?? ''} ${network.display_name ?? ''}`.toLowerCase();
  return value.includes('sui');
}

function normalizeSupportedAssets(
  purchaseCurrencies: CoinbaseBuyOptionsPurchaseCurrency[] | undefined,
): SupportedAsset[] {
  const byIntent = new Map<CoinbaseAssetIntent, SupportedAsset>();

  for (const currency of purchaseCurrencies ?? []) {
    const symbol = currency.symbol?.trim().toUpperCase();
    if (symbol !== 'SUI' && symbol !== 'USDC') {
      continue;
    }

    const hasSuiNetwork = (currency.networks ?? []).some((network) =>
      isSuiNetwork(network),
    );
    if (!hasSuiNetwork) {
      continue;
    }

    const intent: CoinbaseAssetIntent =
      symbol === 'SUI' ? 'SUI' : 'USDC_ON_SUI';
    if (byIntent.has(intent)) {
      continue;
    }

    byIntent.set(intent, {
      intent,
      symbol,
      network: 'sui',
      assetId: currency.id,
      iconUrl: currency.icon_url,
    });
  }

  return Array.from(byIntent.values());
}

function normalizePaymentMethods(
  paymentCurrencies: CoinbaseBuyOptionsPaymentCurrency[] | undefined,
  configPaymentMethodIds: string[],
): PaymentMethod[] {
  const methods = new Map<string, PaymentMethod>();

  for (const paymentCurrency of paymentCurrencies ?? []) {
    const limitMethods = (paymentCurrency.limits ?? [])
      .map((limit) => limit.id?.trim().toUpperCase())
      .filter((value): value is string => Boolean(value));
    const explicitMethods = (paymentCurrency.payment_methods ?? [])
      .map((method) => method.id?.trim().toUpperCase())
      .filter((value): value is string => Boolean(value));
    const methodIds = [...new Set([...limitMethods, ...explicitMethods])];

    for (const methodId of methodIds) {
      const existing = methods.get(methodId);
      const matchingLimits = (paymentCurrency.limits ?? []).filter(
        (limit) => (limit.id?.trim().toUpperCase() ?? '') === methodId,
      );
      const min = matchingLimits
        .map((limit) => limit.min)
        .find((value) => value !== undefined) ?? null;
      const max = matchingLimits
        .map((limit) => limit.max)
        .find((value) => value !== undefined) ?? null;

      if (!existing) {
        methods.set(methodId, { id: methodId, min, max });
      } else {
        methods.set(methodId, {
          id: methodId,
          min: existing.min ?? min,
          max: existing.max ?? max,
        });
      }
    }
  }

  if (methods.size === 0) {
    for (const methodId of configPaymentMethodIds) {
      methods.set(methodId, {
        id: methodId,
        min: null,
        max: null,
      });
    }
  }

  return Array.from(methods.values());
}

function buildUnsupportedResponse(
  country: string,
  subdivision: string | undefined,
  reasonCode: string,
  message: string,
): OptionsSuccessResponse {
  return {
    provider: 'coinbase',
    eligible: false,
    country,
    subdivision,
    supportedAssets: [],
    supportedIntents: [],
    paymentMethods: [],
    fallbackProvider: 'moonpay',
    reasonCode,
    message,
  };
}

function respondRateLimited(
  res: NextApiResponse<OptionsSuccessResponse | OptionsErrorResponse>,
  retryAfterSeconds: number,
) {
  res.setHeader('Retry-After', String(retryAfterSeconds));
  return res.status(429).json({
    provider: 'coinbase',
    error: 'RATE_LIMITED',
    message: 'Too many requests. Please try again shortly.',
    fallbackProvider: 'moonpay',
  });
}

/**
 * Coinbase buy options endpoint for frontend eligibility checks.
 *
 * Request (GET query):
 * - walletAddress: Sui wallet address (required)
 * - country: ISO 3166-1 alpha-2 (optional, inferred from headers when absent)
 * - subdivision: ISO 3166-2 region for country (optional, inferred from headers when absent)
 *
 * Response:
 * - eligible + normalized supported assets/intents restricted to SUI and USDC on Sui.
 * - returns explicit fallback metadata for MoonPay when unsupported.
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<OptionsSuccessResponse | OptionsErrorResponse>,
) {
  setCommonHeaders(res);
  const logger = createOnrampRequestLogger(
    req,
    res,
    '/api/onramp/coinbase/options',
  );

  if (!allowOrigin(req, res)) {
    logger.warn('options_cors_forbidden', {
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
    logger.info('options_preflight');
    return res.status(204).end();
  }

  if (req.method !== 'GET') {
    logger.warn('options_method_not_allowed', {
      method: req.method,
    });
    return res.status(405).json({
      provider: 'coinbase',
      error: 'METHOD_NOT_ALLOWED',
      message: 'Method not allowed.',
      fallbackProvider: 'moonpay',
    });
  }

  const ip = getTrustedClientIp(req);
  if (!ip) {
    logger.warn('options_ip_missing');
    return res.status(400).json({
      provider: 'coinbase',
      error: 'IP_REQUIRED',
      message: 'Unable to determine client IP.',
      fallbackProvider: 'moonpay',
    });
  }

  const ipPerMinuteLimit = checkRateLimit(
    rateLimitByIpPerMinute,
    ip,
    REQUESTS_PER_MINUTE_PER_IP,
    MINUTE_WINDOW_MS,
  );
  if (!ipPerMinuteLimit.allowed) {
    logger.warn('options_rate_limit_exceeded', {
      scope: 'ip_per_minute',
      ipHash: hashForLogs(ip),
      retryAfterSeconds: ipPerMinuteLimit.retryAfterSeconds,
    });
    return respondRateLimited(res, ipPerMinuteLimit.retryAfterSeconds);
  }

  const ipPerDayLimit = checkRateLimit(
    rateLimitByIpPerDay,
    ip,
    REQUESTS_PER_DAY_PER_IP,
    DAY_WINDOW_MS,
  );
  if (!ipPerDayLimit.allowed) {
    logger.warn('options_rate_limit_exceeded', {
      scope: 'ip_per_day',
      ipHash: hashForLogs(ip),
      retryAfterSeconds: ipPerDayLimit.retryAfterSeconds,
    });
    return respondRateLimited(res, ipPerDayLimit.retryAfterSeconds);
  }

  const parsedQuery = optionsQuerySchema.safeParse({
    walletAddress: firstQueryValue(req.query.walletAddress as string | string[]),
    country:
      firstQueryValue(req.query.country as string | string[]) ?? inferCountry(req),
    subdivision:
      firstQueryValue(req.query.subdivision as string | string[]) ??
      inferSubdivision(req),
  });

  if (!parsedQuery.success) {
    logger.warn('options_validation_failed', {
      ipHash: hashForLogs(ip),
    });
    return res.status(400).json({
      provider: 'coinbase',
      error: 'VALIDATION_ERROR',
      message: 'Invalid options query.',
      fallbackProvider: 'moonpay',
    });
  }

  const { walletAddress, country, subdivision } = parsedQuery.data;
  const walletPerMinuteLimit = checkRateLimit(
    rateLimitByWalletPerMinute,
    walletAddress.toLowerCase(),
    REQUESTS_PER_MINUTE_PER_WALLET,
    MINUTE_WINDOW_MS,
  );
  if (!walletPerMinuteLimit.allowed) {
    logger.warn('options_rate_limit_exceeded', {
      scope: 'wallet_per_minute',
      ipHash: hashForLogs(ip),
      walletAddress: maskWalletAddress(walletAddress),
      retryAfterSeconds: walletPerMinuteLimit.retryAfterSeconds,
    });
    return respondRateLimited(res, walletPerMinuteLimit.retryAfterSeconds);
  }

  const walletPerDayLimit = checkRateLimit(
    rateLimitByWalletPerDay,
    walletAddress.toLowerCase(),
    REQUESTS_PER_DAY_PER_WALLET,
    DAY_WINDOW_MS,
  );
  if (!walletPerDayLimit.allowed) {
    logger.warn('options_rate_limit_exceeded', {
      scope: 'wallet_per_day',
      ipHash: hashForLogs(ip),
      walletAddress: maskWalletAddress(walletAddress),
      retryAfterSeconds: walletPerDayLimit.retryAfterSeconds,
    });
    return respondRateLimited(res, walletPerDayLimit.retryAfterSeconds);
  }

  if (country !== 'US') {
    const unsupported = buildUnsupportedResponse(
      country,
      subdivision,
      'UNSUPPORTED_REGION',
      'Coinbase onramp is currently enabled for US users only.',
    );
    logger.info('options_unsupported_region', {
      ipHash: hashForLogs(ip),
      walletAddress: maskWalletAddress(walletAddress),
      country,
      subdivision,
    });
    return res.status(200).json(unsupported);
  }

  const cacheKey = getCacheKey(walletAddress, country, subdivision);
  const cached = getCachedOptions(cacheKey);
  if (cached) {
    res.setHeader('X-Options-Cache', 'HIT');
    logger.info('options_cache_hit', {
      ipHash: hashForLogs(ip),
      walletAddress: maskWalletAddress(walletAddress),
      country,
      subdivision,
      eligible: cached.eligible,
      supportedIntents: cached.supportedIntents,
    });
    return res.status(200).json(cached);
  }

  try {
    const service = new CoinbaseOnrampService();
    const [config, options] = await Promise.all([
      service.getBuyConfig({
        correlationId: logger.correlationId,
      }),
      service.getBuyOptions({
        country,
        subdivision,
        networks: ['sui'],
        timeoutMs: OPTIONS_TIMEOUT_MS,
        retries: OPTIONS_RETRIES,
        correlationId: logger.correlationId,
      }),
    ]);

    const countryConfig = (config.countries ?? []).find(
      (entry) => entry.id?.trim().toUpperCase() === country,
    );
    const normalizedCountryConfig = normalizeCountryConfig(countryConfig);

    if (!countryConfig) {
      const unsupported = buildUnsupportedResponse(
        country,
        subdivision,
        'UNSUPPORTED_REGION',
        'Coinbase does not support this country for onramp.',
      );
      setCachedOptions(cacheKey, unsupported);
      res.setHeader('X-Options-Cache', 'MISS');
      return res.status(200).json(unsupported);
    }

    if (!normalizedCountryConfig.subdivisionAllowed(subdivision)) {
      const unsupported = buildUnsupportedResponse(
        country,
        subdivision,
        'UNSUPPORTED_SUBDIVISION',
        'Coinbase onramp is unavailable for this region.',
      );
      setCachedOptions(cacheKey, unsupported);
      res.setHeader('X-Options-Cache', 'MISS');
      return res.status(200).json(unsupported);
    }

    const supportedAssets = normalizeSupportedAssets(options.purchase_currencies);
    const paymentMethods = normalizePaymentMethods(
      options.payment_currencies,
      normalizedCountryConfig.paymentMethodIds,
    );
    const supportedIntents = supportedAssets.map((asset) => asset.intent);

    const response: OptionsSuccessResponse = {
      provider: 'coinbase',
      eligible: supportedAssets.length > 0,
      country,
      subdivision,
      supportedAssets,
      supportedIntents,
      paymentMethods,
      fallbackProvider: supportedAssets.length > 0 ? null : 'moonpay',
      reasonCode:
        supportedAssets.length > 0 ? undefined : 'UNSUPPORTED_ASSET_OR_NETWORK',
      message:
        supportedAssets.length > 0
          ? undefined
          : 'SUI and USDC on Sui are currently unavailable for this user context.',
    };

    setCachedOptions(cacheKey, response);
    res.setHeader('X-Options-Cache', 'MISS');

    logger.info('options_resolved', {
      ipHash: hashForLogs(ip),
      walletAddress: maskWalletAddress(walletAddress),
      country,
      subdivision,
      eligible: response.eligible,
      supportedIntents,
    });

    return res.status(200).json(response);
  } catch (error) {
    if (error instanceof CoinbaseOnrampError) {
      logger.error('options_failed', {
        code: error.code,
        statusCode: error.statusCode,
        ipHash: hashForLogs(ip),
        walletAddress: maskWalletAddress(walletAddress),
        country,
        subdivision,
      });

      return res.status(error.statusCode).json({
        provider: 'coinbase',
        error: error.code,
        message: 'Coinbase options are currently unavailable.',
        fallbackProvider: error.fallbackProvider,
      });
    }

    logger.error('options_unexpected_failure', {
      ipHash: hashForLogs(ip),
      walletAddress: maskWalletAddress(walletAddress),
      country,
      subdivision,
      error,
    });

    return res.status(500).json({
      provider: 'coinbase',
      error: 'INTERNAL_ERROR',
      message: 'Unable to load Coinbase options.',
      fallbackProvider: 'moonpay',
    });
  }
}
