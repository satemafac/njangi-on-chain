// sign-in-start.ts — what the sign-in buttons show while a login starts.
//
// Starting a sign-in takes one server round trip (`/api/zkLogin` beginLogin)
// before the browser can go to Google, Facebook or Apple. On 2026-10-15 that
// round trip returned 500 for hours and the sign-in modal showed nothing: the
// error landed in AuthContext state that no component rendered, so the outage
// looked like a dead button. This module decides what to show; LoginButton
// renders it.

import type { OAuthProvider } from '@/services/zkLoginService';

export type SignInFailureKey =
  | 'auth.startFailed.suiNetwork'
  | 'auth.startFailed.offline'
  | 'auth.startFailed.refresh'
  | 'auth.startFailed.generic';

export interface SignInStartState {
  /** The provider being opened. Stays set on success: the page is leaving. */
  pending: OAuthProvider | null;
  /** i18n key of the message explaining the last failure. */
  failure: SignInFailureKey | null;
}

export const IDLE_SIGN_IN_STATE: SignInStartState = { pending: null, failure: null };

// What fetch() rejects with when the request never reached a server:
// Chrome, Firefox, Safari, React Native.
const REQUEST_NEVER_SENT = /failed to fetch|networkerror|load failed|network request failed/i;

/** The message for a failed start. Server codes come from `/api/zkLogin`. */
export function signInFailureKey(error: unknown): SignInFailureKey {
  const code =
    typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  if (code === 'SUI_NETWORK_UNAVAILABLE') return 'auth.startFailed.suiNetwork';
  if (code === 'EPHEMERAL_KEY_REQUIRED') return 'auth.startFailed.refresh';
  if (error instanceof TypeError && REQUEST_NEVER_SENT.test(error.message)) {
    return 'auth.startFailed.offline';
  }
  return 'auth.startFailed.generic';
}

/**
 * Starts one sign-in, reporting each state through `update`. Never rejects: a
 * failure is something to show, not to throw.
 */
export async function startSignIn(
  provider: OAuthProvider,
  login: (provider: OAuthProvider) => Promise<void>,
  update: (state: SignInStartState) => void,
): Promise<void> {
  update({ pending: provider, failure: null });
  try {
    await login(provider);
  } catch (error) {
    update({ pending: null, failure: signInFailureKey(error) });
  }
}
