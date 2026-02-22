import { createPrivateKey, randomBytes } from 'node:crypto';
import { importJWK, importPKCS8, SignJWT, type JWTPayload } from 'jose';
import type { CoinbaseAssetIntent } from '@/types/coinbase-onramp';

export type { CoinbaseAssetIntent } from '@/types/coinbase-onramp';

export interface CreateCoinbaseSessionInput {
  walletAddress: string;
  preferredAssetIntent: CoinbaseAssetIntent;
  clientIp: string;
  correlationId?: string;
}

export interface CoinbaseSessionTokenResult {
  provider: 'coinbase';
  token: string;
  channelId?: string;
  assetIntent: CoinbaseAssetIntent;
}

interface CoinbaseSessionTokenApiResponse {
  token?: string;
  channel_id?: string;
  data?: {
    token?: string;
    channel_id?: string;
  };
}

export interface CoinbaseBuyConfigCountry {
  id?: string;
  payment_methods?: Array<{ id?: string }>;
  subdivisions?: string[];
}

export interface CoinbaseBuyConfigResponse {
  countries?: CoinbaseBuyConfigCountry[];
}

export interface CoinbaseBuyOptionsPaymentCurrencyLimit {
  id?: string;
  min?: string;
  max?: string;
}

export interface CoinbaseBuyOptionsPaymentCurrency {
  id?: string;
  limits?: CoinbaseBuyOptionsPaymentCurrencyLimit[];
  payment_methods?: Array<{ id?: string }>;
}

export interface CoinbaseBuyOptionsNetwork {
  chain_id?: number;
  contract_address?: string;
  display_name?: string;
  name?: string;
}

export interface CoinbaseBuyOptionsPurchaseCurrency {
  icon_url?: string;
  id?: string;
  name?: string;
  symbol?: string;
  networks?: CoinbaseBuyOptionsNetwork[];
}

export interface CoinbaseBuyOptionsResponse {
  payment_currencies?: CoinbaseBuyOptionsPaymentCurrency[];
  purchase_currencies?: CoinbaseBuyOptionsPurchaseCurrency[];
}

interface CoinbaseServiceConfig {
  apiKeyId: string;
  apiKeySecret: string;
  baseUrl: string;
  jwtExpiresInSeconds: number;
  requestTimeoutMs: number;
}

interface GenerateJwtOptions {
  apiKeyId: string;
  apiKeySecret: string;
  requestMethod: string;
  requestHost: string;
  requestPath: string;
  expiresIn?: number;
}

interface CdpSdkAuthModule {
  generateJwt: (options: GenerateJwtOptions) => Promise<string>;
}

const COINBASE_DEFAULT_BASE_URL = 'https://api.developer.coinbase.com';
const COINBASE_SESSION_TOKEN_PATH = '/onramp/v1/token';
const COINBASE_BUY_CONFIG_PATH = '/onramp/v1/buy/config';
const COINBASE_BUY_OPTIONS_PATH = '/onramp/v1/buy/options';
const DEFAULT_JWT_EXPIRES_IN_SECONDS = 120;
const DEFAULT_REQUEST_TIMEOUT_MS = 10000;
const COINBASE_AUDIENCE = ['cdp_service'];

const ASSETS_BY_INTENT: Record<CoinbaseAssetIntent, string[]> = {
  SUI: ['SUI'],
  USDC_ON_SUI: ['USDC'],
};

let cachedCdpGenerateJwt:
  | CdpSdkAuthModule['generateJwt']
  | null
  | undefined;

