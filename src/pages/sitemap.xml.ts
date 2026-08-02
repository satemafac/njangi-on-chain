// /sitemap.xml — generated from src/lib/seo-routes.ts.
//
// Replaces the hand-maintained public/sitemap.xml, in which 45 of 57 URLs were
// 404s (phantom pages like /chitfunds-blockchain and /stokvel-crypto that were
// never built) while /pricing and /legal/* were missing entirely.
//
// NOTE: public/sitemap.xml had to be deleted for this route to be reachable at
// all. Next resolves the public folder before page files
// (server/lib/router-utils/filesystem.js), and on Vercel a file in public/
// becomes a CDN asset the function never sees. Do not re-add it.

import type { GetServerSideProps } from 'next';

import { SITE_ROUTES, type SiteRoute } from '@/lib/seo-routes';
import { SITE_URL } from '@/lib/structured-data';

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Exported so the sitemap can be asserted in a unit test without a server. */
export function buildSitemapXml(
  routes: SiteRoute[] = SITE_ROUTES,
  origin: string = SITE_URL
): string {
  const body = routes
    .map((route) =>
      [
        '  <url>',
        `    <loc>${xmlEscape(origin + route.path)}</loc>`,
        `    <lastmod>${route.lastmod}</lastmod>`,
        `    <changefreq>${route.changefreq}</changefreq>`,
        `    <priority>${route.priority.toFixed(1)}</priority>`,
        '  </url>',
      ].join('\n')
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

export const getServerSideProps: GetServerSideProps = async ({ res }) => {
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader(
    'Cache-Control',
    'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400'
  );
  // Always the canonical origin, never the request host: a crawl arriving at a
  // www or *.vercel.app hostname would otherwise emit URLs that immediately
  // redirect, which Search Console reports as a sitemap full of errors.
  res.write(buildSitemapXml());
  res.end();
  return { props: {} };
};

// Required for this file to register as a page route. Never rendered — the
// response is already finished by the time Next would call it.
export default function Sitemap() {
  return null;
}
