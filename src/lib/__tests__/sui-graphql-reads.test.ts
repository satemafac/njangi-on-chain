// sui-graphql-reads.ts: Move type layouts and event history from Sui GraphQL,
// with fetch stubbed (nothing here reaches the network).
//
// What must hold: an event list is returned only whole. A failed page, an
// `errors` entry beside data, a non-2xx status, an unreadable event, a next
// page without a new cursor, or more pages than the bound all throw.

jest.mock('@/services/network-config', () => ({
  getGraphqlUrlForNetwork: () => 'https://graphql.test.invalid/graphql',
}));

import { fetchTypeLayout, readAllEventsViaGraphql, SuiGraphqlReadError } from '@/lib/sui-graphql-reads';

const TYPE = `0x${'5a'.repeat(32)}::njangi_circles::MemberJoined`;
const SENDER = `0x${'ad'.repeat(32)}`;

const node = (digest: string, seq = 0) => ({
  sequenceNumber: seq,
  timestamp: '2026-07-04T18:09:53.631Z',
  sender: { address: SENDER },
  transaction: { digest },
  transactionModule: { name: 'njangi_circles', package: { address: `0x${'5b'.repeat(32)}` } },
  contents: { type: { repr: TYPE }, json: { member: SENDER }, bcs: 'AA==' },
});

const page = (nodes: unknown[], hasNextPage: boolean, endCursor: string | null) => ({
  ok: true,
  status: 200,
  json: async () => ({ data: { events: { pageInfo: { hasNextPage, endCursor }, nodes } } }),
});

let fetchMock: jest.Mock;
const realFetch = (globalThis as { fetch?: unknown }).fetch;
beforeEach(() => {
  fetchMock = jest.fn();
  (globalThis as { fetch?: unknown }).fetch = fetchMock;
});
afterAll(() => {
  (globalThis as { fetch?: unknown }).fetch = realFetch;
});

const sentVariables = (call: number) => JSON.parse(fetchMock.mock.calls[call][1].body).variables;

describe('readAllEventsViaGraphql', () => {
  it('follows the cursor through every page and keeps JSON-RPC event fields', async () => {
    fetchMock
      .mockResolvedValueOnce(page([node('T1')], true, 'c1'))
      .mockResolvedValueOnce(page([node('T2', 1)], false, 'c2'));
    const events = await readAllEventsViaGraphql('testnet', { type: TYPE });

    expect(events).toEqual([
      expect.objectContaining({ txDigest: 'T1', eventSeq: '0', timestampMs: String(Date.parse('2026-07-04T18:09:53.631Z')), sender: SENDER, type: TYPE }),
      expect.objectContaining({ txDigest: 'T2', eventSeq: '1' }),
    ]);
    expect(sentVariables(0)).toEqual({ filter: { type: TYPE }, first: 50, after: null });
    expect(sentVariables(1)).toEqual({ filter: { type: TYPE }, first: 50, after: 'c1' });
  });

  it('throws on an errors entry even beside data', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ data: { events: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } }, errors: [{ message: 'timeout' }] }),
    });
    await expect(readAllEventsViaGraphql('testnet', { type: TYPE })).rejects.toThrow(/returned errors: timeout/);
  });

  it('throws on a non-2xx status or a failed request', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) });
    await expect(readAllEventsViaGraphql('testnet', { type: TYPE })).rejects.toBeInstanceOf(SuiGraphqlReadError);
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(readAllEventsViaGraphql('testnet', { type: TYPE })).rejects.toThrow(/did not answer/);
  });

  it('throws when a later page fails, never returning the first pages as the list', async () => {
    fetchMock.mockResolvedValueOnce(page([node('T1')], true, 'c1')).mockResolvedValueOnce({ ok: false, status: 429, json: async () => ({}) });
    await expect(readAllEventsViaGraphql('testnet', { type: TYPE })).rejects.toThrow(/429/);
  });

  it('throws for an event it cannot read', async () => {
    const bad = { ...node('T1'), timestamp: null };
    fetchMock.mockResolvedValueOnce(page([bad], false, null));
    await expect(readAllEventsViaGraphql('testnet', { type: TYPE })).rejects.toThrow(/without a readable/);
  });

  it('throws for a next page without a new cursor, and past the page bound', async () => {
    fetchMock.mockResolvedValueOnce(page([node('T1')], true, null));
    await expect(readAllEventsViaGraphql('testnet', { type: TYPE })).rejects.toThrow(/without a new cursor/);

    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => page([node('T')], true, `c${fetchMock.mock.calls.length}`));
    await expect(readAllEventsViaGraphql('testnet', { type: TYPE }, 3)).rejects.toThrow(/more than 3 pages/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('refuses an unfiltered list', async () => {
    await expect(readAllEventsViaGraphql('testnet', {})).rejects.toThrow(/needs a type, module or sender/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('fetchTypeLayout', () => {
  it('returns the layout and abilities', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ data: { type: { repr: TYPE, layout: { struct: { type: TYPE, fields: [] } }, abilities: ['COPY', 'DROP'] } } }),
    });
    await expect(fetchTypeLayout('testnet', TYPE)).resolves.toEqual({
      layout: { struct: { type: TYPE, fields: [] } },
      abilities: ['COPY', 'DROP'],
    });
    expect(sentVariables(0)).toEqual({ type: TYPE });
  });

  it('throws when the layout is missing', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: { type: { repr: TYPE, layout: null } } }) });
    await expect(fetchTypeLayout('testnet', TYPE)).rejects.toThrow(/no layout/);
  });
});
