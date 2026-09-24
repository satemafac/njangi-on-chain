// faucet-request.ts — the client half of "Get test SUI".
//
// The public testnet faucet throttles by source IP with a `retry-after` of
// seconds to a minute, and the drip route only waits out short throttles
// in-request (it must not hold a serverless function open for a minute).
// Longer waits come back as 429 + `retryAfterMs`. Handing that to the user
// as "try again in 23s" made them the retry loop. This runs the loop for
// them: wait exactly as long as the faucet asked, show the countdown, try
// again, give up after a bounded number of rounds.

export interface FaucetResponseBody {
  success?: boolean;
  error?: string;
  /** Our own per-address / per-IP window (nothing was delivered). */
  resetMs?: number;
  /** The public faucet's throttle; null when it gave no retry-after. */
  retryAfterMs?: number | null;
}

export type FaucetOutcome =
  | { ok: true }
  | {
      ok: false;
      error: string;
      /** How long the caller should tell the user to wait, when known. */
      waitMs: number | null;
      /** True when we gave up after waiting the faucet out at least once. */
      retried: boolean;
    };

export interface FaucetRetryOptions {
  fetchImpl?: typeof fetch;
  /** Upper bound on attempts, the first included. */
  maxAttempts?: number;
  /** Throttles longer than this are handed back to the user instead of waited out. */
  maxWaitMs?: number;
  /** Called once per second while waiting, so the UI can count down. */
  onWaiting?: (secondsLeft: number, attempt: number) => void;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_MAX_WAIT_MS = 90_000;
const GENERIC_FAILURE = 'Faucet request failed. Try faucet.sui.io directly.';

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function waitFrom(body: FaucetResponseBody): number | null {
  const candidate = body.resetMs ?? body.retryAfterMs;
  return typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0 ? candidate : null;
}

export async function requestTestSuiWithRetry(opts: FaucetRetryOptions = {}): Promise<FaucetOutcome> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const maxWaitMs = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const sleep = opts.sleep ?? defaultSleep;
  let retried = false;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const res = await fetchImpl('/api/faucet/drip', { method: 'POST' });
    const body: FaucetResponseBody = await res.json().catch(() => ({}));
    if (res.ok && body.success) {
      return { ok: true };
    }

    const waitMs = waitFrom(body);
    // Only the public faucet's throttle is worth waiting out here. Our own
    // window (`resetMs`, hours) and every other failure go straight back.
    const throttled =
      res.status === 429 && typeof body.retryAfterMs === 'number' && body.resetMs === undefined;
    const canRetry = throttled && waitMs !== null && waitMs <= maxWaitMs && attempt < maxAttempts;
    if (!canRetry) {
      return { ok: false, error: body.error || GENERIC_FAILURE, waitMs, retried };
    }

    retried = true;
    // Wait the faucet out, plus a second of slack so we do not land on the
    // boundary and get told to wait again.
    let remaining = Math.ceil((waitMs as number) / 1000) + 1;
    while (remaining > 0) {
      opts.onWaiting?.(remaining, attempt);
      await sleep(1000);
      remaining -= 1;
    }
  }
  // Unreachable: the loop returns on the last attempt.
  return { ok: false, error: GENERIC_FAILURE, waitMs: null, retried };
}

/** "try again in ~23s" / "~3h 10m" — one place, shared by every faucet toast. */
export function formatFaucetWait(ms: number): string {
  const totalSeconds = Math.ceil(ms / 1000);
  if (totalSeconds < 90) return `try again in ~${totalSeconds}s`;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.ceil((totalSeconds % 3600) / 60);
  return hours > 0 ? `try again in ~${hours}h ${minutes}m` : `try again in ~${minutes}m`;
}
