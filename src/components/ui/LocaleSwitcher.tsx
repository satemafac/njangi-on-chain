import React, { useEffect, useRef, useState } from 'react';
import { Globe } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import { SUPPORTED_LOCALE_OPTIONS, type Locale } from '@/lib/i18n';

/**
 * Minimal locale dropdown. Backs onto the tiny `src/lib/i18n.ts` store
 * (no i18next dependency); flipping the locale immediately re-renders
 * any component that uses `useTranslation`.
 *
 * `variant` themes the control: 'light' (default) for the app's light pages,
 * 'dark' for the near-black landing. Only the className strings change — the
 * markup, behavior, and a11y attributes are identical across variants.
 */
export function LocaleSwitcher({
  compact = false,
  variant = 'light',
}: {
  compact?: boolean;
  variant?: 'light' | 'dark';
}) {
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

  const isDark = variant === 'dark';

  const triggerClass = isDark
    ? compact
      ? 'inline-flex items-center gap-1.5 rounded-full border border-[#2a2620] bg-[#13121a]/70 px-3 py-2 text-xs font-medium text-[#cfc8ba] transition hover:border-[#E8B04B]/50 hover:text-[#f6d99a] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f6d99a]'
      : 'inline-flex h-10 items-center gap-2 rounded-full border border-[#2a2620] bg-[#13121a]/70 px-4 text-sm font-medium text-[#cfc8ba] transition hover:border-[#E8B04B]/50 hover:text-[#f6d99a] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f6d99a]'
    : compact
      ? 'inline-flex items-center gap-1 rounded-full border border-stone-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:border-stone-300 hover:bg-stone-50'
      : 'inline-flex h-10 items-center gap-2 rounded-full border border-stone-200 bg-white px-3 text-sm font-medium text-slate-600 transition hover:border-stone-300 hover:bg-stone-50';

  const panelClass = isDark
    ? 'absolute right-0 z-50 mt-2 w-44 overflow-hidden rounded-2xl border border-[#2a2620] bg-[#13121a] shadow-[0_24px_60px_-30px_rgba(0,0,0,0.9)]'
    : 'absolute right-0 z-50 mt-2 w-40 overflow-hidden rounded-xl border border-stone-200 bg-white shadow-lg';

  const optionClass = (selected: boolean) =>
    isDark
      ? `flex w-full items-center justify-between px-4 py-2.5 text-sm transition hover:bg-white/[0.04] ${
          selected ? 'font-semibold text-[#E8B04B]' : 'text-[#cfc8ba]'
        }`
      : `flex w-full items-center justify-between px-3 py-2 text-sm transition hover:bg-stone-50 ${
          selected ? 'font-semibold text-emerald-700' : 'text-slate-700'
        }`;

  const codeClass = isDark
    ? 'text-xs uppercase tracking-wider text-[#8b8578]'
    : 'text-xs uppercase tracking-wider text-slate-400';

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={triggerClass}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <Globe className={compact ? 'h-3.5 w-3.5' : 'h-4 w-4'} />
        <span>{locale.toUpperCase()}</span>
      </button>
      {open ? (
        <div role="listbox" className={panelClass}>
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
              className={optionClass(opt.code === locale)}
            >
              <span>{opt.label}</span>
              <span className={codeClass}>{opt.code}</span>
            </button>
          ))}
        </div>
      ) : null}
      <span className="sr-only">{currentLabel}</span>
    </div>
  );
}

export default LocaleSwitcher;
