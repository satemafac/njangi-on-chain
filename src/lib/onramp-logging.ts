import { createHash, randomUUID } from 'crypto';
import type { NextApiRequest, NextApiResponse } from 'next';

type LogLevel = 'info' | 'warn' | 'error';

interface LogRecord {
  timestamp: string;
  level: LogLevel;
  service: 'coinbase-onramp-api';
  endpoint: string;
  event: string;
  correlationId: string;
  request: {
    method: string;
    path: string;
  };
  metadata?: Record<string, unknown>;
}

interface LoggerLike {
  info: (event: string, metadata?: Record<string, unknown>) => void;
  warn: (event: string, metadata?: Record<string, unknown>) => void;
  error: (event: string, metadata?: Record<string, unknown>) => void;
  correlationId: string;
}

const CORRELATION_HEADER = 'x-correlation-id';
const REQUEST_ID_HEADER = 'x-request-id';

const SENSITIVE_KEY_PATTERN =
  /(token|secret|signature|authorization|api[_-]?key|private[_-]?key|password|jwt|session[_-]?token)/i;

const MAX_UNMASKED_STRING_LENGTH = 80;

function getHeaderValue(
  req: NextApiRequest,
  header: string,
): string | undefined {
  const value = req.headers[header];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function resolveCorrelationId(req: NextApiRequest): string {
  const provided =
    getHeaderValue(req, CORRELATION_HEADER) ?? getHeaderValue(req, REQUEST_ID_HEADER);
  if (provided && provided.trim()) {
    return provided.trim();
  }
  return randomUUID();
}

function maskLongString(value: string): string {
  if (value.length <= MAX_UNMASKED_STRING_LENGTH) {
    return value;
  }
  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}

export function maskWalletAddressForLogs(walletAddress: string): string {
  if (!walletAddress || walletAddress.length < 14) {
    return walletAddress;
  }
  return `${walletAddress.slice(0, 8)}...${walletAddress.slice(-4)}`;
}

export function hashForLogs(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

export function redactSensitiveData(value: unknown, keyHint?: string): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (keyHint && SENSITIVE_KEY_PATTERN.test(keyHint)) {
    return '***';
  }

  if (typeof value === 'string') {
    if (/^0x[a-fA-F0-9]{16,}$/.test(value)) {
      return maskWalletAddressForLogs(value);
    }
    if (/sk_[A-Za-z0-9]+/.test(value) || /pk_[A-Za-z0-9]+/.test(value)) {
      return '***';
    }
    if (value.length > MAX_UNMASKED_STRING_LENGTH) {
      return maskLongString(value);
    }
    return value;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: maskLongString(value.message),
    };
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveData(item));
  }

  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(
      value as Record<string, unknown>,
    )) {
      output[key] = redactSensitiveData(nestedValue, key);
    }
    return output;
  }

  return String(value);
}

function writeLog(level: LogLevel, record: LogRecord): void {
  const serialized = JSON.stringify(record);
  if (level === 'error') {
    console.error(serialized);
    return;
  }
  if (level === 'warn') {
    console.warn(serialized);
    return;
  }
  console.info(serialized);
}

export function createOnrampRequestLogger(
  req: NextApiRequest,
  res: NextApiResponse,
  endpoint: string,
): LoggerLike {
  const correlationId = resolveCorrelationId(req);
  res.setHeader(CORRELATION_HEADER, correlationId);

  const requestPath = req.url ?? endpoint;
  const requestMethod = req.method ?? 'UNKNOWN';

  const log = (level: LogLevel, event: string, metadata?: Record<string, unknown>) => {
    const record: LogRecord = {
      timestamp: new Date().toISOString(),
      level,
      service: 'coinbase-onramp-api',
      endpoint,
      event,
      correlationId,
      request: {
        method: requestMethod,
        path: requestPath,
      },
      metadata: metadata
        ? (redactSensitiveData(metadata) as Record<string, unknown>)
        : undefined,
    };

    writeLog(level, record);
  };

  return {
    info: (event, metadata) => log('info', event, metadata),
    warn: (event, metadata) => log('warn', event, metadata),
    error: (event, metadata) => log('error', event, metadata),
    correlationId,
  };
}

