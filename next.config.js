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
  // Bundle the legal markdown into the serverless lambdas. /api/legal/doc reads
  // docs/legal-drafts/*.md from process.cwd() at RUNTIME (doc.ts:48) to render
  // the acceptance-modal content; without this, @vercel/nft never traces the
  // files into the function bundle and the route 500s (ENOENT) in production,
  // which leaves the scroll-gated risk checkbox permanently locked and blocks
  // every new user at the legal gate. (.vercelignore only un-ignores the dir
  // for the build-time SSG read of /legal/[doc], not the runtime API.)
  outputFileTracingIncludes: {
    '/api/legal/doc': ['./docs/legal-drafts/*.md'],
    '/legal/[doc]': ['./docs/legal-drafts/*.md'],
  },
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
    // `domains` is deprecated in Next 15 in favour of remotePatterns.
    remotePatterns: [
      { protocol: 'https', hostname: 'lh3.googleusercontent.com' },  // Google profile pictures
      { protocol: 'https', hostname: 'platform-lookaside.fbsbx.com' }, // Facebook profile pictures
      { protocol: 'https', hostname: 'graph.facebook.com' },  // Alternative Facebook CDN
    ],
    // Next defaults to webp only; avif first, and the browser's Accept header
    // picks the first it supports.
    formats: ['image/avif', 'image/webp'],
    minimumCacheTTL: 31536000,
    // NOTE: this is load-bearing — src/pages/dashboard.tsx serves
    // public/images/{sui-sui,usd-coin-usdc}-logo.svg through next/image. It is
    // a global exception for two local icons, and it also lets SVGs from the
    // three remote avatar hosts above through the optimizer. The mitigations
    // below (script-src 'none', sandbox, attachment) are the documented ones.
    // Worth revisiting by marking those two icons `unoptimized` and turning
    // this off — out of scope here, flagged deliberately.
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
      },
      // Vercel serves public/ with `max-age=0, must-revalidate` by default, so
      // every icon is revalidated on every request. Icons and brand assets have
      // stable names AND stable content — bust them with a ?v= query, as the
      // landing already does for og.png.
      {
        source: '/icons/:path*',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
      },
      {
        source: '/brand/:path*',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
      },
      {
        // Share cards are regenerated when marketing copy changes. Deliberately
        // NOT immutable: combined with Facebook's aggressive scraper cache, a
        // copy fix would otherwise stay invisible for a very long time.
        source: '/og/:path*',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=604800, stale-while-revalidate=2592000' },
        ],
      },
      // Belt and braces alongside the meta robots tag from <Seo>: an
      // X-Robots-Tag header survives a 500 or a failed client render, and
      // covers non-HTML responses.
      ...['/dashboard', '/create-circle', '/restricted'].map((source) => ({
        source,
        headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }],
      })),
      ...['/circle', '/pool', '/auth', '/admin', '/automation'].map((prefix) => ({
        source: `${prefix}/:path*`,
        headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }],
      })),
      {
        source: '/api/:path*',
        headers: [{ key: 'X-Robots-Tag', value: 'noindex' }],
      },
    ]
  },
  // Add redirects to force HTTPS
  async redirects() {
    return [
      // Legacy OAuth callback route, removed 2026-07-14. Nothing in the
      // codebase links here, but an old OAuth client config could still
      // redirect to it — the fragment (#id_token=...) survives a 308, so
      // a stale provider entry keeps working through /auth/callback.
      {
        source: '/callback',
        destination: '/auth/callback',
        permanent: true,
      },
      // Legacy static legal stubs, removed 2026-08-02. They duplicated the real
      // /legal/* routes, were listed in the old sitemap, and — because Next
      // resolves public/ before page routes — a request for one served the
      // stale copy rather than the current document. Facebook app settings and
      // Play Store data-safety forms commonly point at exactly these URLs, so
      // they redirect rather than 404.
      { source: '/privacy-policy.html', destination: '/legal/privacy', permanent: true },
      { source: '/terms-of-service.html', destination: '/legal/terms', permanent: true },
      { source: '/data-deletion.html', destination: '/legal/data-deletion', permanent: true },
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
