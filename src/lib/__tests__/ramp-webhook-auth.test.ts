// ramp-webhook-auth.test.ts — Webhook authentication hardening for the
// fiat-ramp providers (2026-06 GTM audit fixes):
//  - Transak fails CLOSED when TRANSAK_API_SECRET is unset (no dev bypass)
//    and the provider cannot be enabled without its secret.
//  - MoonPay Moonpay-Signature-V2 verification follows the documented
//    scheme (HMAC-SHA256 hex over `${t}.${rawBody}`) with a 5-minute
//    replay window.

import { createHmac } from 'crypto';
import {
  decodeTransakWebhook,
  isTransakEnabled,
  verifyTransakWebhookJwt,
} from '@/services/transak-service';
import {
  MOONPAY_WEBHOOK_REPLAY_TOLERANCE_MS,
  verifyMoonPayWebhookSignature,
} from '@/services/moonpay-service';

const TRANSAK_SECRET = 'transak-partner-secret';
const MOONPAY_WEBHOOK_KEY = 'moonpay-webhook-key';

function makeTransakJwt(
  claims: Record<string, unknown>,
  secret: string,
): string {
  const header = Buffer.from(
    JSON.stringify({ alg: 'HS256', typ: 'JWT' }),
    'utf8',
  ).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString(
    'base64url',
  );
  const signature = createHmac('sha256', secret)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

function moonpaySignatureHeader(
  rawBody: string,
  key: string,
  timestampSeconds: number,
): string {
  const hmac = createHmac('sha256', key)
    .update(`${timestampSeconds}.${rawBody}`)
    .digest('hex');
  return `t=${timestampSeconds},s=${hmac}`;
}

describe('Transak webhook authentication (fail closed)', () => {
  const originalSecret = process.env.TRANSAK_API_SECRET;
  const originalEnabled = process.env.NEXT_PUBLIC_TRANSAK_ENABLED;

  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.TRANSAK_API_SECRET = TRANSAK_SECRET;
    process.env.NEXT_PUBLIC_TRANSAK_ENABLED = 'true';
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.TRANSAK_API_SECRET;
    else process.env.TRANSAK_API_SECRET = originalSecret;
    if (originalEnabled === undefined) {
      delete process.env.NEXT_PUBLIC_TRANSAK_ENABLED;
    } else {
      process.env.NEXT_PUBLIC_TRANSAK_ENABLED = originalEnabled;
    }
  });

  it('rejects every event when TRANSAK_API_SECRET is unset — even a structurally valid JWT', () => {
    const token = makeTransakJwt({ id: 'order-1' }, TRANSAK_SECRET);
    delete process.env.TRANSAK_API_SECRET;

    expect(verifyTransakWebhookJwt(token)).toBe(false);
    // A clear server log explains the fail-closed rejection.
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('TRANSAK_API_SECRET'),
    );
  });

  it('accepts a JWT signed with the configured secret', () => {
    const token = makeTransakJwt(
      { id: 'order-2', exp: Math.floor(Date.now() / 1000) + 600 },
      TRANSAK_SECRET,
    );
    expect(verifyTransakWebhookJwt(token)).toBe(true);
  });

  it('accepts a JWT without an exp claim (signature still required)', () => {
    // Real Transak webhook tokens carry no exp, so rejecting exp-less
    // tokens would kill the integration. Replay of a captured token is
    // contained downstream instead: the payload is signature-bound (only
    // the decoded claims are consumed, never plaintext siblings) and the
    // webhook handler dedupes on the (case id, outcome) transition.
    const token = makeTransakJwt({ id: 'order-3' }, TRANSAK_SECRET);
    expect(verifyTransakWebhookJwt(token)).toBe(true);
  });

  it('rejects a JWT signed with the wrong secret', () => {
    const token = makeTransakJwt({ id: 'order-4' }, 'some-other-secret');
    expect(verifyTransakWebhookJwt(token)).toBe(false);
  });

  it('rejects an expired JWT (replay protection)', () => {
    const token = makeTransakJwt(
      { id: 'order-5', exp: Math.floor(Date.now() / 1000) - 3600 },
      TRANSAK_SECRET,
    );
    expect(verifyTransakWebhookJwt(token)).toBe(false);
  });

  it('rejects missing or malformed tokens', () => {
    expect(verifyTransakWebhookJwt(null)).toBe(false);
    expect(verifyTransakWebhookJwt('')).toBe(false);
    expect(verifyTransakWebhookJwt('only.two')).toBe(false);
  });

  describe('decodeTransakWebhook (verified claims as the only payload source)', () => {
    it('returns the signature-covered claims for a validly signed token', () => {
      const webhookData = {
        id: 'order-77',
        status: 'COMPLETED',
        walletAddress: '0xabc',
      };
      const token = makeTransakJwt(
        { eventID: 'ORDER_COMPLETED', createdAt: '2026-06-12T00:00:00Z', webhookData },
        TRANSAK_SECRET,
      );

      const claims = decodeTransakWebhook(token);
      expect(claims).not.toBeNull();
      expect(claims?.eventID).toBe('ORDER_COMPLETED');
      expect(claims?.createdAt).toBe('2026-06-12T00:00:00Z');
      expect(claims?.webhookData).toEqual(webhookData);
    });

    it('returns null for a token signed with the wrong secret', () => {
      const token = makeTransakJwt(
        { eventID: 'KYC_APPROVED', webhookData: { id: 'order-78' } },
        'some-other-secret',
      );
      expect(decodeTransakWebhook(token)).toBeNull();
    });

    it('returns null when TRANSAK_API_SECRET is unset (fail closed)', () => {
      const token = makeTransakJwt({ eventID: 'ORDER_COMPLETED' }, TRANSAK_SECRET);
      delete process.env.TRANSAK_API_SECRET;
      expect(decodeTransakWebhook(token)).toBeNull();
    });

    it('returns null for an expired token', () => {
      const token = makeTransakJwt(
        {
          eventID: 'ORDER_COMPLETED',
          exp: Math.floor(Date.now() / 1000) - 3600,
        },
        TRANSAK_SECRET,
      );
      expect(decodeTransakWebhook(token)).toBeNull();
    });

    it('returns null when the signed claims segment is not a JSON object', () => {
      // A correctly signed token whose claims decode to a bare string —
      // structurally valid JWT, but not a usable Transak event.
      const header = Buffer.from(
        JSON.stringify({ alg: 'HS256', typ: 'JWT' }),
        'utf8',
      ).toString('base64url');
      const payload = Buffer.from(JSON.stringify('not-an-object'), 'utf8').toString(
        'base64url',
      );
      const signature = createHmac('sha256', TRANSAK_SECRET)
        .update(`${header}.${payload}`)
        .digest('base64url');
      expect(decodeTransakWebhook(`${header}.${payload}.${signature}`)).toBeNull();

      const arrayPayload = Buffer.from(JSON.stringify([1, 2, 3]), 'utf8').toString(
        'base64url',
      );
      const arraySignature = createHmac('sha256', TRANSAK_SECRET)
        .update(`${header}.${arrayPayload}`)
        .digest('base64url');
      expect(
        decodeTransakWebhook(`${header}.${arrayPayload}.${arraySignature}`),
      ).toBeNull();
    });

    it('returns null for missing and malformed tokens', () => {
      expect(decodeTransakWebhook(null)).toBeNull();
      expect(decodeTransakWebhook('')).toBeNull();
      expect(decodeTransakWebhook('only.two')).toBeNull();
    });
  });

  describe('isTransakEnabled gate', () => {
    it('is disabled when the public flag is off', () => {
      process.env.NEXT_PUBLIC_TRANSAK_ENABLED = 'false';
      expect(isTransakEnabled()).toBe(false);
    });

    it('stays disabled when the flag is on but TRANSAK_API_SECRET is unset (fail closed)', () => {
      process.env.NEXT_PUBLIC_TRANSAK_ENABLED = 'true';
      delete process.env.TRANSAK_API_SECRET;

      expect(isTransakEnabled()).toBe(false);
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('TRANSAK_API_SECRET'),
      );
    });

    it('is enabled only when both the flag and the secret are set', () => {
      process.env.NEXT_PUBLIC_TRANSAK_ENABLED = 'true';
      process.env.TRANSAK_API_SECRET = TRANSAK_SECRET;
      expect(isTransakEnabled()).toBe(true);
    });
  });
});

