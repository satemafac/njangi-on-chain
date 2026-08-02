const mockGetNetworkConfig = jest.fn();
const mockGetCurrentNetwork = jest.fn(() => 'testnet');
const mockSuiClient = jest.fn();
const transportRequestMocks = new Map<string, jest.Mock>();
const clientInstances = new Map<
  string,
  {
    url: string;
    getLatestCheckpointSequenceNumber: jest.Mock;
  }
>();

jest.mock('../network-config', () => ({
  getCurrentNetwork: () => mockGetCurrentNetwork(),
  getNetworkConfig: (...args: unknown[]) => mockGetNetworkConfig(...args),
}));

jest.mock('@mysten/sui/client', () => ({
  SuiHTTPTransport: function MockSuiHTTPTransport({ url }: { url: string }) {
    const request = jest.fn(async () => ({ url }));
    transportRequestMocks.set(url, request);
    return {
      url,
      request,
      subscribe: jest.fn(async () => async () => true),
    };
  },
  SuiClient: function MockSuiClient({
    url,
    transport,
  }: {
    url?: string;
    transport?: { url?: string };
  }) {
    const resolvedUrl = url ?? transport?.url ?? 'transport';
    mockSuiClient(resolvedUrl);

    if (transport) {
      return { transport };
    }

    const existing = clientInstances.get(resolvedUrl);
    if (existing) {
      return existing;
    }

    const instance = {
      url: resolvedUrl,
      getLatestCheckpointSequenceNumber: jest.fn(),
    };
    clientInstances.set(resolvedUrl, instance);
    return instance;
  },
}));

import {
  clearSuiRpcClientPool,
  getHealthySuiClient,
  getPooledSuiClient,
  getRpcCandidateUrls,
  getRpcCandidateUrlsForRpcUrl,
  isCapabilityGapError,
  isRateLimitedSuiRpcError,
  isRetriableSuiRpcError,
  logSuiReadError,
  withSuiRpcFailover,
} from '../sui-rpc-failover';

