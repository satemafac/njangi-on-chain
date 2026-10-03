// Sentry browser-side init. Injected into the client bundle by
// withSentryConfig (next.config.js). Fully a no-op when no DSN is set.
//
// Note: only NEXT_PUBLIC_* env vars are inlined into client bundles, so the
// browser DSN must be NEXT_PUBLIC_SENTRY_DSN. DSNs are write-only ingest
// keys, not secrets.
import * as Sentry from '@sentry/nextjs';
import { scrubSentryBreadcrumb, scrubSentryEvent } from './src/lib/sentry-filters';

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment:
      process.env.NEXT_PUBLIC_VERCEL_ENV || process.env.NODE_ENV || 'development',
    release: process.env.NEXT_PUBLIC_APP_VERSION,
    tracesSampleRate: Number(process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE ?? '0.1'),
    // zkLogin/PII hygiene: never attach request bodies, cookies, or user IP.
    sendDefaultPii: false,
    // sendDefaultPii does not cover URLs or log lines: every event carries
    // location.href with its fragment (the OAuth id_token on /auth/callback),
    // and breadcrumbs keep URLs and console arguments. The scrubber strips
    // fragments, query values, share tokens and token-shaped strings
    // (src/lib/sentry-filters.ts).
    beforeSend: scrubSentryEvent,
    beforeSendTransaction: scrubSentryEvent,
    beforeBreadcrumb: scrubSentryBreadcrumb,
    // Next's post-hydration middleware re-check throws this when its data
    // fetch fails, although the page itself is fine. It is handled in
    // useSameUrlNavigationRecovery (silenced, or one reload after a real
    // click), so it is expected rather than an error (JAVASCRIPT-NEXTJS-3).
    ignoreErrors: [/^Invariant: attempted to hard navigate to the same URL/],
  });
}
