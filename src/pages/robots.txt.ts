// /robots.txt — generated from src/lib/seo-routes.ts.
//
// Replaces public/robots.txt, which had two defects worth spelling out because
// they are easy to reintroduce:
//
// 1. It ended with per-crawler groups:
//
//        User-agent: Googlebot
//        Allow: /
//
//    Under RFC 9309 a crawler obeys the single most specific group that matches
//    it and ignores every other group. So Googlebot read only "Allow: /" and
//    discarded all the Disallow lines in the "*" group — meaning /api/, /auth/
//    and /admin/ were, in practice, fully crawlable by Google. Do not add
//    per-crawler groups unless they restate every rule they need.
//
// 2. "Disallow: /_next/" blocked the JS and CSS Google needs to render pages.
//    Blocking render resources degrades indexing; the directory is safe to crawl.
//
// Also removed: ~20 Allow: lines for pages that do not exist, Allow: /dashboard
// and /create-circle (both noindex), a second Sitemap: line pointing at the www
// host (which 308-redirects, and a redirecting Sitemap: is a Search Console
// error), and Crawl-delay: 1 (Googlebot ignores it; Bing honours it and it
// needlessly throttles a small site).

import type { GetServerSideProps } from 'next';

import { APP_ROUTE_PREFIXES } from '@/lib/seo-routes';
import { SITE_URL } from '@/lib/structured-data';

/** Exported so robots.txt can be asserted in a unit test without a server. */
export function buildRobotsTxt(origin: string = SITE_URL): string {
  return [
    'User-agent: *',
    'Allow: /',
    '',
    '# Auth-gated, member-specific, and operator-only surfaces. These are never',
    '# linked from an indexable page, so there is no URL-only indexing risk in',
    '# disallowing them outright.',
    'Disallow: /api/',
    ...APP_ROUTE_PREFIXES.map((prefix) => `Disallow: ${prefix}`),
    '',
    '# /restricted is deliberately NOT disallowed. A disallowed URL is never',
    '# fetched, so the crawler would never see its noindex and the URL could',
    '# still be indexed from a link. It carries noindex instead.',
    '',
    `Sitemap: ${origin}/sitemap.xml`,
    '',
  ].join('\n');
}

export const getServerSideProps: GetServerSideProps = async ({ res }) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader(
    'Cache-Control',
    'public, max-age=0, s-maxage=86400, stale-while-revalidate=604800'
  );
  res.write(buildRobotsTxt());
  res.end();
  return { props: {} };
};

// Required for this file to register as a page route. Never rendered.
export default function Robots() {
  return null;
}