export class CoinbaseOnrampError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly fallbackProvider: 'moonpay' | null;
  readonly exposeMessage: boolean;

  constructor(
    message: string,
    code: string,
    statusCode: number,
    options?: {
      fallbackProvider?: 'moonpay' | null;
      exposeMessage?: boolean;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = 'CoinbaseOnrampError';
    this.code = code;
    this.statusCode = statusCode;
    this.fallbackProvider = options?.fallbackProvider ?? 'moonpay';
    this.exposeMessage = options?.exposeMessage ?? false;

    if (options?.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

function normalizeKeySecret(secret: string): string {
  if (secret.includes('\\n')) {
    return secret.replace(/\\n/g, '\n');
  }
  return secret;
}

async function loadCdpGenerateJwt():
  Promise<CdpSdkAuthModule['generateJwt'] | null> {
  if (cachedCdpGenerateJwt !== undefined) {
    return cachedCdpGenerateJwt;
  }

  try {
    const moduleName = '@coinbase/cdp-sdk/auth';
    const mod = (await import(moduleName)) as CdpSdkAuthModule;
    if (typeof mod.generateJwt === 'function') {
      cachedCdpGenerateJwt = mod.generateJwt;
      return cachedCdpGenerateJwt;
    }
  } catch {
    // Optional dependency; fallback handled by JOSE path.
  }

  cachedCdpGenerateJwt = null;
  return null;
}

function isValidEcKey(secret: string): boolean {
  try {
    const key = createPrivateKey(secret);
    return key.asymmetricKeyType === 'ec';
  } catch {
    return false;
  }
}

function isValidEd25519Key(secret: string): boolean {
  try {
    const decoded = Buffer.from(secret, 'base64');
    return decoded.length === 64;
  } catch {
    return false;
  }
}

function generateNonce(): string {
  return randomBytes(16).toString('hex');
}

async function buildEcJwt(
  privateKey: string,
  keyId: string,
  claims: JWTPayload,
  issuedAt: number,
  expiresIn: number,
  nonce: string,
): Promise<string> {
  const keyObj = createPrivateKey(privateKey);
  const pkcs8Pem = keyObj.export({ type: 'pkcs8', format: 'pem' }).toString();
  const key = await importPKCS8(pkcs8Pem, 'ES256');

  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'ES256', kid: keyId, typ: 'JWT', nonce })
    .setIssuedAt(issuedAt)
    .setNotBefore(issuedAt)
    .setExpirationTime(issuedAt + expiresIn)
    .sign(key);
}

async function buildEd25519Jwt(
  privateKey: string,
  keyId: string,
  claims: JWTPayload,
  issuedAt: number,
  expiresIn: number,
  nonce: string,
): Promise<string> {
  const decoded = Buffer.from(privateKey, 'base64');
  if (decoded.length !== 64) {
    throw new Error('Invalid Ed25519 key length');
  }

  const seed = decoded.subarray(0, 32);
  const publicKey = decoded.subarray(32);
  const jwk = {
    kty: 'OKP',
    crv: 'Ed25519',
    d: seed.toString('base64url'),
    x: publicKey.toString('base64url'),
  };
  const key = await importJWK(jwk, 'EdDSA');

  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'EdDSA', kid: keyId, typ: 'JWT', nonce })
    .setIssuedAt(issuedAt)
    .setNotBefore(issuedAt)
    .setExpirationTime(issuedAt + expiresIn)
    .sign(key);
}

async function generateJwtWithJose(options: GenerateJwtOptions): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const expiresIn = options.expiresIn ?? DEFAULT_JWT_EXPIRES_IN_SECONDS;
  const claims: JWTPayload = {
    sub: options.apiKeyId,
    iss: 'cdp',
    aud: COINBASE_AUDIENCE,
    uris: [
      `${options.requestMethod} ${options.requestHost}${options.requestPath}`,
    ],
  };
  const nonce = generateNonce();

  if (isValidEcKey(options.apiKeySecret)) {
    return buildEcJwt(
      options.apiKeySecret,
      options.apiKeyId,
      claims,
      now,
      expiresIn,
      nonce,
    );
  }

  if (isValidEd25519Key(options.apiKeySecret)) {
    return buildEd25519Jwt(
      options.apiKeySecret,
      options.apiKeyId,
      claims,
      now,
      expiresIn,
      nonce,
    );
  }

  throw new Error('Invalid API key secret format');
}

async function generateCoinbaseJwt(options: GenerateJwtOptions): Promise<string> {
  const cdpGenerateJwt = await loadCdpGenerateJwt();
  if (cdpGenerateJwt) {
    return cdpGenerateJwt(options);
  }

  return generateJwtWithJose(options);
}

