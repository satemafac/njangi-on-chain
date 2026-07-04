import { claimCallbackToken } from '@/lib/auth-callback-guard';

describe('claimCallbackToken', () => {
  it('grants the first claim and rejects a duplicate of the same token', () => {
    const claimed = new Set<string>();

    expect(claimCallbackToken('jwt-a', claimed)).toBe(true);
    // Second invocation (StrictMode remount re-running the callback
    // effect) must be a no-op instead of racing the first run.
    expect(claimCallbackToken('jwt-a', claimed)).toBe(false);
    expect(claimCallbackToken('jwt-a', claimed)).toBe(false);
  });

  it('never lets an earlier login block a different token', () => {
    const claimed = new Set<string>();

    expect(claimCallbackToken('jwt-a', claimed)).toBe(true);
    expect(claimCallbackToken('jwt-b', claimed)).toBe(true);
  });

  it('uses shared module state by default so claims survive a remount', () => {
    const token = `jwt-${Date.now()}-default-registry`;

    expect(claimCallbackToken(token)).toBe(true);
    expect(claimCallbackToken(token)).toBe(false);
  });
});
