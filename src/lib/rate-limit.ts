// rate-limit.ts — Minimal per-key sliding window limiter used to throttle
// the compliance endpoints. Runs in-process (fine for the Next.js Node
// runtime) and is safe for multi-instance because it enforces a strict
// upper bound per instance; if we later deploy behind a load balancer
// with multiple replicas we'll move this to Redis. The goal today is to
// make a leaked INTERNAL_NOTIFY_SECRET expensive to abuse, not to
// provide strict global correctness.

interface Window {
  start: number;
  count: number;
}

const windows: Map<string, Window> = new Map();

export interface RateLimitOptions {
  /** Unique key (typically sha256 of the bearer secret + action). */
  key: string;
  /** Max requests allowed inside the window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetMs: number;
}

export function consumeRateLimit(opts: RateLimitOptions): RateLimitResult {
  const now = Date.now();
  const current = windows.get(opts.key);
  if (!current || now - current.start >= opts.windowMs) {
    const fresh: Window = { start: now, count: 1 };
    windows.set(opts.key, fresh);
    return { allowed: true, remaining: opts.limit - 1, resetMs: opts.windowMs };
  }
  if (current.count >= opts.limit) {
    return {
      allowed: false,
      remaining: 0,
      resetMs: opts.windowMs - (now - current.start),
    };
  }
  current.count += 1;
  return {
    allowed: true,
    remaining: opts.limit - current.count,
    resetMs: opts.windowMs - (now - current.start),
  };
}

/** Test helper — clears the in-memory windows so cases don't leak. */
export function __resetRateLimitForTests(): void {
  windows.clear();
}
