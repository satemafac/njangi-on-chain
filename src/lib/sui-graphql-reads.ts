// sui-graphql-reads.ts — the reads only Sui GraphQL serves: Move type layouts
// and event history. Plain fetch, no SDK, so Jest can test it with fetch
// stubbed.
//
// Events come from GraphQL, never gRPC: Sui's fullnodes prune history (a
// 10-day-old transaction is not found), so a gRPC event list can be missing
// its oldest entries while looking complete. GraphQL keeps full history.
//
// A read that fails is not a fact. A non-2xx status, an `errors` entry (even
// beside `data`), a body that does not parse, a missing field, a timeout, or
// an event list longer than the page bound all throw. An event list is only
// ever returned whole.

import { getGraphqlUrlForNetwork, type NetworkType } from '@/services/network-config';
import type { MoveLayout } from './move-json-rpc';

const GRAPHQL_TIMEOUT_MS = 10_000;

/** Sui GraphQL's largest page. */
const EVENTS_PAGE_SIZE = 50;

/** Pages read before an event list counts as unreadable (5,000 events). */
export const MAX_GRAPHQL_EVENT_PAGES = 100;

export class SuiGraphqlReadError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(`[sui-graphql] ${message}`);
    this.name = 'SuiGraphqlReadError';
    if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

