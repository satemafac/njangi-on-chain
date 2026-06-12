// zklogin-session-registry.ts — Shared in-memory store for zkLogin sessions.
//
// `/api/zkLogin` keeps authenticated sessions (keyed by the HttpOnly
// `session-id` cookie) in memory. Other API routes — e.g. the WhatsApp
// admin link/unlink endpoints — need to resolve "who is the caller?" from
// that same store so they can bind requests to a server-verified address
// instead of trusting client-supplied identity.
//
// The Map is hung off `globalThis` because Next.js compiles each
// `pages/api` entrypoint into its own bundle: a plain module-scoped Map
// could be duplicated per bundle (and across dev HMR reloads), which would
// make sessions created by `/api/zkLogin` invisible to other routes.
// Sessions remain memory-only — nothing here touches disk — matching the
// Phase 1 compliance redesign. Multi-replica deployments should swap this
// for Redis / Enoki-managed sessions.

import type { SetupData, AccountData } from '../services/zkLoginService';

export type ZkLoginSessionRecord = SetupData & { account?: AccountData };

const GLOBAL_KEY = Symbol.for('njangi.zklogin.session-registry');

export function getZkLoginSessionStore(): Map<string, ZkLoginSessionRecord> {
  const globalStore = globalThis as { [key: symbol]: unknown };
  if (!(globalStore[GLOBAL_KEY] instanceof Map)) {
    globalStore[GLOBAL_KEY] = new Map<string, ZkLoginSessionRecord>();
  }
  return globalStore[GLOBAL_KEY] as Map<string, ZkLoginSessionRecord>;
}

/**
 * Returns the authenticated account bound to a session id, or `null` when
 * the session is missing or has not completed the OAuth callback (i.e. it
 * has no account / zk proof material yet). Callers treat `null` as
 * "re-authenticate".
 */
export function getZkLoginSessionAccount(
  sessionId: string | undefined,
): AccountData | null {
  if (!sessionId) {
    return null;
  }
  const record = getZkLoginSessionStore().get(sessionId);
  const account = record?.account;
  if (!account?.userAddr) {
    return null;
  }
  // Mirror the proof-material checks /api/zkLogin applies before signing:
  // a session without complete proof points never finished authentication.
  if (
    !account.zkProofs?.proofPoints?.a?.length ||
    !account.zkProofs?.proofPoints?.b?.length ||
    !account.zkProofs?.proofPoints?.c?.length
  ) {
    return null;
  }
  return account;
}
