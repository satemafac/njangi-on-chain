/**
 * NJA-3600 (circle page, part 1 of 2) — the circle page's access check and
 * its main circle-object read must go through Sui's GraphQL service first,
 * with JSON-RPC as the fallback, via a shared single-object reader in
 * src/lib/object-graphql.ts; and when both sources fail the page must show an
 * explicit "couldn't load" state with a retry, never "Circle not found".
 *
 * Every configured JSON-RPC endpoint refuses JSON-RPC (NJA-2830). On this
 * commit verifyMembership (src/pages/circle/[id]/index.tsx:268) reads the
 * circle with readObject (:276) and the members table with
 * client.getDynamicFieldObject (:291), and fetchCircleDetails (:414) reads the
 * circle with readObject (:432): JSON-RPC only (src/lib/sui-read.ts batches it
 * into multiGetObjects on the pooled client). The failed read ends in the
 * catch at :671 with `circle` still null, and the page renders "Circle not
 * found" (:2388): a read failure shown as a fact.
 *
 * The page cannot run under jest (node environment, no DOM), so these checks
 * are source-level, as src/__tests__/dashboard/circle-dynamic-fields-graphql-first.test.ts
 * is for the dashboard. The helper the fix adds carries its own behavioural
 * tests with fetch stubbed (an `errors` entry beside data is a failed read; a
 * non-2xx or unreadable body throws; `object: null` with no errors is the
 * only "gone"), as src/__tests__/lib/circle-config-graphql-fallback.test.ts
 * does for circle-config.ts. Nothing here may reach the network: fetch is
 * stubbed to reject.
 */
import { existsSync, readFileSync } from 'fs';
import { dirname, resolve } from 'path';

const SRC = resolve(__dirname, '../..');
const PAGE = resolve(SRC, 'pages/circle/[id]/index.tsx');
const HELPER = resolve(SRC, 'lib/object-graphql.ts');

const realFetch = (globalThis as { fetch?: unknown }).fetch;
beforeAll(() => {
  (globalThis as { fetch?: unknown }).fetch = jest.fn(() =>
    Promise.reject(new Error('fetch is stubbed: this test never reaches the network')),
  );
});
afterAll(() => {
  (globalThis as { fetch?: unknown }).fetch = realFetch;
});

/** Comments describe old behaviour and future plans; they must not trip the guard. */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const rawPage = readFileSync(PAGE, 'utf8');
const pageSource = stripComments(rawPage);

/** `pageSource` from `startMarker` up to the nearest of `endMarkers` after it. */
function sliceBetween(startMarker: string, endMarkers: string[], what: string): string {
  const start = pageSource.indexOf(startMarker);
  if (start < 0) {
    throw new Error(`src/pages/circle/[id]/index.tsx no longer declares \`${startMarker}\`; point this guard at ${what}`);
  }
  const ends = endMarkers
    .map((marker) => pageSource.indexOf(marker, start + startMarker.length))
    .filter((index) => index >= 0);
  if (ends.length === 0) {
    throw new Error(`none of ${endMarkers.join(' | ')} follows \`${startMarker}\`; point this guard at the end of ${what}`);
  }
  return pageSource.slice(start, Math.min(...ends));
}

/** The access check: verifyMembership up to the effect that calls it. */
const accessCheckBody = (): string =>
  sliceBetween('const verifyMembership = async (', ['useEffect(() => {', 'const fetchCircleDetails = async'], 'the access check');

/** The main circle-object read: fetchCircleDetails up to its first follow-up read. */
const mainObjectReadBody = (): string =>
  sliceBetween(
    'const fetchCircleDetails = async',
    ['getDynamicFields', 'queryEventsCached(', 'const configValues = {'],
    'the main circle object read',
  );

interface LocalModule {
  specifier: string;
  names: string[];
  source: string;
}

function importedNames(rawClause: string): string[] {
  // A side-effect import (`import './x.css'`) has no `from`, so the lazy match
  // may have swallowed it: keep only what follows the last `import` keyword.
  const clause = rawClause.replace(/[\s\S]*\bimport\s+/, '').replace(/^type\s+/, '');
  const names: string[] = [];
  const braces = clause.match(/\{([\s\S]*?)\}/);
  if (braces) {
    for (const part of braces[1].split(',')) {
      const token = part.trim().replace(/^type\s+/, '');
      if (!token) continue;
      const alias = token.split(/\s+as\s+/).pop()?.trim() ?? '';
      if (/^[A-Za-z_$][\w$]*$/.test(alias)) names.push(alias);
    }
  }
  const outside = clause.replace(/\{[\s\S]*?\}/, '');
  const star = outside.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
  if (star) names.push(star[1]);
  const def = outside.replace(/\*\s+as\s+[A-Za-z_$][\w$]*/, '').replace(/,/g, '').trim();
  if (/^[A-Za-z_$][\w$]*$/.test(def)) names.push(def);
  return names;
}

