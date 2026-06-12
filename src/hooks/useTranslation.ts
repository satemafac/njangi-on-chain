import { useCallback, useEffect, useState } from 'react';
import { getLocale, onLocaleChange, setLocale, t, type Locale } from '@/lib/i18n';

/**
 * Minimal i18n hook. Re-renders components when the global locale flips
 * (e.g. user toggles EN ↔ FR from the navbar).
 */
export function useTranslation() {
  const [, force] = useState(0);
  useEffect(() => onLocaleChange(() => force((n) => n + 1)), []);
  const translate = useCallback(
    (key: string, vars?: Record<string, string | number>) => t(key, vars),
    [],
  );
  return {
    t: translate,
    locale: getLocale() as Locale,
    setLocale,
  };
}
