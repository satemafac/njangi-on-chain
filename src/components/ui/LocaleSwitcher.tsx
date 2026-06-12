import React, { useEffect, useRef, useState } from 'react';
import { Globe } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import { SUPPORTED_LOCALE_OPTIONS, type Locale } from '@/lib/i18n';

/**
 * Minimal EN / FR dropdown. Backs onto the tiny `src/lib/i18n.ts` store
 * (no i18next dependency); flipping the locale immediately re-renders
 * any component that uses `useTranslation`.
 */
export function LocaleSwitcher({ compact = false }: { compact?: boolean }) {
  const { locale, setLocale } = useTranslation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (event: MouseEvent) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const currentLabel = SUPPORTED_LOCALE_OPTIONS.find((opt) => opt.code === locale)?.label ?? locale;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={
          compact
            ? 'inline-flex items-center gap-1 rounded-full border border-stone-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:border-stone-300 hover:bg-stone-50'
            : 'inline-flex h-10 items-center gap-2 rounded-full border border-stone-200 bg-white px-3 text-sm font-medium text-slate-600 transition hover:border-stone-300 hover:bg-stone-50'
        }
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <Globe className={compact ? 'h-3.5 w-3.5' : 'h-4 w-4'} />
        <span>{locale.toUpperCase()}</span>
      </button>
      {open ? (
        <div
          role="listbox"
          className="absolute right-0 z-50 mt-2 w-40 overflow-hidden rounded-xl border border-stone-200 bg-white shadow-lg"
        >
          {SUPPORTED_LOCALE_OPTIONS.map((opt) => (
            <button
              key={opt.code}
              type="button"
              role="option"
              aria-selected={opt.code === locale}
              onClick={() => {
                setLocale(opt.code as Locale);
                setOpen(false);
              }}
              className={`flex w-full items-center justify-between px-3 py-2 text-sm transition hover:bg-stone-50 ${
                opt.code === locale ? 'font-semibold text-emerald-700' : 'text-slate-700'
              }`}
            >
              <span>{opt.label}</span>
              <span className="text-xs uppercase tracking-wider text-slate-400">
                {opt.code}
              </span>
            </button>
          ))}
        </div>
      ) : null}
      <span className="sr-only">{currentLabel}</span>
    </div>
  );
}

export default LocaleSwitcher;
