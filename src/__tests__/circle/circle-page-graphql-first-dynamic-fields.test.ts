/**
 * NJA-3601 (circle page, part 2 of 2) — the circle page's remaining reads
 * must go through Sui's GraphQL service first, with JSON-RPC as the fallback:
 * the circle's dynamic-field list (read through every page), the CircleConfig
 * that list locates, and the members-table entry; and when both sources fail
 * the page must keep part 1's load-error state, never defaults or "Circle not
 * found".
 *
 * Every configured JSON-RPC endpoint refuses JSON-RPC (NJA-2830). After part 1
 * (30f0cbed) fetchCircleDetails reads the circle object over GraphQL first
 * (src/pages/circle/[id]/index.tsx:415), then lists the circle's dynamic
 * fields with `client.getDynamicFields({ parentId })` (:449): JSON-RPC only,
 * and its first page only, which getCircleConfigFieldsFromDynamicFields
 * (:523) receives as the whole list. On a JSON-RPC client that throws, the
 * throw lands in the catch at :671: the circle GraphQL just read is dropped
 * and the page shows the load-error state instead of the settings and members
 * GraphQL could have supplied. fetchRecoveryStatus lists the same fields the
 * same way (:691), and fetchRecoveryLivenessState reads the members table with
 * `client.getDynamicFieldObject` (:795) only.
 *
 * The GraphQL-first readers exist and the page does not call them:
 * readDynamicFieldsViaGraphql (src/lib/dynamic-fields-graphql.ts:218, #170),
 * readCircleDynamicFields (src/lib/circle-config.ts:241: GraphQL first across
 * every page, readDynamicFieldsViaJsonRpc as the fallback, throws when both
 * fail), isCurrentMemberOrAdmin (src/lib/membership-discovery.ts:426) and
 * readObjectViaGraphql (src/lib/object-graphql.ts:67, part 1).
 *
 * The page cannot run under jest (node environment, no DOM, .tsx is not
 * collected), so these checks are source-level, as
 * circle-page-graphql-first-load-error.test.ts (part 1) in this directory and
 * src/__tests__/dashboard/circle-dynamic-fields-graphql-first.test.ts are. The
 * readers carry their own behavioural tests with fetch and the client stubbed.
 * Nothing here may reach the network: fetch is stubbed to reject.
 */
import { existsSync, readFileSync } from 'fs';
import { dirname, resolve } from 'path';

const SRC = resolve(__dirname, '../..');
const PAGE = resolve(SRC, 'pages/circle/[id]/index.tsx');

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
    throw new Error(`src/pages/circle/[id]/index.tsx no longer declares "${startMarker}"; point this guard at ${what}`);
  }
  const ends = endMarkers
    .map((marker) => pageSource.indexOf(marker, start + startMarker.length))
    .filter((index) => index >= 0);
  if (ends.length === 0) {
    throw new Error(`none of ${endMarkers.join(' | ')} follows "${startMarker}"; point this guard at the end of ${what}`);
  }
  return pageSource.slice(start, Math.min(...ends));
}

/** The whole of fetchCircleDetails: the circle read, the dynamic-field list, the config and setCircle. */
const fetchCircleDetailsBody = (): string =>
  sliceBetween('const fetchCircleDetails = async', ['const fetchRecoveryStatus = useCallback('], 'fetchCircleDetails');

/** fetchRecoveryStatus: the recovery poll's re-read of the dynamic fields and the config. */
const fetchRecoveryStatusBody = (): string =>
  sliceBetween(
    'const fetchRecoveryStatus = useCallback(',
    ['const fetchRecoveryExecutionState = useCallback('],
    'fetchRecoveryStatus',
  );

/** fetchRecoveryLivenessState: the members-table read behind the auto-release control. */
const membersTableReadBody = (): string =>
  sliceBetween('const fetchRecoveryLivenessState = useCallback(', ['useEffect(() => {'], 'the members-table read');

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

/**
 * Functions that list an object's dynamic fields over Sui GraphQL first,
 * through every page, with JSON-RPC as the fallback (src/lib/dynamic-fields-graphql.ts,
 * src/lib/circle-config.ts). A fix that adds another lister under src/lib
 * extends this list or carries the `dynamicFields` query itself.
 */
const GRAPHQL_FIRST_LISTERS = ['readDynamicFieldsViaGraphql', 'readCircleDynamicFields', 'getCircleConfigFields'];