describe('sui-rpc-failover', () => {
  const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

  beforeEach(() => {
    jest.clearAllMocks();
    clearSuiRpcClientPool();
    clientInstances.clear();
    transportRequestMocks.clear();
    mockGetNetworkConfig.mockReturnValue({
      rpcUrl: 'https://primary.rpc',
      rpcAltUrl: 'https://alt.rpc',
    });
  });

  afterAll(() => {
    warnSpy.mockRestore();
  });

  it('returns unique valid RPC candidates, rate-limited hosts last', () => {
    mockGetNetworkConfig.mockReturnValue({
      rpcUrl: 'https://primary.rpc',
      rpcAltUrl: 'not-a-url',
    });

    // blockvision is the only endpoint serving event history, and it rations
    // requests. Spending its budget on ordinary object reads starves the one
    // thing only it can do — so it sorts last regardless of list position.
    expect(getRpcCandidateUrls('testnet')).toEqual([
      'https://primary.rpc',
      'https://sui-testnet-rpc.publicnode.com',
      'https://sui-testnet-endpoint.blockvision.org',
    ]);
  });

  it('prepends the requested RPC URL before shared network fallbacks', () => {
    expect(
      getRpcCandidateUrlsForRpcUrl({
        network: 'testnet',
        rpcUrl: 'https://preferred.rpc',
      }),
    ).toEqual([
      'https://preferred.rpc',
      'https://primary.rpc',
      'https://alt.rpc',
      'https://sui-testnet-rpc.publicnode.com',
      'https://sui-testnet-endpoint.blockvision.org',
    ]);
  });

  it('sinks a rate-limited host even when configured as the primary alt', () => {
    // Regression for production 2026-08-02: blockvision sat second in the
    // candidate order via NEXT_PUBLIC_TESTNET_RPC_ALT, so every dashboard load
    // hit it, 429s followed, and an address holding 4.15 SUI and two
    // membership receipts rendered as 0 circles / $0. Operator config decides
    // WHICH endpoints are used; ordering decides which budget gets spent.
    mockGetNetworkConfig.mockReturnValue({
      rpcUrl: 'https://primary.rpc',
      rpcAltUrl: 'https://sui-testnet-endpoint.blockvision.org',
    });

    const candidates = getRpcCandidateUrls('testnet');
    expect(candidates[0]).toBe('https://primary.rpc');
    expect(candidates[candidates.length - 1]).toBe(
      'https://sui-testnet-endpoint.blockvision.org',
    );
    expect(candidates.indexOf('https://sui-testnet-rpc.publicnode.com')).toBeLessThan(
      candidates.indexOf('https://sui-testnet-endpoint.blockvision.org'),
    );
  });

  it('classifies 5xx and transport errors as retriable', () => {
    expect(isRetriableSuiRpcError(new Error('Unexpected status code: 503'))).toBe(true);
    expect(isRetriableSuiRpcError(new Error('fetch failed'))).toBe(true);
    expect(isRetriableSuiRpcError(new Error('Unexpected status code: 400'))).toBe(false);
    expect(isRetriableSuiRpcError(new Error('Permission denied'))).toBe(false);
  });

  it('fails over when an endpoint withdraws its JSON-RPC surface', () => {
    // Sui deprecated JSON-RPC on public fullnodes and serves the refusal as
    // HTTP 200 with a JSON-RPC error body, so it arrives as an application
    // error rather than a transport failure. Before this was classified, a
    // healthy alternate was never tried and the app lost all chain access
    // behind one retired primary (2026-08-02).
    expect(
      isRetriableSuiRpcError(
        new Error(
          'Method not found. JSON-RPC on public fullnodes has been deprecated. ' +
            'Please migrate to gRPC or GraphQL endpoints.',
        ),
      ),
    ).toBe(true);
    expect(isRetriableSuiRpcError(new Error('Method not found'))).toBe(true);

    // Still not a blanket "retry everything": unrelated application errors
    // must stay terminal so a real failure is not masked by N host attempts.
    expect(isRetriableSuiRpcError(new Error('Invalid params'))).toBe(false);
    expect(isRetriableSuiRpcError(new Error('Permission denied'))).toBe(false);
  });

  it('classifies 429 and rate-limit messages explicitly', () => {
    expect(isRateLimitedSuiRpcError(new Error('Unexpected status code: 429'))).toBe(true);
    expect(
      isRateLimitedSuiRpcError(
        new Error('All configured Sui RPC endpoints are in rate limit cooldown. Retry in about 30s.'),
      ),
    ).toBe(true);
    expect(isRateLimitedSuiRpcError(new Error('Unexpected status code: 503'))).toBe(false);
  });

  it('retries the next RPC when the primary returns a retriable error', async () => {
    const attemptedUrls: string[] = [];

    const result = await withSuiRpcFailover('testnet', 'unit-test', async (_client, context) => {
      attemptedUrls.push(context.rpcUrl);

      if (!context.isFallback) {
        throw new Error('Unexpected status code: 503');
      }

      return 'ok';
    });

    expect(result).toBe('ok');
    expect(attemptedUrls).toEqual(['https://primary.rpc', 'https://alt.rpc']);
  });

  it('does not retry non-retriable RPC errors', async () => {
    const attemptedUrls: string[] = [];

    await expect(
      withSuiRpcFailover('testnet', 'unit-test', async (_client, context) => {
        attemptedUrls.push(context.rpcUrl);
        throw new Error('Unexpected status code: 400');
      }),
    ).rejects.toThrow('Unexpected status code: 400');

    expect(attemptedUrls).toEqual(['https://primary.rpc']);
  });

  it('falls through to the third testnet candidate after a 429 on the configured fallback', async () => {
    const attemptedUrls: string[] = [];

    const result = await withSuiRpcFailover('testnet', 'unit-test', async (_client, context) => {
      attemptedUrls.push(context.rpcUrl);

      if (context.rpcUrl === 'https://primary.rpc') {
        throw new Error('Unexpected status code: 503');
      }

      if (context.rpcUrl === 'https://alt.rpc') {
        throw new Error('Unexpected status code: 429');
      }

      return 'ok';
    });

    expect(result).toBe('ok');
    // The third candidate is now publicnode, not blockvision — rate-limited
    // hosts sort to the back, so the rotation reaches an unmetered endpoint
    // before spending blockvision's budget.
    expect(attemptedUrls).toEqual([
      'https://primary.rpc',
      'https://alt.rpc',
      'https://sui-testnet-rpc.publicnode.com',
    ]);
  });

  it('returns a healthy fallback client when the primary probe fails', async () => {
    clientInstances.set('https://primary.rpc', {
      url: 'https://primary.rpc',
      getLatestCheckpointSequenceNumber: jest.fn(async () => {
        throw new Error('Unexpected status code: 503');
      }),
    });
    clientInstances.set('https://alt.rpc', {
      url: 'https://alt.rpc',
      getLatestCheckpointSequenceNumber: jest.fn(async () => '123'),
    });

    const result = await getHealthySuiClient('testnet', 'unit-test');

    expect(result.rpcUrl).toBe('https://alt.rpc');
    expect(result.isFallback).toBe(true);
  });

  it('creates a pooled client backed by a failover transport', () => {
    const client = getPooledSuiClient({
      network: 'testnet',
      rpcUrl: 'https://preferred.rpc',
    }) as unknown as { transport?: unknown };

    expect(client.transport).toBeDefined();
  });

  it('cools down an RPC after 429 so the next request starts with the alternate', async () => {
    const client = getPooledSuiClient({
      network: 'testnet',
      rpcUrl: 'https://primary.rpc',
    }) as unknown as {
      transport: { request: (input: { method: string; params: unknown[] }) => Promise<unknown> };
    };

    transportRequestMocks.get('https://primary.rpc')!.mockRejectedValueOnce(
      new Error('Unexpected status code: 429'),
    );
    transportRequestMocks.get('https://alt.rpc')!.mockResolvedValueOnce({ ok: true });

    await expect(
      client.transport.request({ method: 'suix_queryEvents', params: [] }),
    ).resolves.toEqual({ ok: true });

    transportRequestMocks.get('https://alt.rpc')!.mockResolvedValueOnce({ second: true });

    await expect(
      client.transport.request({ method: 'suix_queryEvents', params: [] }),
    ).resolves.toEqual({ second: true });

    expect(transportRequestMocks.get('https://primary.rpc')).toHaveBeenCalledTimes(1);
    expect(transportRequestMocks.get('https://alt.rpc')).toHaveBeenCalledTimes(2);
  });

  it('marks the last fallback RPC as cooling down after 429 and short-circuits later requests', async () => {
    const client = getPooledSuiClient({
      network: 'testnet',
      rpcUrl: 'https://primary.rpc',
    }) as unknown as {
      transport: { request: (input: { method: string; params: unknown[] }) => Promise<unknown> };
    };

    transportRequestMocks.get('https://primary.rpc')!.mockRejectedValueOnce(
      new Error('Unexpected status code: 429'),
    );
    transportRequestMocks.get('https://alt.rpc')!.mockRejectedValueOnce(
      new Error('Unexpected status code: 429'),
    );
    transportRequestMocks.get('https://sui-testnet-endpoint.blockvision.org')!.mockRejectedValueOnce(
      new Error('Unexpected status code: 429'),
    );
    transportRequestMocks.get('https://sui-testnet-rpc.publicnode.com')!.mockRejectedValueOnce(
      new Error('Unexpected status code: 429'),
    );

    await expect(
      client.transport.request({ method: 'suix_queryEvents', params: [] }),
    ).rejects.toThrow('Unexpected status code: 429');

    await expect(
      client.transport.request({ method: 'suix_queryEvents', params: [] }),
    ).rejects.toThrow(/rate limit cooldown/i);

    expect(transportRequestMocks.get('https://primary.rpc')).toHaveBeenCalledTimes(1);
    expect(transportRequestMocks.get('https://alt.rpc')).toHaveBeenCalledTimes(1);
    expect(transportRequestMocks.get('https://sui-testnet-endpoint.blockvision.org')).toHaveBeenCalledTimes(1);
    expect(transportRequestMocks.get('https://sui-testnet-rpc.publicnode.com')).toHaveBeenCalledTimes(1);
  });

  describe('logSuiReadError', () => {
    it('warns (not errors) and returns true for a transient cooldown error', () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const transient = new Error(
        '[sui.transport:sui_getObject] All configured Sui RPC endpoints are in rate limit cooldown. Retry in about 6s.',
      );

      const result = logSuiReadError('read ctx', transient);

      expect(result).toBe(true);
      expect(errorSpy).not.toHaveBeenCalled();
      errorSpy.mockRestore();
    });

    it('console.errors and returns false for a genuine (non-transient) error', () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

      const result = logSuiReadError('read ctx', new Error('contract assertion failed'));

      expect(result).toBe(false);
      expect(errorSpy).toHaveBeenCalled();
      errorSpy.mockRestore();
    });
  });
});

