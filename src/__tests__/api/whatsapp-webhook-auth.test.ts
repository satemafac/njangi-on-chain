/**
 * Regression tests for the WhatsApp webhook signature enforcement
 * (gtm-readiness review, June 2026): the 'allow invalid signatures for
 * debugging' bypass must be gone — forged or missing signatures are 403,
 * a missing app secret in production fails closed with 500, and the Meta
 * GET hub.challenge verification keeps working.
 */

import crypto from 'crypto';
import type { NextApiRequest, NextApiResponse } from 'next';
import handler from '@/pages/api/whatsapp/webhook';

const APP_SECRET = 'test-app-secret';
const VERIFY_TOKEN = 'test-verify-token';

interface MockRes {
  statusCode: number;
  jsonBody: unknown;
  sentBody: unknown;
  headers: Record<string, unknown>;
}

function createMockRes(): NextApiResponse & MockRes {
  const res = {
    statusCode: 0,
    jsonBody: undefined as unknown,
    sentBody: undefined as unknown,
    headers: {} as Record<string, unknown>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.jsonBody = body;
      return this;
    },
    send(body: unknown) {
      this.sentBody = body;
      return this;
    },
    setHeader(key: string, value: unknown) {
      this.headers[key] = value;
      return this;
    },
  };
  return res as unknown as NextApiResponse & MockRes;
}

function createPostReq(body: Record<string, unknown>, signature?: string): NextApiRequest {
  return {
    method: 'POST',
    headers: signature ? { 'x-hub-signature-256': signature } : {},
    body,
    query: {},
    cookies: {},
  } as unknown as NextApiRequest;
}

function signBody(body: Record<string, unknown>, secret: string): string {
  const hash = crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(body))
    .digest('hex');
  return `sha256=${hash}`;
}

describe('WhatsApp webhook signature enforcement', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.WHATSAPP_APP_SECRET = APP_SECRET;
    process.env.WHATSAPP_VERIFY_TOKEN = VERIFY_TOKEN;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('accepts a POST with a valid signature', async () => {
    const body = { object: 'whatsapp_business_account', entry: [] };
    const res = createMockRes();

    await handler(createPostReq(body, signBody(body, APP_SECRET)), res);

    expect(res.statusCode).toBe(200);
    expect(res.jsonBody).toMatchObject({ success: true });
  });

  it('rejects a POST with a forged signature with 403', async () => {
    const body = { object: 'whatsapp_business_account', entry: [] };
    const res = createMockRes();

    await handler(createPostReq(body, signBody(body, 'wrong-secret')), res);

    expect(res.statusCode).toBe(403);
    expect(res.jsonBody).toMatchObject({ success: false });
  });

  it('rejects a POST with a missing signature with 403', async () => {
    const body = { object: 'whatsapp_business_account', entry: [] };
    const res = createMockRes();

    await handler(createPostReq(body), res);

    expect(res.statusCode).toBe(403);
    expect(res.jsonBody).toMatchObject({ success: false });
  });

  it('rejects a POST with a malformed signature header with 403', async () => {
    const body = { object: 'whatsapp_business_account', entry: [] };
    const res = createMockRes();

    await handler(createPostReq(body, 'not-a-sha256-header'), res);

    expect(res.statusCode).toBe(403);
  });

  it('fails closed with 500 when WHATSAPP_APP_SECRET is missing in production', async () => {
    delete process.env.WHATSAPP_APP_SECRET;
    const previousNodeEnv = process.env.NODE_ENV;
    (process.env as Record<string, string>).NODE_ENV = 'production';
    try {
      const body = { object: 'whatsapp_business_account', entry: [] };
      const res = createMockRes();

      await handler(createPostReq(body, signBody(body, APP_SECRET)), res);

      expect(res.statusCode).toBe(500);
      expect(res.jsonBody).toMatchObject({ success: false });
    } finally {
      (process.env as Record<string, string>).NODE_ENV = previousNodeEnv as string;
    }
  });

  it('still answers the Meta GET hub.challenge verification', async () => {
    const res = createMockRes();
    const req = {
      method: 'GET',
      headers: {},
      query: {
        'hub.mode': 'subscribe',
        'hub.challenge': 'challenge-12345',
        'hub.verify_token': VERIFY_TOKEN,
      },
      cookies: {},
    } as unknown as NextApiRequest;

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.sentBody).toBe('challenge-12345');
  });

  it('rejects GET verification with a wrong verify token', async () => {
    const res = createMockRes();
    const req = {
      method: 'GET',
      headers: {},
      query: {
        'hub.mode': 'subscribe',
        'hub.challenge': 'challenge-12345',
        'hub.verify_token': 'wrong-token',
      },
      cookies: {},
    } as unknown as NextApiRequest;

    await handler(req, res);

    expect(res.statusCode).toBe(403);
  });
});
