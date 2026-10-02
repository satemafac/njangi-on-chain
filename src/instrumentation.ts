// Next.js instrumentation hook (stable in Next 15). Loads the Sentry runtime
// configs once per server process. Each config file guards on its DSN env
// var, so this whole file is a no-op when Sentry is not configured.
import type { Instrumentation } from 'next';
import * as Sentry from '@sentry/nextjs';
import { isNextBodyParseError } from './lib/sentry-filters';

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config');
  }

  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config');
  }
}

// Forwards uncaught request errors (API routes, SSR) to Sentry. Safe without
// a DSN: captureRequestError is a no-op on an uninitialised client. Next also
// passes on the body parser's rejections of malformed request bodies, which
// it has already answered with a 400; those are not server faults and are
// not reported.
export const onRequestError: Instrumentation.onRequestError = (error, request, context) => {
  if (isNextBodyParseError(error)) return;
  return Sentry.captureRequestError(error, request, context);
};
