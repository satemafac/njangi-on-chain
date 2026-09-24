/**
 * The client retry loop for "Get test SUI": waits out the public faucet's
 * throttle instead of making the user do it, and never retries our own
 * per-address window.
 */
import { requestTestSuiWithRetry, formatFaucetWait } from '../faucet-request';

const reply = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

const instant = async () => undefined;

describe('requestTestSuiWithRetry', () => {
  it('returns ok on a first-try success', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(reply(200, { success: true }));
    await expect(requestTestSuiWithRetry({ fetchImpl, sleep: instant })).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('waits out a public-faucet throttle, counting down, then succeeds', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(reply(429, { error: 'busy', retryAfterMs: 3000 }))
      .mockResolvedValueOnce(reply(200, { success: true }));
    const ticks: number[] = [];
    const out = await requestTestSuiWithRetry({
      fetchImpl,
      sleep: instant,
      onWaiting: (s) => ticks.push(s),
    });
    expect(out).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // 3s + 1s slack, counted down one second at a time
    expect(ticks).toEqual([4, 3, 2, 1]);
  });

  it('gives up after maxAttempts and reports that it retried', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(reply(429, { error: 'busy', retryAfterMs: 1000 }));
    const out = await requestTestSuiWithRetry({ fetchImpl, sleep: instant, maxAttempts: 3 });
    expect(out).toEqual({ ok: false, error: 'busy', waitMs: 1000, retried: true });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('does not wait out a throttle longer than maxWaitMs', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(reply(429, { error: 'busy', retryAfterMs: 600_000 }));
    const out = await requestTestSuiWithRetry({ fetchImpl, sleep: instant });
    expect(out).toMatchObject({ ok: false, waitMs: 600_000, retried: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('never retries our own per-address window', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(reply(429, { error: 'already received', resetMs: 5000 }));
    const out = await requestTestSuiWithRetry({ fetchImpl, sleep: instant });
    expect(out).toMatchObject({ ok: false, error: 'already received', waitMs: 5000, retried: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('returns the server error for non-throttle failures without retrying', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(reply(502, { error: 'Could not reach the testnet faucet.' }));
    const out = await requestTestSuiWithRetry({ fetchImpl, sleep: instant });
    expect(out).toMatchObject({ ok: false, error: 'Could not reach the testnet faucet.', waitMs: null });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('formatFaucetWait', () => {
  it('speaks seconds under 90s and hours/minutes above', () => {
    expect(formatFaucetWait(23_000)).toBe('try again in ~23s');
    expect(formatFaucetWait(11_393_896)).toBe('try again in ~3h 10m');
    expect(formatFaucetWait(600_000)).toBe('try again in ~10m');
  });
});
