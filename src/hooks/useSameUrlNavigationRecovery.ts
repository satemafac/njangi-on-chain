import { useEffect } from 'react';
import { useRouter } from 'next/router';

export const SAME_URL_INVARIANT = 'Invariant: attempted to hard navigate to the same URL';

const RELOAD_STAMP_KEY = 'njangi.sameUrlReloadAt';
/** A same-URL failure this soon after a click came from that click. */
const CLICK_WINDOW_MS = 10_000;
/** Never reload twice in a row: a failure that survives a reload is not skew. */
const RELOAD_COOLDOWN_MS = 30_000;

/**
 * Handles Next's "Invariant: attempted to hard navigate to the same URL"
 * (Sentry JAVASCRIPT-NEXTJS-3).
 *
 * Every page here matches the middleware, so after hydration Next re-checks it
 * from the client: the router replaces the URL with itself (`_h: 1`) and
 * fetches `/_next/data/…json`. If that fetch fails (a flaky network, an
 * extension blocking it, a deploy landing mid-load), Next wants a full page
 * load, refuses because the target is the page already showing, and throws
 * this as an unhandled rejection. The page is fine, so that case is silenced.
 *
 * The same failure after a real click on a link to the current page (the
 * wordmark on `/` in a tab opened before a deploy) makes the click do nothing.
 * There it becomes the reload Next meant, once, never in a loop. The two are
 * told apart by `routeChangeStart`, which Next emits for clicks but not for
 * its own hydration replace.
 */
export function useSameUrlNavigationRecovery(): void {
  const { events } = useRouter();

  useEffect(() => {
    let clickedAt = 0;
    const onRouteChangeStart = () => {
      clickedAt = Date.now();
    };

    const onRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason as { message?: unknown } | null | undefined;
      if (typeof reason?.message !== 'string' || !reason.message.startsWith(SAME_URL_INVARIANT)) {
        return;
      }
      event.preventDefault();
      if (Date.now() - clickedAt > CLICK_WINDOW_MS) return;

      try {
        const last = Number(window.sessionStorage.getItem(RELOAD_STAMP_KEY) ?? 0);
        if (Date.now() - last < RELOAD_COOLDOWN_MS) return;
        window.sessionStorage.setItem(RELOAD_STAMP_KEY, String(Date.now()));
      } catch {
        // No sessionStorage means no loop guard, so no reload.
        return;
      }
      window.location.reload();
    };

    events.on('routeChangeStart', onRouteChangeStart);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      events.off('routeChangeStart', onRouteChangeStart);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, [events]);
}
