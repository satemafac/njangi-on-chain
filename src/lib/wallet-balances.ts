// wallet-balances.ts — the member's wallet balances over Sui GraphQL.
//
// The dashboard read balances only through JSON-RPC `getAllBalances`, so when
// every configured JSON-RPC endpoint refused (NJA-2830) a funded wallet showed
// "Balance couldn't be loaded" while Sui's GraphQL service would have answered.
// This is the GraphQL read. The dashboard tries it first and keeps JSON-RPC as
// the fallback, as src/lib/sui-epoch.ts does for the epoch.
//
// A read that fails is not a fact. A non-2xx status, a GraphQL `errors` body, a
// missing address or connection, an unreadable node or a list cut short by
// paging all throw, so the caller falls back instead of showing a wrong
// balance. No node is ever dropped and no balance is ever defaulted to '0'.

import { getGraphqlUrlForNetwork, type NetworkType } from '@/services/network-config';

const BALANCES_QUERY =
  'query WalletBalances($owner: SuiAddress!, $after: String) { address(address: $owner) { balances(first: 50, after: $after) { pageInfo { hasNextPage endCursor } nodes { coinType { repr } totalBalance } } } }';
const GRAPHQL_TIMEOUT_MS = 8_000;

/** Pages followed before giving up; a longer list throws rather than coming back partial. */
export const WALLET_BALANCES_MAX_PAGES = 20;

/** One coin type's balance, in the shape `buildWalletCoins` takes. */
export interface WalletBalanceReading {
  /** The full coin type as GraphQL reports it under `coinType.repr`. */
  coinType: string;
  /** Base units, as a decimal integer string. */
  totalBalance: string;
}

interface BalancesPage {
  readings: WalletBalanceReading[];
  hasNextPage: boolean;
  endCursor: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One balance node, or a throw: a node is never skipped and never read as zero. */
function parseNode(node: unknown, index: number, url: string): WalletBalanceReading {
  const record: Record<string, unknown> = isRecord(node) ? node : {};
  const coinTypeField = record.coinType;
  const coinType = isRecord(coinTypeField) ? coinTypeField.repr : undefined;
  if (typeof coinType !== 'string' || coinType.trim() === '') {
    throw new Error(`GraphQL ${url} returned balance node ${index} without a coin type`);
  }
  const totalBalance = record.totalBalance;
  if (typeof totalBalance !== 'string' || !/^\d+$/.test(totalBalance)) {
    throw new Error(`GraphQL ${url} returned an unreadable balance for ${coinType}: ${String(totalBalance)}`);
  }
  return { coinType, totalBalance };
}

async function readBalancesPage(url: string, owner: string, after: string | null): Promise<BalancesPage> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GRAPHQL_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query: BALANCES_QUERY, variables: { owner, after } }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`GraphQL ${url} answered ${response.status}`);
    }
    const body: unknown = await response.json();
    if (!isRecord(body)) {
      throw new Error(`GraphQL ${url} answered with a body that is not an object`);
    }
    const errors = body.errors;
    if (errors !== undefined && errors !== null && !(Array.isArray(errors) && errors.length === 0)) {
      const first: unknown = Array.isArray(errors) ? errors[0] : undefined;
      const message = isRecord(first) ? first.message : undefined;
      throw new Error(`GraphQL ${url} returned errors${typeof message === 'string' ? `: ${message}` : ''}`);
    }
    const data = body.data;
    const address = isRecord(data) ? data.address : undefined;
    if (!isRecord(address)) {
      throw new Error(`GraphQL ${url} returned no address for ${owner}`);
    }
    const balances = address.balances;
    const nodes = isRecord(balances) ? balances.nodes : undefined;
    if (!isRecord(balances) || !Array.isArray(nodes)) {
      throw new Error(`GraphQL ${url} returned no balances list for ${owner}`);
    }
    const pageInfo = balances.pageInfo;
    const hasNextPage = isRecord(pageInfo) ? pageInfo.hasNextPage : undefined;
    const endCursor = isRecord(pageInfo) ? pageInfo.endCursor : undefined;
    if (typeof hasNextPage !== 'boolean') {
      throw new Error(`GraphQL ${url} returned balances without page info, so the list may be partial`);
    }
    if (hasNextPage && (typeof endCursor !== 'string' || endCursor === '')) {
      throw new Error(`GraphQL ${url} reported more balances without a cursor to read them`);
    }
    return {
      readings: nodes.map((node, index) => parseNode(node, index, url)),
      hasNextPage,
      endCursor: typeof endCursor === 'string' ? endCursor : null,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Every coin balance `owner` holds on `network`, read from Sui GraphQL across
 * all pages. Throws on a failed, malformed or partial read so the caller falls
 * back to JSON-RPC; it never returns a shortened or defaulted list. An empty
 * list means GraphQL answered, completely, that the address holds no coins.
 */
export async function readWalletBalancesViaGraphql(
  network: NetworkType,
  owner: string,
): Promise<WalletBalanceReading[]> {
  const url = getGraphqlUrlForNetwork(network);
  if (!url) {
    throw new Error(`No Sui GraphQL URL is configured for ${network}`);
  }
  const readings: WalletBalanceReading[] = [];
  let after: string | null = null;
  for (let page = 0; page < WALLET_BALANCES_MAX_PAGES; page += 1) {
    const result: BalancesPage = await readBalancesPage(url, owner, after);
    readings.push(...result.readings);
    if (!result.hasNextPage) {
      return readings;
    }
    after = result.endCursor;
  }
  throw new Error(
    `GraphQL ${url} listed more than ${WALLET_BALANCES_MAX_PAGES} pages of balances for ${owner}; not returning a partial list`,
  );
}
