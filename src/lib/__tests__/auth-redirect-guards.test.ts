/**
 * Source guard: a page that redirects unauthenticated visitors must wait for
 * the session to hydrate first.
 *
 * `AuthContext` starts with `isLoading: true` and `isAuthenticated: false`,
 * so on a hard load every page sees "signed out" for the first render. A
 * redirect effect that does not wait bounces the signed-in user to '/', and
 * `/` forwards an authenticated user to /dashboard (pages/index.tsx) — so the
 * page silently never opens. It only works via in-app navigation, where the
 * context is already hydrated, which is why this survives casual clicking and
 * only breaks bookmarks, pasted links, and refreshes.
 *
 * Found in the wild on 2026-08-20: /create-circle was unreachable by URL for
 * every signed-in organiser, and /admin/compliance had the same shape — a page
 * the publish runbook opens by URL.
 *
 * Source-text assertions rather than render tests because jest runs
 * `testEnvironment: 'node'` and `testMatch` does not include `.tsx`. Same
 * technique as copy-guards.test.ts.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';

const PAGES_DIR = path.resolve(__dirname, '../../pages');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== 'api') walk(full, out);
    } else if (entry.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}

const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/**
 * Matches the redirect itself: an unauthenticated check whose body routes
 * away. Deliberately not matching bare `!isAuthenticated` — plenty of pages
 * branch on it to pick a CTA, which is fine.
 */
const REDIRECT = /if\s*\(\s*!isAuthenticated\s*\)\s*\{[^}]*router\.(replace|push)\s*\(/g;

/** The early return that must precede it. */
const HYDRATION_GUARD = /if\s*\(\s*(auth|isAuth)?[Ll]oading\s*\)\s*\{[^}]*return/;

describe('authenticated pages wait for hydration before redirecting', () => {
  const pages = walk(PAGES_DIR).map((f) => [path.relative(PAGES_DIR, f), f] as const);

  it('finds pages to check', () => {
    expect(pages.length).toBeGreaterThan(5);
  });

  it.each(pages)('%s', (_label, file) => {
    const source = stripComments(readFileSync(file, 'utf8'));

    for (const match of source.matchAll(REDIRECT)) {
      // Look back over the enclosing effect for the loading early-return.
      const before = source.slice(Math.max(0, match.index - 600), match.index);
      expect(HYDRATION_GUARD.test(before)).toBe(true);
    }
  });
});
