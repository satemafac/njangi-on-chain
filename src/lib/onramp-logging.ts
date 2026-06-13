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

// Customer PII carried by ramp webhook payloads (MoonPay/Transak embed
// customer name, phone, date of birth, postal address, identity-document
// references). These are dropped entirely at the persistence boundary —
// reconciliation only needs ids, statuses, and amounts (2026-06 GTM audit).
// Wallet-address keys are deliberately NOT matched here: they fall through
// to the 0x-hex masking below so correlation stays possible.
const PII_KEY_PATTERN = new RegExp(
  [
    '^(first|last|middle|given|family|legal|full)?[_-]?name$',
    'surname',
    'phone|mobile|msisdn|whatsapp',
    '^dob$|date[_-]?of[_-]?birth|birth[_-]?(date|day)',
    'passport|national[_-]?id|document[_-]?(number|id)|ssn|tax[_-]?id',
    '^(address|street([_-]?(line|address)[0-9]*)?|sub[_-]?street|address[_-]?line[0-9]*|city|town|post[_-]?code|postal[_-]?code|zip([_-]?code)?)$',
  ].join('|'),
  'i',
);

const EMAIL_KEY_PATTERN = /email/i;

const EMAIL_VALUE_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

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

/**
 * Masks an email address to `e***@domain` so persisted logs never carry a
 * customer's full address while support can still correlate the domain.
 */
export function maskEmailForLogs(email: string): string {
  const atIndex = email.indexOf('@');
  if (atIndex <= 0 || atIndex === email.length - 1) {
    return '***';
  }
  return `${email[0]}***@${email.slice(atIndex + 1)}`;
}

export function redactSensitiveData(value: unknown, keyHint?: string): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (keyHint) {
    if (SENSITIVE_KEY_PATTERN.test(keyHint)) {
      return '***';
    }
    if (EMAIL_KEY_PATTERN.test(keyHint)) {
      return typeof value === 'string' ? maskEmailForLogs(value) : '***';
    }
    if (PII_KEY_PATTERN.test(keyHint) && !/wallet/i.test(keyHint)) {
      return '***';
    }
  }

  if (typeof value === 'string') {
    if (EMAIL_VALUE_PATTERN.test(value)) {
      return maskEmailForLogs(value);
    }
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

export type RampProvider = 'coinbase' | 'moonpay' | 'transak';

export interface RampEvent {
  provider: RampProvider;
  payload: Record<string, unknown>;
  receivedAt: Date;
}

/**
 * Persists a ramp webhook event to the audit log. Phase 1 just writes to
 * the structured logger; Phase 2 hooks this into Postgres for daily
 * reconciliation against partner settlement reports. PII is redacted at
 * this persistence boundary: emails are masked to `e***@domain`, customer
 * names/phones/DOB/postal addresses/document references are dropped, while
 * correlation ids, statuses, amounts, and masked wallet addresses are kept
 * for reconciliation.
 */
export async function recordOnrampEvent(event: RampEvent): Promise<void> {
  const sanitized = redactSensitiveData(event.payload) as Record<string, unknown>;
  const record: LogRecord = {
    timestamp: event.receivedAt.toISOString(),
    level: 'info',
    service: 'coinbase-onramp-api',
    endpoint: `/${event.provider}/webhook`,
    event: 'ramp_webhook_event',
    correlationId: randomUUID(),
    request: { method: 'POST', path: `/${event.provider}/webhook` },
    metadata: { provider: event.provider, payload: sanitized },
  };
  writeLog('info', record);
}
