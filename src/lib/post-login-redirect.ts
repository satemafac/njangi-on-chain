// post-login-redirect.ts — where to send someone once sign-in completes.
//
// The landing page's "Start a circle" button, the join page and the OAuth
// callback all used to talk to `localStorage['redirectAfterLogin']` by hand,
// each with its own idea of what a valid destination looks like. One helper
// keeps the rule in one place: a destination is either an app path
// ("/create-circle") or a same-origin absolute URL (the join page stores
// `window.location.href`). Anything else — a foreign origin, a protocol-
// relative "//evil", an empty string — is dropped, so a stored value can
// never turn the callback into an open redirect.

export const POST_LOGIN_DESTINATION_KEY = 'redirectAfterLogin';

/**
 * Pure rule, testable without a browser: returns the destination to use, or
 * null when the stored value is missing or unsafe.
 */
export function resolvePostLoginDestination(
  raw: string | null | undefined,
  origin: string,
): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (value.length === 0) return null;

  // App-relative path. "//host" is protocol-relative and must not pass.
  if (value.startsWith('/') && !value.startsWith('//')) return value;

  // Same-origin absolute URL (what the join page stores).
  if (origin) {
    if (value === origin) return '/';
    if (value.startsWith(`${origin}/`)) return value;
  }

  return null;
}

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    // Storage access can throw (privacy mode, blocked site data).
    return null;
  }
}

/** Remember where to go after the provider round-trip. */
export function rememberPostLoginDestination(destination: string): void {
  const resolved = resolvePostLoginDestination(
    destination,
    typeof window !== 'undefined' ? window.location.origin : '',
  );
  const store = storage();
  if (!store || !resolved) return;
  try {
    store.setItem(POST_LOGIN_DESTINATION_KEY, resolved);
  } catch {
    // Nothing to do: the callback falls back to the dashboard.
  }
}

export function clearPostLoginDestination(): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(POST_LOGIN_DESTINATION_KEY);
  } catch {
    // ignore
  }
}

/**
 * Read AND clear the stored destination, validated against the current
 * origin. A destination is consumed exactly once so a stale value cannot
 * hijack a later login.
 */
export function takePostLoginDestination(): string | null {
  const store = storage();
  if (!store) return null;
  let raw: string | null = null;
  try {
    raw = store.getItem(POST_LOGIN_DESTINATION_KEY);
    store.removeItem(POST_LOGIN_DESTINATION_KEY);
  } catch {
    return null;
  }
  return resolvePostLoginDestination(raw, window.location.origin);
}

/** True when the destination is an app path rather than a full URL. */
export function isAppPath(destination: string): boolean {
  return destination.startsWith('/') && !destination.startsWith('//');
}
