import { ROUND_READ_RETRY_DELAYS_MS, roundReadRetryDelayMs } from '../round-read-retry';

describe('roundReadRetryDelayMs', () => {
  it('does not retry before any read has failed', () => {
    expect(roundReadRetryDelayMs(0)).toBeNull();
    expect(roundReadRetryDelayMs(-1)).toBeNull();
    expect(roundReadRetryDelayMs(Number.NaN)).toBeNull();
    expect(roundReadRetryDelayMs(1.5)).toBeNull();
  });

  it('backs off across consecutive failures', () => {
    const delays = ROUND_READ_RETRY_DELAYS_MS.map((_, i) => roundReadRetryDelayMs(i + 1));
    expect(delays).toEqual([4_000, 10_000, 25_000, 45_000]);
    for (let i = 1; i < delays.length; i += 1) {
      expect(delays[i]!).toBeGreaterThan(delays[i - 1]!);
    }
  });

  it('reaches past both RPC cooldowns before giving up', () => {
    // The failover pool benches an endpoint for 10s after a transient
    // failure and 30s after a 429. The second retry lands past the first
    // even if it began when the read failed, and the third past the second
    // even if it began at the first retry.
    const at = (n: number) =>
      ROUND_READ_RETRY_DELAYS_MS.slice(0, n).reduce((sum, ms) => sum + ms, 0);
    expect(at(2)).toBeGreaterThan(10_000);
    expect(at(3) - at(1)).toBeGreaterThan(30_000);
  });

  it('stops once every automatic retry is spent', () => {
    expect(roundReadRetryDelayMs(ROUND_READ_RETRY_DELAYS_MS.length + 1)).toBeNull();
    expect(roundReadRetryDelayMs(100)).toBeNull();
  });
});
