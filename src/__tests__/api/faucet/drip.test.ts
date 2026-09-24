/**
 * /api/faucet/drip must spend the caller's rate-limit slot ONLY when the
 * upstream faucet delivered. Regression for the 2026-09 report: the public
 * faucet throttles by source IP with a short retry-after, the route consumed
 * the 12h per-address slot before calling it, and one throttled attempt
 * turned every retry into "You already received test SUI recently".
 */

import type { NextApiRequest, NextApiResponse } from 'next';

jest.mock('@/lib/zklogin-session-registry', () => ({
  getZkLoginSessionAccount: jest.fn(),
}));
jest.mock('@/lib/rate-limit', () => ({
  peekRateLimit: jest.fn(),
  consumeRateLimit: jest.fn(),
}));
jest.mock('@/lib/client-ip', () => ({ getClientIp: () => '203.0.113.7' }));
jest.mock('@/services/network-config', () => ({ getCurrentNetwork: jest.fn(() => 'testnet') }));
jest.mock('@/utils/logger', () => ({ appLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

import handler from '@/pages/api/faucet/drip';
import { getZkLoginSessionAccount } from '@/lib/zklogin-session-registry';
import { peekRateLimit, consumeRateLimit } from '@/lib/rate-limit';
import { getCurrentNetwork } from '@/services/network-config';

const ADDRESS = '0x' + 'ab'.repeat(32);
const peek = peekRateLimit as jest.Mock;
const consume = consumeRateLimit as jest.Mock;
const session = getZkLoginSessionAccount as jest.Mock;
const network = getCurrentNetwork as jest.Mock;

function upstream(status: number, retryAfter?: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => (name.toLowerCase() === 'retry-after' ? retryAfter ?? null : null) },
    text: async () => (status === 429 ? `Too Many Requests! Wait for ${retryAfter ?? '?'}s` : ''),
  } as unknown as Response;
}

function mockRes() {
  const res: Partial<NextApiResponse> & { statusCode?: number; body?: unknown } = {};
  res.status = jest.fn((code: number) => {
    res.statusCode = code;
    return res as NextApiResponse;
  });
  res.json = jest.fn((body: unknown) => {
    res.body = body;
    return res as NextApiResponse;
  });
  res.setHeader = jest.fn();
  return res as NextApiResponse & { statusCode: number; body: Record<string, unknown> };
}

const req = { method: 'POST', cookies: { 'session-id': 'sess' } } as unknown as NextApiRequest;

beforeEach(() => {
  jest.clearAllMocks();
  session.mockResolvedValue({ userAddr: ADDRESS });
  network.mockReturnValue('testnet');
  peek.mockResolvedValue({ allowed: true, remaining: 1, resetMs: 1000 });
  consume.mockResolvedValue({ allowed: true, remaining: 0, resetMs: 1000 });
});

afterEach(() => {
  // @ts-expect-error test cleanup
  delete global.fetch;
});

describe('POST /api/faucet/drip', () => {
  it('does NOT spend a slot when the upstream keeps throttling', async () => {
    global.fetch = jest.fn().mockResolvedValue(upstream(429, '0'));
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(429);
    expect(res.body.error).toMatch(/faucet is busy/i);
    expect(res.body.retryAfterMs).toBe(0);
    expect(consume).not.toHaveBeenCalled();
    // Retried within budget: retry-after 0s is honored with a floor, up to MAX_ATTEMPTS.
    expect((global.fetch as jest.Mock).mock.calls.length).toBe(3);
  });

  it('retries after a short throttle and spends both slots once delivered', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(upstream(429, '0'))
      .mockResolvedValueOnce(upstream(200));
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, address: ADDRESS });
    expect(consume).toHaveBeenCalledTimes(2);
    expect(peek).toHaveBeenCalledTimes(2);
  });

  it('does not retry a throttle whose wait exceeds the in-request budget', async () => {
    global.fetch = jest.fn().mockResolvedValue(upstream(429, '600'));
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(429);
    expect(res.body.retryAfterMs).toBe(600_000);
    expect(res.body.error).toMatch(/faucet is busy/i);
    expect((global.fetch as jest.Mock).mock.calls.length).toBe(1);
    expect(consume).not.toHaveBeenCalled();
  });

  it('refuses before calling upstream when the address window is spent', async () => {
    peek.mockResolvedValueOnce({ allowed: false, remaining: 0, resetMs: 3_600_000 });
    global.fetch = jest.fn();
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(429);
    expect(res.body.error).toMatch(/already received/i);
    expect(res.body.resetMs).toBe(3_600_000);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
  });

  it('is dead on any network other than testnet', async () => {
    network.mockReturnValue('mainnet');
    global.fetch = jest.fn();
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(404);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('requires a verified session address', async () => {
    session.mockResolvedValue(null);
    global.fetch = jest.fn();
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
