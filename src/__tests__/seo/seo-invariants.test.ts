// Regression guards for the SEO work.
//
// Each of these pins a failure that actually happened in this repo, so they are
// worth keeping even though they look trivial:
//
//   routes  — public/sitemap.xml listed 57 URLs of which ~45 were 404s, for
//             pages that were never built (/chitfunds-blockchain,
//             /stokvel-crypto, ...). Nothing checked, so nothing complained.
//   heads   — _app and each page both emit SEO tags. next/head only dedups
//             <meta name=...> and only when the tag has NO key; <meta
//             property=...>, <link> and <script> are not deduped at all. A
//             hand-rolled tag left next to <Seo> therefore renders twice —
//             which is exactly what forced the SEO tags out of _document.tsx.
//   og      — six of the eight declared og:image URLs 404'd, so every learn,
//             blog and faq link shared to WhatsApp had no preview image.
//
// Deliberately filesystem and data assertions only: jest runs with
// testEnvironment 'node' here and must not try to render a .tsx page.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { SITE_ROUTES, isNoindexRoute } from '@/lib/seo-routes';
import { ROSCA_TERMS } from '@/content/rosca-terms';
import { buildRobotsTxt } from '@/pages/robots.txt';
import { buildSitemapXml } from '@/pages/sitemap.xml';
import * as SOURCED_FACTS from '@/content/sourced-facts';

const ROOT = join(__dirname, '../../..');
const PAGES = join(ROOT, 'src/pages');

/** Every .tsx under src/pages, as repo-relative paths. */
function pageFiles(dir = PAGES, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== 'api') pageFiles(full, acc);
    } else if (entry.endsWith('.tsx')) {
      acc.push(full);
    }
  }
  return acc;
}

describe('sitemap routes resolve to real pages', () => {
  it.each(SITE_ROUTES.map((route) => [route.path, route.page] as const))(
    '%s -> src/pages/%s',
    (_path, page) => {
      const direct = join(PAGES, `${page}.tsx`);
      const asIndex = join(PAGES, page, 'index.tsx');
      expect(existsSync(direct) || existsSync(asIndex)).toBe(true);
    }
  );

  it('covers every glossary term exactly once', () => {
    const inSitemap = SITE_ROUTES.filter((r) => r.page === 'learn/[term]').map((r) => r.path);
    expect(inSitemap.sort()).toEqual(ROSCA_TERMS.map((t) => `/learn/${t.slug}`).sort());
  });

  it('lists no noindex route', () => {
    expect(SITE_ROUTES.filter((r) => isNoindexRoute(r.path))).toEqual([]);
  });

  it('has no duplicate paths and no trailing slashes', () => {
    const paths = SITE_ROUTES.map((r) => r.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths.filter((p) => p !== '/' && p.endsWith('/'))).toEqual([]);
  });
});