describe('capability gaps vs ill health', () => {
  // The distinction this suite defends: an endpoint that cannot serve a
  // METHOD must not be benched for the methods it serves fine.
  //
  // Production 2026-08-02: every queryEvents against publicnode failed
  // ("Could not find the referenced transaction events") because it prunes
  // event history. Each failure cooled publicnode down for 10s — removing the
  // one endpoint that answers the app's most common call. blockvision then
  // 429'd, everything entered cooldown, and a funded account rendered as
  // 0 circles / $0.

  it('classifies pruned event history and withdrawn JSON-RPC as capability gaps', () => {
    expect(
      isCapabilityGapError(
        'Could not find the referenced transaction events [TransactionDigest(abc)].',
      ),
    ).toBe(true);
    expect(
      isCapabilityGapError(
        'Method not found. JSON-RPC on public fullnodes has been deprecated.',
      ),
    ).toBe(true);
  });

  it('does not treat genuine ill health as a capability gap', () => {
    // These SHOULD cool the endpoint down — retrying the same host soon is
    // exactly the wrong move when it is rate-limited or falling over.
    for (const msg of [
      'Unexpected status code: 429',
      'Unexpected status code: 503',
      'fetch failed',
      'socket hang up',
    ]) {
      expect(isCapabilityGapError(msg)).toBe(false);
    }
  });

  it('keeps capability gaps retriable so the request still fails over', () => {
    // Failing over is right; penalising the endpoint is not. Both properties
    // have to hold at once.
    const msg = 'Could not find the referenced transaction events [TransactionDigest(x)].';
    expect(isCapabilityGapError(msg)).toBe(true);
    expect(isRetriableSuiRpcError(new Error(msg))).toBe(true);
  });
});
