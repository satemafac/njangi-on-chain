// React StrictMode (dev) re-invokes effects across a simulated
// unmount/remount and does not preserve refs across it, so a useRef
// guard let the OAuth callback process the same id_token twice
// concurrently: two /api/zkLogin handleCallback POSTs per page load,
// with the losing run flashing "Authentication failed" moments before
// the winning run signed the user in. Module-level state survives the
// remount. Keying by token (rather than a boolean) means a stale claim
// from an earlier attempt can never block a genuinely new login.
const claimedTokens = new Set<string>();

/**
 * Claim an OAuth callback token for processing. Returns true exactly
 * once per token per page load; duplicate effect invocations get false
 * and must become no-ops instead of racing the first run.
 */
export function claimCallbackToken(
  token: string,
  claimed: Set<string> = claimedTokens,
): boolean {
  if (claimed.has(token)) {
    return false;
  }
  claimed.add(token);
  return true;
}