/** A source that lists dynamic fields over Sui GraphQL itself: the service, the `dynamicFields` connection, its page info. */
const carriesDynamicFieldsQuery = (source: string): boolean =>
  /graphql/i.test(source) && /\bdynamicFields\s*\(/.test(source) && /hasNextPage/.test(source);

function dynamicFieldListTransports(body: string) {
  const helpers = importedLocalModules().filter((m) => m.names.some((name) => usesName(body, name)));
  const reachable = [body, ...helpers.map((m) => m.source)].join('\n');
  return {
    // The body names a GraphQL-first, every-page lister (or calls a small
    // helper that carries the query itself).
    graphqlFirstLister:
      GRAPHQL_FIRST_LISTERS.some((name) => usesName(body, name)) ||
      helpers.some((m) => carriesDynamicFieldsQuery(m.source)),
    // A direct `client.getDynamicFields(...)` call is JSON-RPC only and one
    // page only; the JSON-RPC fallback belongs in readDynamicFieldsViaJsonRpc,
    // which follows nextCursor to the last page.
    inlineJsonRpcPageRead: /\.getDynamicFields\s*\(/.test(body),
    jsonRpcFallback: /\bgetDynamicFields\s*\(/.test(reachable) || /\breadDynamicFieldsViaJsonRpc\s*\(/.test(reachable),
    // The config is read through circle-config.ts (GraphQL first, getObject second).
    configReader: /\bgetCircleConfigFields(?:ByObjectId|FromDynamicFields)?\s*\(/.test(body),
    modulesCalled: helpers.map((m) => m.specifier),
  };
}

/** A source that reads a members entry, or any object, over Sui GraphQL: `dynamicField(name: …)` or `object(address: …)`. */
const readsEntryOverGraphql = (source: string): boolean =>
  /graphql/i.test(source) &&
  (/\bdynamicField\s*\(/.test(source) || (/\bobject\s*\(\s*address\s*:/.test(source) && /asMoveObject/.test(source)));

function membersTableTransports(body: string) {
  const helpers = importedLocalModules().filter((m) => m.names.some((name) => usesName(body, name)));
  const reachable = [body, ...helpers.map((m) => m.source)].join('\n');
  return {
    graphqlFirst: /graphql/i.test(body) || helpers.some((m) => readsEntryOverGraphql(m.source)),
    jsonRpcFallback: /\bgetDynamicFieldObject\s*\(/.test(reachable),
    modulesCalled: helpers.map((m) => m.specifier),
  };
}

describe('circle page: dynamic fields, config and members-table reads go through Sui GraphQL first (NJA-3601)', () => {
  it('fetchCircleDetails lists the dynamic fields through a GraphQL-first, every-page lister, keeps JSON-RPC as the fallback, and reads the config from the field that list finds', () => {
    // Fails on this commit: the list is `client.getDynamicFields({ parentId: id as string })`
    // (:449), one JSON-RPC page, and the body names no GraphQL-first lister;
    // on a client that throws, the circle GraphQL read never reaches setCircle (:653).
    expect(dynamicFieldListTransports(fetchCircleDetailsBody())).toMatchObject({
      graphqlFirstLister: true,
      inlineJsonRpcPageRead: false,
      jsonRpcFallback: true,
      configReader: true,
    });
  });

  it('fetchRecoveryStatus re-reads the dynamic fields and the config the same way', () => {
    // Fails on this commit: `client.getDynamicFields({ parentId: id as string })` (:691).
    expect(dynamicFieldListTransports(fetchRecoveryStatusBody())).toMatchObject({
      graphqlFirstLister: true,
      inlineJsonRpcPageRead: false,
      jsonRpcFallback: true,
      configReader: true,
    });
  });

  it('the members-table read in fetchRecoveryLivenessState has a GraphQL transport (isCurrentMemberOrAdmin or the part-1 reader) and keeps JSON-RPC getDynamicFieldObject as the fallback', () => {
    // Fails on this commit: the only read is `client.getDynamicFieldObject(...)` (:795),
    // and the body calls no module that reads `dynamicField(name)` or
    // `object(address)` over GraphQL.
    expect(membersTableTransports(membersTableReadBody())).toMatchObject({ graphqlFirst: true, jsonRpcFallback: true });
  });

  it('when both sources fail the page keeps the load-error state, never defaults or "Circle not found"', () => {
    // Passes on this commit: part 1 added the state (catch at :671, copy at
    // :2392). Kept here because part 2 must route a doubly failed list, config
    // or members read to it rather than to zeros or "not found".
    expect({
      failedReadSetsLoadError: /setLoadError\(true\)/.test(fetchCircleDetailsBody()),
      loadErrorCopy: /couldn(?:'|&apos;|&#39;|\u2019)t load this circle just now/i.test(rawPage),
      retry: /try again/i.test(rawPage),
      notFoundKeptForGone: /Circle not found/.test(rawPage),
    }).toEqual({ failedReadSetsLoadError: true, loadErrorCopy: true, retry: true, notFoundKeptForGone: true });
  });
});
