// timing-safe.ts — Constant-time comparison for shared-secret strings.
//
// `crypto.timingSafeEqual` throws when the buffer lengths differ, which both
// leaks length information and forces every caller to pre-check sizes.
// Hashing both inputs through SHA-256 first makes the comparison
// length-independent while keeping the final equality check constant-time.
// Use this for every bearer-style secret (INTERNAL_NOTIFY_SECRET,
// WHATSAPP_VERIFY_TOKEN, webhook HMAC digests, ...) instead of `===`.

import { createHash, timingSafeEqual } from 'crypto';

export function timingSafeEqualStrings(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }
  const digestA = createHash('sha256').update(a).digest();
  const digestB = createHash('sha256').update(b).digest();
  return timingSafeEqual(digestA, digestB);
}