describe('<Seo> is the single source of head tags', () => {
  // Allowlist nothing. If a page needs a tag Seo does not emit, it passes it as
  // a keyed child of <Seo>, not as a bare <Head>.
  const FORBIDDEN: Array<[string, RegExp]> = [
    ['og: meta', /<meta\s+property="og:/],
    ['twitter: meta', /<meta\s+(?:name|property)="twitter:/],
    ['canonical link', /<link\s+rel="canonical"/],
    ['description meta', /<meta\s+name="description"/],
    ['robots meta', /<meta\s+name="robots"/],
    ['raw ld+json', /type="application\/ld\+json"/],
  ];

  const files = pageFiles().filter(
    (f) => !f.endsWith(join('components', 'Seo.tsx'))
  );

  it.each(FORBIDDEN)('no page hand-rolls a %s', (_label, pattern) => {
    const offenders = files
      .filter((f) => pattern.test(readFileSync(f, 'utf8')))
      .map((f) => f.replace(`${ROOT}/`, ''));
    expect(offenders).toEqual([]);
  });
});

describe('open graph images exist', () => {
  const files = pageFiles();
  const referenced = new Set<string>();
  for (const file of files) {
    for (const match of readFileSync(file, 'utf8').matchAll(/url:\s*'(\/og\/[^']+)'/g)) {
      referenced.add(match[1]);
    }
  }

  it('references at least one card', () => {
    expect(referenced.size).toBeGreaterThan(0);
  });

  it('every referenced card is on disk', () => {
    const missing = [...referenced].filter((url) => !existsSync(join(ROOT, 'public', url)));
    expect(missing).toEqual([]);
  });

  it('no page still points at the removed hero jpgs or the stale og-image.png', () => {
    const stale = /\/images\/[a-z-]+-hero\.jpg|\/images\/blog\/|['"]\/og-image\.png/;
    const offenders = files
      .filter((f) => stale.test(readFileSync(f, 'utf8')))
      .map((f) => f.replace(`${ROOT}/`, ''));
    expect(offenders).toEqual([]);
  });
});

describe('no unsourced statistics on marketing pages', () => {
  // The learn pages carried invented figures presented as fact — "1B+ people",
  // "$500B+ annual volume", "80% women-led savings circles", and "200+ countries
  // with active savings circle traditions", which exceeds the number of
  // countries that exist. Google's helpful-content guidance treats
  // unverifiable claims as a quality signal against the site, and on a page
  // about other people's money they are a liability besides.
  //
  // Figures now live in src/content/sourced-facts.ts, each with a year and a
  // link, and render through <SourcedStat> so a number cannot appear without
  // its citation.
  const marketing = pageFiles().filter((f) =>
    /\/(learn|blog)\//.test(f) || f.endsWith(`${'faq'}.tsx`)
  );

  const RETIRED = [
    '1B+', '200+', '$500B+', '45M+', '$25B+',
    '80%</', '75% of', '100 million Africans', '$50+ billion',
    '40% of businesses', '$48 billion', '4M+ in United States',
    '1M+ Caribbean-heritage',
  ];

  it.each(RETIRED)('the retired claim %p is gone', (claim) => {
    const offenders = marketing
      .filter((f) => readFileSync(f, 'utf8').includes(claim))
      .map((f) => f.replace(`${ROOT}/`, ''));
    expect(offenders).toEqual([]);
  });

  it('every sourced fact carries a year, a source and a resolvable https link', () => {
    // Required at the type level too, but a fact with an empty string would
    // still compile and would render a citation that says nothing.
    for (const [name, fact] of Object.entries(SOURCED_FACTS)) {
      expect(`${name}:${fact.value}`.length).toBeGreaterThan(name.length);
      expect(fact.year).toMatch(/\d{4}/);
      expect(fact.source.length).toBeGreaterThan(4);
      expect(fact.url).toMatch(/^https:\/\//);
    }
  });
});

describe('generated robots.txt', () => {
  const txt = buildRobotsTxt('https://njangionchain.com');

  it('declares exactly one sitemap, on the canonical host', () => {
    const lines = txt.split('\n').filter((l) => l.startsWith('Sitemap:'));
    expect(lines).toEqual(['Sitemap: https://njangionchain.com/sitemap.xml']);
  });

  it('does not block render resources', () => {
    // Blocking /_next/ stops Google fetching the JS and CSS it needs to render.
    expect(txt).not.toMatch(/Disallow:\s*\/_next\//);
  });

  it('declares no per-crawler group', () => {
    // Under RFC 9309 a crawler obeys only the most specific group that matches
    // it. A bare "User-agent: Googlebot / Allow: /" block made Googlebot
    // discard every Disallow in the "*" group — /api/, /auth/ and /admin/ were
    // all crawlable as a result.
    const groups = txt.split('\n').filter((l) => l.startsWith('User-agent:'));
    expect(groups).toEqual(['User-agent: *']);
  });

  it('disallows every app route prefix', () => {
    for (const prefix of ['/dashboard', '/create-circle', '/circle', '/pool', '/auth', '/admin']) {
      expect(txt).toContain(`Disallow: ${prefix}`);
    }
  });

  it('does not disallow /restricted', () => {
    // A disallowed URL is never fetched, so the crawler never sees its noindex
    // and the URL can still be indexed from a link. It carries noindex instead.
    expect(txt).not.toMatch(/Disallow:\s*\/restricted/);
  });
});

describe('generated sitemap.xml', () => {
  const xml = buildSitemapXml(undefined, 'https://njangionchain.com');

  it('emits one <url> per route', () => {
    expect(xml.match(/<url>/g)).toHaveLength(SITE_ROUTES.length);
    expect(xml.match(/<\/url>/g)).toHaveLength(SITE_ROUTES.length);
  });

  it('emits absolute URLs on the canonical origin only', () => {
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    expect(locs.every((l) => l.startsWith('https://njangionchain.com/'))).toBe(true);
    expect(new Set(locs).size).toBe(locs.length);
  });

  it('emits well-formed lastmod and priority', () => {
    for (const m of xml.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)) {
      expect(m[1]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    for (const m of xml.matchAll(/<priority>([^<]+)<\/priority>/g)) {
      expect(Number(m[1])).toBeGreaterThanOrEqual(0);
      expect(Number(m[1])).toBeLessThanOrEqual(1);
    }
  });
});