function loadConfigFromEnv(): CoinbaseServiceConfig {
  const apiKeyId = process.env.CDP_API_KEY_ID ?? '';
  const apiKeySecret = normalizeKeySecret(process.env.CDP_API_KEY_SECRET ?? '');
  const baseUrl =
    process.env.COINBASE_ONRAMP_API_BASE_URL ?? COINBASE_DEFAULT_BASE_URL;
  const jwtExpiresInSeconds = Number(
    process.env.COINBASE_ONRAMP_JWT_EXPIRES_IN_SECONDS ??
      DEFAULT_JWT_EXPIRES_IN_SECONDS,
  );
  const requestTimeoutMs = Number(
    process.env.COINBASE_ONRAMP_REQUEST_TIMEOUT_MS ?? DEFAULT_REQUEST_TIMEOUT_MS,
  );

  if (!apiKeyId || !apiKeySecret) {
    throw new CoinbaseOnrampError(
      'Coinbase credentials are missing on the server',
      'MISSING_COINBASE_CREDENTIALS',
      500,
      { exposeMessage: false, fallbackProvider: 'moonpay' },
    );
  }

  if (!Number.isFinite(jwtExpiresInSeconds) || jwtExpiresInSeconds <= 0) {
    throw new CoinbaseOnrampError(
      'Invalid Coinbase JWT expiration configuration',
      'INVALID_COINBASE_JWT_CONFIG',
      500,
      { exposeMessage: false, fallbackProvider: 'moonpay' },
    );
  }

  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new CoinbaseOnrampError(
      'Invalid Coinbase timeout configuration',
      'INVALID_COINBASE_TIMEOUT_CONFIG',
      500,
      { exposeMessage: false, fallbackProvider: 'moonpay' },
    );
  }

  return {
    apiKeyId,
    apiKeySecret,
    baseUrl,
    jwtExpiresInSeconds,
    requestTimeoutMs,
  };
}

export function maskWalletAddress(walletAddress: string): string {
  if (!walletAddress || walletAddress.length < 14) {
    return walletAddress;
  }
  return `${walletAddress.slice(0, 8)}...${walletAddress.slice(-6)}`;
}

function parseSessionTokenResponse(
  responseBody: string,
): CoinbaseSessionTokenApiResponse | null {
  if (!responseBody) {
    return null;
  }

  try {
    return JSON.parse(responseBody) as CoinbaseSessionTokenApiResponse;
  } catch {
    return null;
  }
}

export class CoinbaseOnrampService {
  private readonly config: CoinbaseServiceConfig;

  constructor(config?: CoinbaseServiceConfig) {
    this.config = config ?? loadConfigFromEnv();
  }