describe('MoonPay webhook signature (Moonpay-Signature-V2)', () => {
  const originalKey = process.env.MOONPAY_WEBHOOK_KEY;
  const rawBody = '{"data":{"id":"case-1","status":"completed"}}';

  beforeEach(() => {
    process.env.MOONPAY_WEBHOOK_KEY = MOONPAY_WEBHOOK_KEY;
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.MOONPAY_WEBHOOK_KEY;
    else process.env.MOONPAY_WEBHOOK_KEY = originalKey;
  });

  it('accepts a signature computed over `${t}.${rawBody}` per the documented scheme', () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const header = moonpaySignatureHeader(
      rawBody,
      MOONPAY_WEBHOOK_KEY,
      nowSeconds,
    );
    expect(verifyMoonPayWebhookSignature(rawBody, header)).toBe(true);
  });

  it('rejects the legacy (incorrect) scheme that signed the raw body without the timestamp prefix', () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const bodyOnlyHmac = createHmac('sha256', MOONPAY_WEBHOOK_KEY)
      .update(rawBody)
      .digest('hex');
    expect(
      verifyMoonPayWebhookSignature(rawBody, `t=${nowSeconds},s=${bodyOnlyHmac}`),
    ).toBe(false);
  });

  it('rejects deliveries outside the 5-minute replay window', () => {
    const staleSeconds =
      Math.floor((Date.now() - MOONPAY_WEBHOOK_REPLAY_TOLERANCE_MS) / 1000) - 60;
    const header = moonpaySignatureHeader(
      rawBody,
      MOONPAY_WEBHOOK_KEY,
      staleSeconds,
    );
    expect(verifyMoonPayWebhookSignature(rawBody, header)).toBe(false);

    // Boundary check with an injected clock: just inside the window passes,
    // just outside fails — same signed payload either way.
    const t = 1_750_000_000;
    const signed = moonpaySignatureHeader(rawBody, MOONPAY_WEBHOOK_KEY, t);
    const insideNow = t * 1000 + MOONPAY_WEBHOOK_REPLAY_TOLERANCE_MS - 1000;
    const outsideNow = t * 1000 + MOONPAY_WEBHOOK_REPLAY_TOLERANCE_MS + 1000;
    expect(verifyMoonPayWebhookSignature(rawBody, signed, insideNow)).toBe(true);
    expect(verifyMoonPayWebhookSignature(rawBody, signed, outsideNow)).toBe(false);
  });

  it('rejects headers missing the timestamp or signature component', () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const hmac = createHmac('sha256', MOONPAY_WEBHOOK_KEY)
      .update(`${nowSeconds}.${rawBody}`)
      .digest('hex');
    expect(verifyMoonPayWebhookSignature(rawBody, `s=${hmac}`)).toBe(false);
    expect(
      verifyMoonPayWebhookSignature(rawBody, `t=${nowSeconds}`),
    ).toBe(false);
    expect(verifyMoonPayWebhookSignature(rawBody, hmac)).toBe(false);
    expect(verifyMoonPayWebhookSignature(rawBody, null)).toBe(false);
  });

  it('rejects a tampered body', () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const header = moonpaySignatureHeader(
      rawBody,
      MOONPAY_WEBHOOK_KEY,
      nowSeconds,
    );
    expect(
      verifyMoonPayWebhookSignature(
        '{"data":{"id":"case-1","status":"failed"}}',
        header,
      ),
    ).toBe(false);
  });

  it('throws (fails closed loudly) when MOONPAY_WEBHOOK_KEY is unset', () => {
    delete process.env.MOONPAY_WEBHOOK_KEY;
    const nowSeconds = Math.floor(Date.now() / 1000);
    expect(() =>
      verifyMoonPayWebhookSignature(rawBody, `t=${nowSeconds},s=deadbeef`),
    ).toThrow('MOONPAY_WEBHOOK_KEY is not set');
  });
});