/** Runs one GraphQL query and returns its `data`; throws on anything but a whole answer. */
export async function postSuiGraphql(
  network: NetworkType,
  query: string,
  variables: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const url: unknown = getGraphqlUrlForNetwork(network);
  if (typeof url !== 'string' || url === '') throw new SuiGraphqlReadError(`no GraphQL URL for ${network}`);
  if (typeof fetch !== 'function') throw new SuiGraphqlReadError('fetch is unavailable');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GRAPHQL_TIMEOUT_MS);
  let body: unknown;
  try {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });
    } catch (error) {
      throw new SuiGraphqlReadError(`${url} did not answer: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }
    if (!response.ok) throw new SuiGraphqlReadError(`${url} answered ${response.status}`);
    try {
      body = await response.json();
    } catch (error) {
      throw new SuiGraphqlReadError(`${url} sent an unreadable body`, { cause: error });
    }
  } finally {
    clearTimeout(timer);
  }

  const errors = field(body, 'errors');
  if (errors !== undefined && errors !== null && !(Array.isArray(errors) && errors.length === 0)) {
    const message = Array.isArray(errors) ? field(errors[0], 'message') : undefined;
    throw new SuiGraphqlReadError(`${url} returned errors${typeof message === 'string' ? `: ${message}` : ''}`);
  }
  const data = field(body, 'data');
  if (!isRecord(data)) throw new SuiGraphqlReadError(`${url} returned no data`);
  return data;
}

// ---------------------------------------------------------------------------
// Type layouts
// ---------------------------------------------------------------------------

const TYPE_LAYOUT_QUERY = 'query TypeLayout($type: String!) { type(type: $type) { repr layout abilities } }';

export interface TypeLayoutReading {
  layout: MoveLayout;
  /** The type's abilities, e.g. `['STORE', 'KEY']`. */
  abilities: string[];
}

/** The layout of `type` from Sui GraphQL. Throws when it cannot be read. */
export async function fetchTypeLayout(network: NetworkType, type: string): Promise<TypeLayoutReading> {
  const data = await postSuiGraphql(network, TYPE_LAYOUT_QUERY, { type });
  const moveType = data.type;
  const layout = field(moveType, 'layout');
  const abilities = field(moveType, 'abilities');
  if (layout === undefined || layout === null || (typeof layout !== 'string' && !isRecord(layout))) {
    throw new SuiGraphqlReadError(`no layout for ${type}`);
  }
  return {
    layout: layout as MoveLayout,
    abilities: Array.isArray(abilities) ? abilities.filter((a): a is string => typeof a === 'string') : [],
  };
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** What to list: Sui GraphQL's EventFilter (one of these is required). */
export interface GraphqlEventFilter {
  /** A full event type, `package::module`, or a package. */
  type?: string;
  /** The module that emitted the event, `package::module`. */
  module?: string;
  sender?: string;
}

/** One event as GraphQL returned it, before its JSON is put in JSON-RPC's shape. */
export interface GraphqlEventRecord {
  txDigest: string;
  eventSeq: string;
  timestampMs: string;
  sender: string;
  packageId: string;
  transactionModule: string;
  type: string;
  json: Record<string, unknown>;
  bcs: string | null;
}

const EVENTS_QUERY = `query Events($filter: EventFilter!, $first: Int!, $after: String) {
  events(filter: $filter, first: $first, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      sequenceNumber
      timestamp
      sender { address }
      transaction { digest }
      transactionModule { name package { address } }
      contents { type { repr } json bcs }
    }
  }
}`;

function readEventNode(node: unknown, where: string): GraphqlEventRecord {
  const txDigest = field(field(node, 'transaction'), 'digest');
  const seq = field(node, 'sequenceNumber');
  const timestamp = field(node, 'timestamp');
  const sender = field(field(node, 'sender'), 'address');
  const module = field(node, 'transactionModule');
  const moduleName = field(module, 'name');
  const packageId = field(field(module, 'package'), 'address');
  const contents = field(node, 'contents');
  const type = field(field(contents, 'type'), 'repr');
  const json = field(contents, 'json');
  const bcs = field(contents, 'bcs');
  const timestampMs = typeof timestamp === 'string' ? Date.parse(timestamp) : NaN;
  if (
    typeof txDigest !== 'string' ||
    !(typeof seq === 'number' || (typeof seq === 'string' && /^\d+$/.test(seq))) ||
    !Number.isFinite(timestampMs) ||
    typeof sender !== 'string' ||
    typeof type !== 'string' ||
    !isRecord(json)
  ) {
    throw new SuiGraphqlReadError(`${where}: an event without a readable digest, index, time, sender, type or json`);
  }
  return {
    txDigest,
    eventSeq: String(seq),
    timestampMs: String(timestampMs),
    sender,
    packageId: typeof packageId === 'string' ? packageId : '',
    transactionModule: typeof moduleName === 'string' ? moduleName : '',
    type,
    json,
    bcs: typeof bcs === 'string' ? bcs : null,
  };
}

/**
 * Every event matching `filter`, oldest first, read through every page.
 * Throws when a page cannot be read or the list runs past `maxPages`: the
 * first pages of a list are not the list.
 */
export async function readAllEventsViaGraphql(
  network: NetworkType,
  filter: GraphqlEventFilter,
  maxPages: number = MAX_GRAPHQL_EVENT_PAGES,
): Promise<GraphqlEventRecord[]> {
  if (!filter.type && !filter.module && !filter.sender) {
    throw new SuiGraphqlReadError('an event list needs a type, module or sender filter');
  }
  const events: GraphqlEventRecord[] = [];
  let after: string | null = null;
  for (let page = 1; page <= maxPages; page += 1) {
    const where = `events(${JSON.stringify(filter)}) page ${page}`;
    const data = await postSuiGraphql(network, EVENTS_QUERY, { filter, first: EVENTS_PAGE_SIZE, after });
    const connection = data.events;
    const nodes = field(connection, 'nodes');
    const pageInfo = field(connection, 'pageInfo');
    const hasNextPage = field(pageInfo, 'hasNextPage');
    const endCursor = field(pageInfo, 'endCursor');
    if (!Array.isArray(nodes) || typeof hasNextPage !== 'boolean') {
      throw new SuiGraphqlReadError(`${where}: no event list`);
    }
    events.push(...nodes.map((node) => readEventNode(node, where)));
    if (!hasNextPage) return events;
    if (typeof endCursor !== 'string' || endCursor === '' || endCursor === after) {
      throw new SuiGraphqlReadError(`${where}: a next page without a new cursor`);
    }
    after = endCursor;
  }
  throw new SuiGraphqlReadError(`events(${JSON.stringify(filter)}): more than ${maxPages} pages, not read to the end`);
}
