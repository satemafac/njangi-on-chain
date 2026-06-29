import { useEffect } from 'react';
import { getLocaleDirection, hydrateLocale } from '@/lib/i18n';
import { useTranslation } from '@/hooks/useTranslation';

/**
 * Keeps `document.documentElement.lang` and `dir` in sync with the
 * active njangi locale. Mounts once at the app root; re-runs every time
 * the user flips locales via the navbar switcher. This is the single
 * place in the app that touches the `<html>` attributes so there's no
 * drift between _document.tsx SSR and client state.
 *
 * It also applies the persisted/browser locale once on mount (after
 * hydration) — module init stays on 'en' so the first client render matches
 * the SSR HTML, avoiding a hydration mismatch when a non-EN locale is stored.
 */
export function LocaleDirSync() {
  const { locale } = useTranslation();
  // Post-hydration: switch to the stored/browser locale (no-op if already EN).
  useEffect(() => {
    hydrateLocale();
  }, []);
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const html = document.documentElement;
    if (html.lang !== locale) html.lang = locale;
    const dir = getLocaleDirection(locale);
    if (html.dir !== dir) html.dir = dir;
  }, [locale]);
  return null;
}

export default LocaleDirSync;
