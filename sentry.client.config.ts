// Sentry browser-side init. Injected into the client bundle by
// withSentryConfig (next.config.js). Fully a no-op when no DSN is set.
//
// Note: only NEXT_PUBLIC_* env vars are inlined into client bundles, so the
// browser DSN must be NEXT_PUBLIC_SENTRY_DSN. DSNs are write-only ingest
// keys, not secrets.
import * as Sentry from '@sentry/nextjs';

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
  });
}
