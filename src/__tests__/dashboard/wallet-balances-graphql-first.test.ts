/**
 * NJA-2840 — the dashboard's wallet balances must be read from Sui's GraphQL
 * service first, with JSON-RPC as the fallback.
 *
 * Every JSON-RPC endpoint the app is configured with now refuses JSON-RPC
 * (NJA-2830), but the dashboard's own balance read, `fetchBalance` in
 * src/pages/dashboard.tsx, only ever calls `client.getAllBalances` over the
 * JSON-RPC candidates, so a funded wallet shows "Balance couldn't be loaded"
 * while the network's GraphQL service would have answered.
 *
 * The page cannot run under jest (node environment, no DOM), so the transport
 * check is source-level, as src/lib/__tests__/coin-decimals-guards.test.ts
 * already is for this file. It accepts either shape of fix: a GraphQL read
 * written inside `fetchBalance`, or a helper module (like src/lib/sui-epoch.ts)
 * that `fetchBalance` calls. Whatever helper the fix adds should carry its own
 * behavioural test with fetch and the RPC client mocked, as
 * src/lib/__tests__/sui-epoch.test.ts does. The per-coin handling that must be
 * kept (src/lib/wallet-coins.ts) is exercised here with a recorded GraphQL answer.
 */
import { existsSync, readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { buildWalletCoins, findSupportedWalletCoin } from '../../lib/wallet-coins';

const SRC = resolve(__dirname, '../..');
const DASHBOARD = resolve(SRC, 'pages/dashboard.tsx');

/** Comments describe old behaviour and future plans; they must not trip the guard. */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const dashboardSource = stripComments(readFileSync(DASHBOARD, 'utf8'));

/** The dashboard's balance read: `const fetchBalance = useCallback(` up to its closing line. */
function fetchBalanceBody(): string {
  const start = dashboardSource.indexOf('const fetchBalance = useCallback(');
  if (start < 0) {
    throw new Error('src/pages/dashboard.tsx no longer declares fetchBalance; point this guard at the balance read');
  }
  const rest = dashboardSource.slice(start);
  // The body is indented by four spaces or more; the first line back at two
  // spaces is the callback's closing `}, [deps]);`.
  const close = rest.search(/\n {2}\S/);
  return close < 0 ? rest : rest.slice(0, close);
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

/** A source that reads wallet balances over Sui GraphQL: the service, the `balances` connection, `totalBalance`. */
const readsBalancesOverGraphql = (source: string): boolean =>
  /graphql/i.test(source) && /\bbalances\s*\(/.test(source) && /totalBalance/.test(source);

/** A source that still reaches JSON-RPC for balances (the fallback). */
const readsBalancesOverJsonRpc = (source: string): boolean =>
  /getAllBalances|getBalance\s*\(|withSuiRpcFailover/.test(source);

// A valid Sui address: 0x followed by exactly 64 hex digits.
const OWNER = `0x${'a1'.repeat(32)}`;
const SUI = '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';
const USDC_TESTNET = '0x26b3bc67befc214058ca78ea9a2690298d731a2d4309485ec3d40198063c4abc::usdc::USDC';

/**
 * The answer shape of Sui's GraphQL service as verified live on 2026-11-15
 * (NJA-2840): each coin's full type under `coinType.repr` and its balance as a
 * decimal string under `totalBalance`. The amounts are this test's.
 */
const RECORDED_GRAPHQL = {
  request: {
    query:
      'query WalletBalances($owner: SuiAddress!) { address(address: $owner) { balances(first: 50) { nodes { coinType { repr } totalBalance } } } }',
    variables: { owner: OWNER },
  },
  response: {
    data: {
      address: {
        balances: {
          nodes: [
            { coinType: { repr: SUI }, totalBalance: '1500000000' },
            { coinType: { repr: USDC_TESTNET }, totalBalance: '25000000' },
          ],
        },
      },
    },
  },
};

describe('dashboard wallet balances go through Sui GraphQL first (NJA-2840)', () => {
  it('fetchBalance has a GraphQL transport and keeps JSON-RPC as the fallback', () => {
    const body = fetchBalanceBody();
    const helpers = importedLocalModules().filter((m) => m.names.some((name) => usesName(body, name)));
    const reachable = [body, ...helpers.map((m) => m.source)].join('\n');

    // Fails on this commit: fetchBalance only loops JSON-RPC candidates calling
    // client.getAllBalances; nothing it calls reads `address.balances` over GraphQL.
    expect({
      graphql: /graphql/i.test(body) || helpers.some((m) => readsBalancesOverGraphql(m.source)),
      jsonRpc: readsBalancesOverJsonRpc(reachable),
      modulesCalledFromFetchBalance: helpers.map((m) => m.specifier),
    }).toMatchObject({ graphql: true, jsonRpc: true });
  });

  it('a recorded GraphQL answer flows through the existing per-coin handling', () => {
    expect(RECORDED_GRAPHQL.request.variables.owner).toMatch(/^0x[0-9a-f]{64}$/);
    const rows = buildWalletCoins(
      RECORDED_GRAPHQL.response.data.address.balances.nodes.map((node) => ({
        coinType: node.coinType.repr,
        totalBalance: node.totalBalance,
      })),
      'testnet',
    );
    expect(findSupportedWalletCoin(rows, 'SUI')).toMatchObject({ balance: '1500000000', decimals: 9 });
    expect(findSupportedWalletCoin(rows, 'USDC')).toMatchObject({ balance: '25000000', decimals: 6 });
  });
});
