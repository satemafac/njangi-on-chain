// seo-routes.ts — the single source of truth for which URLs this site has.
//
// One table feeds the sitemap, robots.txt, the noindex decision, and the
// route-existence test. The previous arrangement kept three hand-maintained
// copies of that knowledge (public/sitemap.xml, public/robots.txt, and per-page
// meta) and they drifted badly: 45 of the 57 sitemap URLs were 404s, and
// robots.txt explicitly Allow:'d those same nonexistent paths.
//
// Adding a public page means adding it here. src/__tests__/seo/routes-exist.test.ts
// asserts every entry resolves to a real file under src/pages, so a typo or a
// deleted page fails the build instead of quietly becoming a 404 in the sitemap.
//
// Imported by src/middleware.ts (edge runtime) — keep this module free of Node
// built-ins and of anything that pulls in a heavy dependency graph.

/**
 * App surfaces: auth-gated, member-specific, or operator-only. Blocked for
 * embargoed jurisdictions (docs/sanctions-program.md), excluded from the
 * sitemap, and served noindex.
 *
 * /restricted must never appear here — middleware redirects *to* it, so
 * including it would be a redirect loop. It is in NOINDEX_PREFIXES instead.
 */
export const APP_ROUTE_PREFIXES = [
  '/dashboard',
  '/create-circle',
  '/circle',
  '/pool',
  '/auth',
  '/admin',
  '/automation',
] as const;

export const NOINDEX_PREFIXES = [...APP_ROUTE_PREFIXES, '/restricted'] as const;

/**
 * Match on the Next route *pattern* (router.pathname, e.g. "/circle/[id]/goals"),
 * not asPath — stable during SSR and it never leaks a circle id into a decision.
 */
export function isNoindexRoute(pathname: string): boolean {
  return NOINDEX_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
}

import { ROSCA_TERMS } from '@/content/rosca-terms';

export type ChangeFreq = 'daily' | 'weekly' | 'monthly' | 'yearly';

export interface SiteRoute {
  /** Public URL path, no trailing slash (next.config.js sets trailingSlash: false). */
  path: `/${string}`;
  /**
   * Source file relative to src/pages, without extension. Checked against the
   * filesystem by the route-existence test — this is the anti-404 guard.
   * Dynamic routes name the pattern file, e.g. "legal/[doc]".
   */
  page: string;
  lastmod: string;
  changefreq: ChangeFreq;
  priority: number;
}

export const SITE_ROUTES: SiteRoute[] = [
  { path: '/', page: 'index', lastmod: '2026-08-02', changefreq: 'weekly', priority: 1.0 },
  { path: '/learn', page: 'learn/index', lastmod: '2026-08-02', changefreq: 'weekly', priority: 0.9 },
  {
    path: '/learn/what-is-njangi',
    page: 'learn/what-is-njangi',
    lastmod: '2026-08-02',
    changefreq: 'monthly',
    priority: 0.9,
  },
  {
    path: '/learn/rosca',
    page: 'learn/rosca',
    lastmod: '2026-08-02',
    changefreq: 'monthly',
    priority: 0.9,
  },
  {
    path: '/learn/tontine',
    page: 'learn/tontine',
    lastmod: '2026-08-02',
    changefreq: 'monthly',
    priority: 0.8,
  },
  {
    path: '/learn/susu',
    page: 'learn/susu',
    lastmod: '2026-08-02',
    changefreq: 'monthly',
    priority: 0.8,
  },
  // The glossary. Derived from the same array that drives getStaticPaths in
  // src/pages/learn/[term].tsx, so a term can never be in one and not the other.
  ...ROSCA_TERMS.map(
    (term): SiteRoute => ({
      path: `/learn/${term.slug}`,
      // A term promoted to a pillar is served by its own file, not the
      // dynamic route, and the route-existence test checks the real path.
      page: term.hasPillarPage ? `learn/${term.slug}` : 'learn/[term]',
      lastmod: term.modified,
      changefreq: 'monthly',
      priority: term.hasPillarPage ? 0.9 : 0.7,
    })
  ),
  { path: '/faq', page: 'faq', lastmod: '2026-08-02', changefreq: 'monthly', priority: 0.8 },
  { path: '/pricing', page: 'pricing', lastmod: '2026-08-02', changefreq: 'monthly', priority: 0.7 },
  { path: '/blog', page: 'blog/index', lastmod: '2026-08-02', changefreq: 'weekly', priority: 0.6 },
  {
    path: '/blog/african-diaspora-remittances',
    page: 'blog/african-diaspora-remittances',
    lastmod: '2026-08-28',
    changefreq: 'yearly',
    priority: 0.6,
  },
  {
    path: '/blog/women-led-savings-circles-africa',
    page: 'blog/women-led-savings-circles-africa',
    lastmod: '2026-08-24',
    changefreq: 'yearly',
    priority: 0.6,
  },
  {
    path: '/blog/traditional-savings-circles-vs-on-chain',
    page: 'blog/traditional-savings-circles-vs-on-chain',
    lastmod: '2026-08-02',
    changefreq: 'yearly',
    priority: 0.6,
  },
  { path: '/legal/terms', page: 'legal/[doc]', lastmod: '2026-08-02', changefreq: 'yearly', priority: 0.3 },
  { path: '/legal/privacy', page: 'legal/[doc]', lastmod: '2026-08-02', changefreq: 'yearly', priority: 0.3 },
  { path: '/legal/risk', page: 'legal/[doc]', lastmod: '2026-08-02', changefreq: 'yearly', priority: 0.3 },
  {
    path: '/legal/data-deletion',
    page: 'legal/data-deletion',
    lastmod: '2026-08-02',
    changefreq: 'yearly',
    priority: 0.3,
  },
];

export function routeFor(path: string): SiteRoute | undefined {
  return SITE_ROUTES.find((route) => route.path === path);
}