/** Every module under src/ that the page imports directly, with the names it imports. */
function importedLocalModules(): LocalModule[] {
  const modules: LocalModule[] = [];
  const statement = /^import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/gm;
  let match: RegExpExecArray | null;
  while ((match = statement.exec(pageSource)) !== null) {
    const specifier = match[2];
    const base = specifier.startsWith('@/')
      ? resolve(SRC, specifier.slice(2))
      : specifier.startsWith('.')
        ? resolve(dirname(PAGE), specifier)
        : null;
    if (!base) continue;
    const file = ['.ts', '.tsx', '/index.ts', '/index.tsx'].map((ext) => base + ext).find((p) => existsSync(p));
    if (!file) continue;
    modules.push({ specifier, names: importedNames(match[1]), source: stripComments(readFileSync(file, 'utf8')) });
  }
  return modules;
}

/** `name` used as an identifier in `body` (not as a property such as `client.name`). */
const usesName = (body: string, name: string): boolean =>
  new RegExp('(^|[^\\w$.])' + name.replace(/\$/g, '\\$') + '(?![\\w$])').test(body);

/** A source that reads ONE object by id over Sui GraphQL: `object(address: …) { … asMoveObject { contents { … json } } }`. */
const readsSingleObjectOverGraphql = (source: string): boolean =>
  /graphql/i.test(source) && /\bobject\s*\(\s*address\s*:/.test(source) && /asMoveObject/.test(source);

/** A source that still reaches JSON-RPC for an object (the fallback). */
const readsObjectOverJsonRpc = (source: string): boolean =>
  /\b(?:getObject|multiGetObjects|readObject|getDynamicFieldObject)\s*\(/.test(source);

function transportsOf(body: string) {
  const helpers = importedLocalModules().filter((m) => m.names.some((name) => usesName(body, name)));
  const reachable = [body, ...helpers.map((m) => m.source)].join('\n');
  return {
    graphqlFirst: /graphql/i.test(body) || helpers.some((m) => readsSingleObjectOverGraphql(m.source)),
    jsonRpcFallback: readsObjectOverJsonRpc(reachable),
    modulesCalled: helpers.map((m) => m.specifier),
  };
}

describe('circle page: access check and main object read go through Sui GraphQL first (NJA-3600)', () => {
  it('verifyMembership has a GraphQL transport (the shared reader or isCurrentMemberOrAdmin) and keeps JSON-RPC as the fallback', () => {
    // Fails on this commit: the body reads the circle with readObject (:276)
    // and the members table with client.getDynamicFieldObject (:291), and
    // calls no module that reads `object(address)` over GraphQL.
    expect(transportsOf(accessCheckBody())).toMatchObject({ graphqlFirst: true, jsonRpcFallback: true });
  });

  it('fetchCircleDetails reads the circle object over GraphQL first and keeps JSON-RPC as the fallback', () => {
    // Fails on this commit: the only object read before the dynamic-field
    // list is `readObject(id as string, { showContent: true, showType: true })` (:432).
    expect(transportsOf(mainObjectReadBody())).toMatchObject({ graphqlFirst: true, jsonRpcFallback: true });
  });

  it('shows an explicit could-not-load state with a retry when both sources fail, and keeps "Circle not found" for a confirmed gone object', () => {
    // Fails on this commit: a failed read leaves `circle` null (catch at :671)
    // and the only non-loading, no-circle branch (:1615 / :2385) says
    // "Circle not found" (:2388). Copy is checked on the raw source because it
    // lives in JSX text, where an apostrophe may be written as &apos;.
    expect({
      loadErrorCopy: /couldn(?:'|&apos;|&#39;|\u2019)t load this circle just now/i.test(rawPage),
      retry: /try again/i.test(rawPage),
      notFoundKeptForGone: /Circle not found/.test(rawPage),
    }).toEqual({ loadErrorCopy: true, retry: true, notFoundKeptForGone: true });
  });

  it('the shared single-object reader src/lib/object-graphql.ts exists and reads object(address) { version asMoveObject { contents { type { repr } json } } }, failing on an errors entry', () => {
    // Fails on this commit: there is no such module (circle-config.ts and
    // membership-discovery.ts each carry a private copy of the object query).
    expect(existsSync(HELPER)).toBe(true);

    const helper = stripComments(readFileSync(HELPER, 'utf8'));
    expect({
      readsViaObject: /\bobject\s*\(\s*address\s*:/.test(helper),
      moveContents: /asMoveObject/.test(helper) && /type\s*\{\s*repr\s*\}/.test(helper) && /\bjson\b/.test(helper),
      checksErrorsEntry: /\berrors\b/.test(helper),
      throwsOnFailedRead: /\bthrow\b/.test(helper),
    }).toEqual({ readsViaObject: true, moveContents: true, checksErrorsEntry: true, throwsOnFailedRead: true });
  });
});
