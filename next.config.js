const { withSentryConfig } = require('@sentry/nextjs');
const packageJson = require('./package.json');

// ---------------------------------------------------------------------------
// CORS allowlist (June 2026 ops-readiness audit fix)
//
// The old config sent `Access-Control-Allow-Origin: *` together with
// `Access-Control-Allow-Credentials: true` on every /api/* route. Browsers
// reject that combination for credentialed requests, and the wildcard exposed
// non-credentialed internal endpoints to any origin. Instead we reflect the
// request Origin back *only* when it matches the allowlist (the deployed app
// origin plus localhost in development), via Next's `has` header matching
// with a named capture group. Requests from any other origin get no CORS
// headers at all (deny by default). Routes that need a wider per-route
// allowlist (e.g. the Coinbase onramp endpoints) keep managing their own
// headers and override these.
// ---------------------------------------------------------------------------
function normalizeOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const appOrigin = normalizeOrigin(
  process.env.NEXT_PUBLIC_APP_URL ||
    process.env.NEXT_PUBLIC_BASE_URL ||
    'https://njangionchain.com',
);
const devOrigins =
  process.env.NODE_ENV === 'production'
    ? []
    : ['http://localhost:3000', 'http://127.0.0.1:3000'];
const allowedCorsOrigins = [...new Set([appOrigin, ...devOrigins].filter(Boolean))];
const corsOriginPattern = `(?<corsOrigin>${allowedCorsOrigins.map(escapeRegExp).join('|')})`;

// Report-only CSP to start collecting violation data without breaking the
// OAuth / fiat-ramp / RPC integrations. Tighten into an enforcing
// Content-Security-Policy once the report noise is understood.
const contentSecurityPolicyReportOnly = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https:",
  "style-src 'self' 'unsafe-inline' https:",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data: https:",
  "connect-src 'self' https: wss:",
  "frame-src 'self' https:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self' https:",
  "frame-ancestors 'none'",
].join('; ');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Disable ESLint during build to prevent build failures
  eslint: {
    ignoreDuringBuilds: true,
  },
  // Add environment variables
  env: {
    NEXT_PUBLIC_BASE_URL: process.env.NEXT_PUBLIC_BASE_URL || 'https://njangionchain.com',
    // Surfaced by /api/health; build-time inlined so the lambda bundle does
    // not need to read package.json from disk at runtime.
    NEXT_PUBLIC_APP_VERSION: packageJson.version,
  },
  images: {
    domains: [
      'lh3.googleusercontent.com',  // Google profile pictures
      'platform-lookaside.fbsbx.com', // Facebook profile pictures
      'graph.facebook.com'  // Alternative Facebook CDN
    ],
    dangerouslyAllowSVG: true,
    contentDispositionType: 'attachment',
    contentSecurityPolicy: "default-src 'self'; script-src 'none'; sandbox;",
    unoptimized: false, // Enable image optimization
  },
  // Handle CORS for API routes and security headers
  async headers() {
    return [
      {
        // CORS for API routes: reflect the Origin header back only when it
        // matches the allowlist. Never `*` together with credentials.
        source: "/api/:path*",
        has: [
          {
            type: 'header',
            key: 'origin',
            value: corsOriginPattern,
          },
        ],
        headers: [
          { key: "Access-Control-Allow-Credentials", value: "true" },
          { key: "Access-Control-Allow-Origin", value: ":corsOrigin" },
          { key: "Vary", value: "Origin" },
          { key: "Access-Control-Allow-Methods", value: "GET,OPTIONS,PATCH,DELETE,POST,PUT" },
          { key: "Access-Control-Allow-Headers", value: "X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version" },
        ]
      },
      {
        // Security headers for all routes
        source: '/(.*)',
        headers: [
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=31536000; includeSubDomains; preload'
          },
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff'
          },
          {
            key: 'X-Frame-Options',
            value: 'DENY'
          },
          {
            key: 'X-XSS-Protection',
            value: '1; mode=block'
          },
          {
            key: 'Referrer-Policy',
            value: 'strict-origin-when-cross-origin'
          },
          {
            key: 'Content-Security-Policy-Report-Only',
            value: contentSecurityPolicyReportOnly
          }
        ]
      }
    ]
  },
  // Add redirects to force HTTPS
  async redirects() {
    return [
      {
        source: '/:path*',
        has: [
          {
            type: 'header',
            key: 'x-forwarded-proto',
            value: 'http',
          },
        ],
        destination: 'https://njangionchain.com/:path*',
        permanent: true,
      },
    ]
  },
  // Handle trailing slash for Heroku
  trailingSlash: false,
  // Disable sourcemaps in production
  productionBrowserSourceMaps: false,
};

// Sentry is a no-op unless a DSN is configured (see sentry.*.config.ts and
// src/instrumentation.ts). The build-time wrapper only uploads source maps
// when SENTRY_AUTH_TOKEN is present, so local/CI builds stay untouched.
module.exports = withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: true,
  telemetry: false,
  widenClientFileUpload: false,
  sourcemaps: {
    disable: !process.env.SENTRY_AUTH_TOKEN,
  },
});
