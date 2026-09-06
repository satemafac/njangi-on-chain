// The OAuth implicit flow returns the id_token in the URL fragment
// (`/auth/callback#iss=https://accounts.google.com&id_token=...`). Next's
// client boot captures `location.href` before React runs and, because the
// middleware matcher covers this page, replays it through `router.replace`
// as the `as` argument during hydration. resolve-href rejects any `//`
// before the first `?`, and `iss=https://` has one, so every login logged
// "Invalid href '/auth/callback#...id_token=eyJ...'" — the full JWT, email
// and sub included — to the console. Nothing in page code can intercept
// that: the path is captured before any component mounts.
//
// So the fragment is moved out of the URL before Next's bundle boots, by
// an inline script in _document (see AUTH_CALLBACK_FRAGMENT_SCRIPT). The
// callback page reads it back through readAuthCallbackFragment(), which
// still falls back to location.hash when the script did not run. The stash
// is deliberately NOT consumed on read: React StrictMode re-runs the
// callback effect and both runs must see the same token so the module-level
// claim in auth-callback-guard decides who proceeds.

export const AUTH_CALLBACK_PATH = '/auth/callback';

/** window property the pre-hydration script parks the raw fragment on. */
export const AUTH_CALLBACK_FRAGMENT_KEY = '__njangiAuthCallbackFragment';

/**
 * Inline, dependency-free, ES5 script for `_document`. Runs synchronously
 * during HTML parsing, ahead of Next's deferred chunks, and only touches
 * the callback route. The path check is exact so a stray `#section` on a
 * marketing page is left alone.
 */
export const AUTH_CALLBACK_FRAGMENT_SCRIPT = [
  '(function(){try{',
  'var l=window.location;',
  `if(l.pathname!==${JSON.stringify(AUTH_CALLBACK_PATH)}||!l.hash)return;`,
  `window[${JSON.stringify(AUTH_CALLBACK_FRAGMENT_KEY)}]=l.hash;`,
  'window.history.replaceState(window.history.state,"",l.pathname+l.search);',
  '}catch(e){}})();',
].join('');

type FragmentWindow = Window & { [AUTH_CALLBACK_FRAGMENT_KEY]?: unknown };

/**
 * The raw fragment (without the leading `#`) the provider redirected back
 * with. Prefers the pre-hydration stash; falls back to the live hash for
 * environments where the inline script did not run.
 */
export function readAuthCallbackFragment(win: Window = window): string {
  const stashed = (win as FragmentWindow)[AUTH_CALLBACK_FRAGMENT_KEY];
  const raw = typeof stashed === 'string' && stashed ? stashed : win.location.hash;
  return raw.startsWith('#') ? raw.slice(1) : raw;
}

/**
 * Drop the stash once the token has been handed to the auth flow, so the
 * JWT does not outlive the callback page on the window object. Safe to
 * call only after every effect run has had its chance to read it.
 */
export function clearAuthCallbackFragment(win: Window = window): void {
  try {
    delete (win as FragmentWindow)[AUTH_CALLBACK_FRAGMENT_KEY];
  } catch {
    // Non-configurable in some exotic embed; nothing else to do.
  }
}
