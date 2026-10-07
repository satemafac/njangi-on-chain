// rate-limit-key.ts — Builds the bucket key for `consumeRateLimit` /
// `peekRateLimit` without putting personal data in it.
//
// Until October 2026 the API routes interpolated the raw client IP, often
// joined with an email or wallet address, straight into the key
// (`legal-deletion:203.0.113.7:someone@example.com`). With DATABASE_URL set
// the key is the `bucket` column of the Postgres `rate_limits` table, and a
// row is only replaced when the same bucket is hit again — so IP + email and
// IP + address pairs sat in the database indefinitely. The privacy policy
// and docs/records-of-processing.md describe the limiter as keyed on an
// HMAC'd IP; this module makes that true.
//
// The key is `<scope>:<hex>` where hex is HMAC-SHA256 over the scope and the
// subjects (the scope doubles as a domain separator, so one IP hashes
// differently per route and the rows cannot be correlated across routes).
// The HMAC key is RATE_LIMIT_KEY_SALT, falling back to LEGAL_ACCEPT_IP_SALT
// (the salt the legal-acceptance rows already use), and, when neither is
// set, to plain SHA-256 with a single warning per process. A missing salt
// degrades the hash, it never takes the API down: the limiter is
// defense-in-depth, not a correctness gate.
//
// The Postgres migration (`rate_limits_purge_raw_keys` in
// scripts/migrate-postgres.mjs) deletes every bucket that does not end in
// 64 hex characters, so the old raw-key rows do not outlive the deploy.

import { createHash, createHmac } from 'node:crypto';

/**
 * Shape of every key this module emits: a scope (route prefix; may itself
 * contain colons, e.g. `compliance:queue`) followed by 64 lowercase hex
 * characters. The migration's purge and the tests both pin this.
 */
export const RATE_LIMIT_KEY_PATTERN = /^[A-Za-z0-9_.:-]+:[0-9a-f]{64}$/;

// ASCII unit separator: cannot occur in an IP, email or Sui address, so
// `("a", "bc")` and `("ab", "c")` never collide.
const SUBJECT_SEPARATOR = '\u001f';

let warnedUnsalted = false;

/**
 * The HMAC key for rate-limit buckets: RATE_LIMIT_KEY_SALT, else
 * LEGAL_ACCEPT_IP_SALT, else null (unsalted SHA-256 fallback).
 */
export function resolveRateLimitKeySalt(): string | null {
  const dedicated = process.env.RATE_LIMIT_KEY_SALT;
  if (dedicated && dedicated.length > 0) return dedicated;
  const legal = process.env.LEGAL_ACCEPT_IP_SALT;
  if (legal && legal.length > 0) return legal;
  return null;
}

/**
 * Builds `<scope>:<hmac-sha256 hex>` for the limiter. `scope` is the route's
 * stable prefix (`legal-deletion`, `join-request`, …); `subjects` are the
 * values the route throttles on — the client IP and, where the route keys
 * on one, the email or wallet address. None of the subjects appear in the
 * output. Empty / missing subjects hash as empty strings rather than
 * throwing, so a route never 500s over a missing header.
 */
export function rateLimitKey(
  scope: string,
  ...subjects: Array<string | null | undefined>
): string {
  const material = [scope, ...subjects.map((value) => value ?? '')].join(SUBJECT_SEPARATOR);
  const salt = resolveRateLimitKeySalt();
  const hex = salt
    ? createHmac('sha256', salt).update(material).digest('hex')
    : unsaltedDigest(material);
  return `${scope}:${hex}`;
}

function unsaltedDigest(material: string): string {
  if (!warnedUnsalted) {
    warnedUnsalted = true;
    console.warn(
      '[rate-limit] RATE_LIMIT_KEY_SALT and LEGAL_ACCEPT_IP_SALT are both unset; ' +
        'rate-limit keys fall back to unsalted SHA-256. Set RATE_LIMIT_KEY_SALT ' +
        '(npm run generate:secrets) so stored buckets cannot be matched against ' +
        'candidate IPs offline.',
    );
  }
  return createHash('sha256').update(material).digest('hex');
}

/** Test helper — re-arms the once-per-process unsalted warning. */
export function __resetRateLimitKeyForTests(): void {
  warnedUnsalted = false;
}
