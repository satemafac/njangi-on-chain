import React, { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useTranslation } from '../hooks/useTranslation';
import {
  IDLE_SIGN_IN_STATE,
  startSignIn,
  type SignInStartState,
} from '../lib/sign-in-start';
import type { OAuthProvider } from '../services/zkLoginService';

type LoginButtonProps = {
  variant?: 'default' | 'landing';
  className?: string;
};

type LoginButtonViewProps = LoginButtonProps & {
  state: SignInStartState;
  onSelect: (provider: OAuthProvider) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
};

const providers: OAuthProvider[] = ['Google', 'Facebook', 'Apple'];

function ProviderIcon({
  provider,
  className,
}: {
  provider: OAuthProvider;
  className?: string;
}) {
  if (provider === 'Google') {
    return (
      <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
        <path
          fill="#4285F4"
          d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
        />
        <path
          fill="#34A853"
          d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
        />
        <path
          fill="#FBBC05"
          d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
        />
        <path
          fill="#EA4335"
          d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
        />
      </svg>
    );
  }

  if (provider === 'Facebook') {
    return (
      <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
        <path
          fill="currentColor"
          d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"
        />
      </svg>
    );
  }

  return (
    <svg className={className} viewBox="0 0 814 1000" aria-hidden="true">
      <path
        fill="currentColor"
        d="M788.1 340.9c-5.8 4.5-108.2 62.2-108.2 190.5 0 148.4 130.3 200.9 134.2 202.2-.6 3.2-20.7 71.9-68.7 141.9-42.8 61.6-87.5 123.1-155.5 123.1s-85.5-39.5-164-39.5c-76.5 0-103.7 40.8-165.9 40.8s-105.6-57-155.5-127C46.7 790.7 0 663 0 541.8c0-194.4 126.4-297.5 250.8-297.5 66.1 0 121.2 43.4 162.7 43.4 39.5 0 101.1-46 176.3-46 28.5 0 130.9 2.6 198.3 99.2zm-234-181.5c31.1-36.9 53.1-88.1 53.1-139.3 0-7.1-.6-14.3-1.9-20.1-50.6 1.9-110.8 33.7-147.1 75.8-28.5 32.4-55.1 83.6-55.1 135.5 0 7.8 1.3 15.6 1.9 18.1 3.2.6 8.4 1.3 13.6 1.3 45.4 0 102.5-30.4 135.5-71.3z"
      />
    </svg>
  );
}

/** The buttons, given their state. Stateless so each state can be rendered in a test. */
export function LoginButtonView({
  variant = 'default',
  className = '',
  state,
  onSelect,
  t,
}: LoginButtonViewProps) {
  const busy = state.pending !== null;
  const label = (provider: OAuthProvider) =>
    state.pending === provider
      ? t('auth.startingProvider', { provider })
      : `Continue with ${provider}`;
  // Every button locks while one provider opens; the others fade.
  const busyTone = (provider: OAuthProvider) =>
    !busy ? '' : state.pending === provider ? 'cursor-wait' : 'cursor-not-allowed opacity-50';
  const failureNotice = (extraClass: string) =>
    state.failure ? (
      <p
        role="alert"
        className={`rounded-2xl border border-[#f1c4bc] bg-[#fff4f2] px-4 py-3 text-left text-sm leading-6 text-[#9b2c1f] ${extraClass}`.trim()}
      >
        {t(state.failure)}
      </p>
    ) : null;

  if (variant === 'landing') {
    return (
      <div className={`grid w-full gap-3 sm:grid-cols-3 ${className}`.trim()}>
        {failureNotice('col-span-full')}
        {providers.map((provider) => {
          const providerTone =
            provider === 'Facebook'
              ? 'text-[#1877F2]'
              : provider === 'Apple'
                ? 'text-[#111827]'
                : '';

          return (
            <button
              key={provider}
              type="button"
              onClick={() => onSelect(provider)}
              disabled={busy}
              aria-busy={state.pending === provider || undefined}
              className={`group flex items-center gap-3 rounded-2xl border border-[#d8d1c5] bg-white px-4 py-3 text-left text-[#1f2430] shadow-[0_18px_40px_-32px_rgba(15,23,42,0.45)] transition-all duration-200 hover:-translate-y-0.5 hover:border-[#c9c0b2] hover:bg-[#fcfbf8] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#70819b]/35 disabled:hover:translate-y-0 ${busyTone(provider)}`.trim()}
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-[#ece5db] bg-[#f7f4ee]">
                <ProviderIcon
                  provider={provider}
                  className={`h-5 w-5 ${providerTone}`.trim()}
                />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-[#171923]">
                  {provider}
                </span>
                <span className="block text-xs text-[#667085]">
                  {label(provider)}
                </span>
              </span>
              {state.pending === provider ? (
                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[#98a2b3]" aria-hidden="true" />
              ) : (
                <svg
                  className="h-4 w-4 shrink-0 text-[#98a2b3] transition-transform duration-200 group-hover:translate-x-0.5"
                  viewBox="0 0 16 16"
                  fill="none"
                  aria-hidden="true"
                >
                  <path
                    d="M3.333 8h9.334m0 0L8.667 4m4 4-4 4"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div className={`flex flex-col items-center gap-4 ${className}`.trim()}>
      {failureNotice('w-full max-w-sm')}
      <button
        type="button"
        onClick={() => onSelect('Google')}
        disabled={busy}
        aria-busy={state.pending === 'Google' || undefined}
        className={`inline-flex items-center rounded-lg bg-blue-600 px-6 py-2 font-medium text-white transition-colors duration-200 hover:bg-blue-700 ${busyTone('Google')}`.trim()}
      >
        <ProviderIcon provider="Google" className="mr-2 h-5 w-5" />
        {label('Google')}
      </button>

      <button
        type="button"
        onClick={() => onSelect('Facebook')}
        disabled={busy}
        aria-busy={state.pending === 'Facebook' || undefined}
        className={`inline-flex items-center rounded-lg bg-[#1877F2] px-6 py-2 font-medium text-white transition-colors duration-200 hover:bg-[#0C63D4] ${busyTone('Facebook')}`.trim()}
      >
        <ProviderIcon provider="Facebook" className="mr-2 h-5 w-5" />
        {label('Facebook')}
      </button>

      <button
        type="button"
        onClick={() => onSelect('Apple')}
        disabled={busy}
        aria-busy={state.pending === 'Apple' || undefined}
        className={`inline-flex items-center rounded-lg bg-black px-6 py-2 font-medium text-white transition-colors duration-200 hover:bg-gray-800 ${busyTone('Apple')}`.trim()}
      >
        <ProviderIcon provider="Apple" className="mr-2 h-5 w-5" />
        {label('Apple')}
      </button>
    </div>
  );
}

export function LoginButton(props: LoginButtonProps) {
  const { login } = useAuth();
  const { t } = useTranslation();
  const [state, setState] = useState<SignInStartState>(IDLE_SIGN_IN_STATE);
  // A second click before the first re-render must not start a second login.
  const inFlight = useRef(false);

  useEffect(() => {
    // The back button can restore this page from the back-forward cache with a
    // provider still "opening"; start over instead.
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      inFlight.current = false;
      setState(IDLE_SIGN_IN_STATE);
    };
    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
  }, []);

  const handleSelect = (provider: OAuthProvider) => {
    if (inFlight.current) return;
    inFlight.current = true;
    void startSignIn(provider, login, (next) => {
      if (next.pending === null) inFlight.current = false;
      setState(next);
    });
  };

  return <LoginButtonView {...props} state={state} onSelect={handleSelect} t={t} />;
}
