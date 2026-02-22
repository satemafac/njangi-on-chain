import type { NextApiRequest, NextApiResponse } from 'next';
import {
  createOnrampRequestLogger,
  maskWalletAddressForLogs,
  redactSensitiveData,
} from '@/lib/onramp-logging';

function createReq(headers?: Record<string, string>): NextApiRequest {
  return {
    method: 'GET',
    url: '/api/test',
    headers: headers ?? {},
  } as unknown as NextApiRequest;
}

function createRes(): NextApiResponse {
  return {
    setHeader: jest.fn(),
  } as unknown as NextApiResponse;
}

describe('onramp logging utilities', () => {
  it('masks wallet address to partial format', () => {
    expect(
      maskWalletAddressForLogs(
        '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcd',
      ),
    ).toBe('0x123456...abcd');
  });

  it('redacts sensitive keys recursively', () => {
    const payload = {
      token: 'session-secret-token-value',
      nested: {
        apiKey: 'abc123',
      },
      walletAddress:
        '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcd',
    };

    expect(redactSensitiveData(payload)).toEqual({
      token: '***',
      nested: {
        apiKey: '***',
      },
      walletAddress: '0x123456...abcd',
    });
  });

  it('propagates correlation id from request header and logs structured json', () => {
    const req = createReq({ 'x-correlation-id': 'corr-123' });
    const res = createRes();
    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});

    const logger = createOnrampRequestLogger(req, res, '/api/onramp/test');
    logger.info('test_event', { token: 'super-secret-token' });

    expect(logger.correlationId).toBe('corr-123');
    expect(res.setHeader).toHaveBeenCalledWith('x-correlation-id', 'corr-123');
    expect(infoSpy).toHaveBeenCalledTimes(1);

    const logged = JSON.parse(infoSpy.mock.calls[0][0] as string) as {
      correlationId: string;
      metadata?: { token?: string };
    };
    expect(logged.correlationId).toBe('corr-123');
    expect(logged.metadata?.token).toBe('***');

    infoSpy.mockRestore();
  });
});
