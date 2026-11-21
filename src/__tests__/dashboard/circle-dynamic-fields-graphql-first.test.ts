/**
 * NJA-3570 (circles step 4b, part 1 of 2) — the dashboard's per-circle
 * dynamic-field LIST must be read from Sui's GraphQL service first, with
 * JSON-RPC getDynamicFields as the fallback, through a shared helper in
 * src/lib/dynamic-fields-graphql.ts.
 *
 * Every configured JSON-RPC endpoint refuses JSON-RPC (NJA-2830). The
 * CircleConfig VALUE is already read over GraphQL (src/lib/circle-config.ts),
 * but the list that locates it — `client.getDynamicFields({ parentId: circleId })`
 * inside the cachedApiCall that builds enhancedObjectData in
 * src/pages/dashboard.tsx — is JSON-RPC only. It throws, the circle is counted
 * unreadable, and the dashboard drops every circle.
 *
 * The page cannot run under jest (node environment, no DOM), so the transport
 * check is source-level, as wallet-balances-graphql-first.test.ts in this
 * directory is for fetchBalance. The helper the fix adds carries its own
 * behavioural tests with fetch stubbed (two pages joined in order, a vector<u8>
 * name decoded from base64, each failed or partial read throwing), as
 * src/lib/wallet-balances.ts's do. Nothing here may reach the network: fetch
 * is stubbed to reject.
 */
import { existsSync, readFileSync } from 'fs';
import { dirname, resolve } from 'path';

const SRC = resolve(__dirname, '../..');
const DASHBOARD = resolve(SRC, 'pages/dashboard.tsx');
const HELPER = resolve(SRC, 'lib/dynamic-fields-graphql.ts');

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

const dashboardSource = stripComments(readFileSync(DASHBOARD, 'utf8'));

/**
 * The per-circle read: `const circleData = await cachedApiCall(` up to the TTL
 * argument that closes it, `CACHE_CONFIG.API_RESPONSE_TTL`.
 */
function perCircleReadBody(): string {
  const start = dashboardSource.indexOf('const circleData = await cachedApiCall(');
  if (start < 0) {
    throw new Error(
      'src/pages/dashboard.tsx no longer declares `const circleData = await cachedApiCall(`; point this guard at the per-circle read',
    );
  }
  const end = dashboardSource.indexOf('CACHE_CONFIG.API_RESPONSE_TTL', start);
  if (end < 0) {
    throw new Error('the per-circle cachedApiCall no longer closes with CACHE_CONFIG.API_RESPONSE_TTL; point this guard at its closing');
  }
  return dashboardSource.slice(start, end);
}

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

/** Every module under src/ that dashboard.tsx imports, with the names it imports. */
function importedLocalModules(): LocalModule[] {
  const modules: LocalModule[] = [];
  const statement = /^import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/gm;
  let match: RegExpExecArray | null;
  while ((match = statement.exec(dashboardSource)) !== null) {
    const specifier = match[2];
    const base = specifier.startsWith('@/')
      ? resolve(SRC, specifier.slice(2))
      : specifier.startsWith('.')
        ? resolve(dirname(DASHBOARD), specifier)
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

/** A source that lists dynamic fields over Sui GraphQL: the service, the `dynamicFields` connection, its page info. */
const listsDynamicFieldsOverGraphql = (source: string): boolean =>
  /graphql/i.test(source) && /\bdynamicFields\s*\(/.test(source) && /pageInfo/.test(source) && /hasNextPage/.test(source);

/** A source that still reaches JSON-RPC for the list (the fallback). */
const listsDynamicFieldsOverJsonRpc = (source: string): boolean => /\bgetDynamicFields\s*\(/.test(source);

describe('dashboard per-circle dynamic-field list goes through Sui GraphQL first (NJA-3570)', () => {
  it('the per-circle read has a GraphQL transport and keeps JSON-RPC getDynamicFields as the fallback', () => {
    const body = perCircleReadBody();
    const helpers = importedLocalModules().filter((m) => m.names.some((name) => usesName(body, name)));
    const reachable = [body, ...helpers.map((m) => m.source)].join('\n');

    // Fails on this commit: the body's only read is
    // `client.getDynamicFields({ parentId: circleId })` (dashboard.tsx:3942),
    // and it calls no module that lists `address.dynamicFields` over GraphQL.
    expect({
      graphql: /graphql/i.test(body) || helpers.some((m) => listsDynamicFieldsOverGraphql(m.source)),
      jsonRpcFallback: listsDynamicFieldsOverJsonRpc(reachable),
      modulesCalledFromPerCircleRead: helpers.map((m) => m.specifier),
    }).toMatchObject({ graphql: true, jsonRpcFallback: true });
  });

  it('the shared helper src/lib/dynamic-fields-graphql.ts exists and lists fields via address(...), following pageInfo', () => {
    // Fails on this commit: there is no such module (the dashboard, circle-config.ts
    // and circle-service.ts each list fields with JSON-RPC getDynamicFields only).
    expect(existsSync(HELPER)).toBe(true);

    const helper = stripComments(readFileSync(HELPER, 'utf8'));
    expect({
      listsViaAddress: /\baddress\s*\(\s*address\s*:/.test(helper),
      neverViaObject: !/\bobject\s*\(\s*address\s*:/.test(helper),
      dynamicFieldsConnection: /\bdynamicFields\s*\(/.test(helper),
      followsPageInfo: /hasNextPage/.test(helper) && /endCursor/.test(helper),
    }).toEqual({ listsViaAddress: true, neverViaObject: true, dynamicFieldsConnection: true, followsPageInfo: true });
  });
});
