// Sentry edge-runtime init (middleware, edge routes). Loaded from
// src/instrumentation.ts when NEXT_RUNTIME === 'edge'.
// Fully a no-op when no DSN is set.
//
// Lives in src/ (not the repo root) because tsconfig rootDir is "src";
// the SDK does not require a fixed location for server/edge configs —
// only the explicit import from the instrumentation hook loads them.
import * as Sentry from '@sentry/nextjs';

const dsn = process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.VERCEL_ENV || process.env.NODE_ENV || 'development',
    release: process.env.NEXT_PUBLIC_APP_VERSION,
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? '0.1'),
    sendDefaultPii: false,
  });
}