  private async performAuthenticatedRequest(
    method: 'GET' | 'POST',
    path: string,
    options?: {
      query?: Record<string, string | undefined>;
      body?: unknown;
      timeoutMs?: number;
      retries?: number;
      correlationId?: string;
    },
  ): Promise<{ status: number; body: string }> {
    const url = new URL(path, this.config.baseUrl);
    if (options?.query) {
      for (const [key, value] of Object.entries(options.query)) {
        if (value) {
          url.searchParams.set(key, value);
        }
      }
    }

    const jwt = await generateCoinbaseJwt({
      apiKeyId: this.config.apiKeyId,
      apiKeySecret: this.config.apiKeySecret,
      requestMethod: method,
      requestHost: url.host,
      requestPath: url.pathname,
      expiresIn: this.config.jwtExpiresInSeconds,
    });

    const timeoutMs = options?.timeoutMs ?? this.config.requestTimeoutMs;
    const retries = options?.retries ?? 0;

    let attempt = 0;
    for (;;) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(url.toString(), {
          method,
          headers: {
            Authorization: `Bearer ${jwt}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
            ...(options?.correlationId
              ? { 'X-Correlation-Id': options.correlationId }
              : {}),
          },
          body: options?.body ? JSON.stringify(options.body) : undefined,
          signal: controller.signal,
        });

        clearTimeout(timeout);
        const rawBody = await response.text();

        if (!response.ok) {
          if (response.status === 401 || response.status === 403) {
            throw new CoinbaseOnrampError(
              'Coinbase authentication failed',
              'COINBASE_AUTH_FAILED',
              502,
            );
          }

          if (response.status === 429) {
            if (attempt < retries) {
              attempt += 1;
              continue;
            }

            throw new CoinbaseOnrampError(
              'Coinbase rate limit exceeded',
              'COINBASE_RATE_LIMITED',
              503,
            );
          }

          if (response.status >= 500 && response.status < 600 && attempt < retries) {
            attempt += 1;
            continue;
          }

          throw new CoinbaseOnrampError(
            'Coinbase upstream request failed',
            'COINBASE_UPSTREAM_ERROR',
            502,
            { cause: { status: response.status, body: rawBody } },
          );
        }

        return { status: response.status, body: rawBody };
      } catch (error) {
        clearTimeout(timeout);

        if (error instanceof CoinbaseOnrampError) {
          throw error;
        }

        const isAbortError =
          error &&
          typeof error === 'object' &&
          'name' in error &&
          error.name === 'AbortError';

        if (attempt < retries) {
          attempt += 1;
          continue;
        }

        if (isAbortError) {
          throw new CoinbaseOnrampError(
            'Coinbase request timed out',
            'COINBASE_TIMEOUT',
            504,
            { cause: error },
          );
        }

        throw new CoinbaseOnrampError(
          'Unable to reach Coinbase',
          'COINBASE_NETWORK_ERROR',
          503,
          { cause: error },
        );
      }
    }
  }

  async getBuyConfig(input?: {
    correlationId?: string;
  }): Promise<CoinbaseBuyConfigResponse> {
    const response = await this.performAuthenticatedRequest(
      'GET',
      COINBASE_BUY_CONFIG_PATH,
      {
        retries: 1,
        correlationId: input?.correlationId,
      },
    );

    if (!response.body) {
      return {};
    }

    try {
      return JSON.parse(response.body) as CoinbaseBuyConfigResponse;
    } catch (error) {
      throw new CoinbaseOnrampError(
        'Coinbase config response was invalid JSON',
        'COINBASE_INVALID_RESPONSE',
        502,
        { cause: error },
      );
    }
  }

  async getBuyOptions(input: {
    country: string;
    subdivision?: string;
    networks?: string[];
    timeoutMs?: number;
    retries?: number;
    correlationId?: string;
  }): Promise<CoinbaseBuyOptionsResponse> {
    const query: Record<string, string | undefined> = {
      country: input.country,
      subdivision: input.subdivision,
      networks: input.networks?.join(','),
    };

    const response = await this.performAuthenticatedRequest(
      'GET',
      COINBASE_BUY_OPTIONS_PATH,
      {
        query,
        retries: input.retries ?? 1,
        timeoutMs: input.timeoutMs,
        correlationId: input.correlationId,
      },
    );

    if (!response.body) {
      return {};
    }

    try {
      return JSON.parse(response.body) as CoinbaseBuyOptionsResponse;
    } catch (error) {
      throw new CoinbaseOnrampError(
        'Coinbase options response was invalid JSON',
        'COINBASE_INVALID_RESPONSE',
        502,
        { cause: error },
      );
    }
  }

  async createSessionToken(
    input: CreateCoinbaseSessionInput,
  ): Promise<CoinbaseSessionTokenResult> {
    const requestBody = {
      addresses: [
        {
          address: input.walletAddress,
          blockchains: ['sui'],
        },
      ],
      assets: ASSETS_BY_INTENT[input.preferredAssetIntent],
      clientIp: input.clientIp,
    };

    const response = await this.performAuthenticatedRequest(
      'POST',
      COINBASE_SESSION_TOKEN_PATH,
      {
        body: requestBody,
        correlationId: input.correlationId,
      },
    );
    const parsed = parseSessionTokenResponse(response.body);

    const token = parsed?.token ?? parsed?.data?.token;
    const channelId = parsed?.channel_id ?? parsed?.data?.channel_id;

    if (!token) {
      throw new CoinbaseOnrampError(
        'Coinbase response did not include a token',
        'COINBASE_INVALID_RESPONSE',
        502,
      );
    }

    return {
      provider: 'coinbase',
      token,
      channelId: channelId || undefined,
      assetIntent: input.preferredAssetIntent,
    };
  }
}
