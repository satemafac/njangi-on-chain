// cycle-finalized-cron.test.ts — Pure-function coverage for the cron's
// cursor-advance logic. The June 2026 ops audit found the legacy worker
// persisted the OLDEST event id of each batch and never followed
// nextCursor (re-processing the batch every poll, advancing one event per
// minute). These tests pin the fixed contract: ascending pages are drained
// until hasNextPage is false, and the NEWEST processed cursor is persisted
// after every page.

import {
  drainCycleFinalizedEvents,
  formatCoinAmount,
  parseCycleFinalizedEvent,
  type CycleFinalizedEventEnvelope,
  type EventCursor,
  type EventPage,
  type NotifyOutcome,
} from '../cycle-finalized-cron';

function cursor(n: number): EventCursor {
  return { txDigest: `digest-${n}`, eventSeq: '0' };
}

function event(n: number): CycleFinalizedEventEnvelope {
  return {
    id: cursor(n),
    parsedJson: {
      escrow_id: `0xescrow${n}`,
      cycle_no: String(n),
      recipient: `0xrecipient${n}`,
      amount: '1000000000',
      finalized_by: '0xfinalizer',
    },
  };
}

/** Builds a queryPage stub serving fixed pages keyed by the cursor passed in. */
function pagedQuery(pages: EventPage[]): {
  queryPage: (c: EventCursor | null) => Promise<EventPage>;
  calls: Array<EventCursor | null>;
} {
  const calls: Array<EventCursor | null> = [];
  let index = 0;
  return {
    calls,
    queryPage: async (c) => {
      calls.push(c);
      const page = pages[Math.min(index, pages.length - 1)];
      index += 1;
      return page;
    },
  };
}

describe('drainCycleFinalizedEvents', () => {
  it('drains every page until hasNextPage is false and persists the NEWEST cursor', async () => {
    const pages: EventPage[] = [
      { data: [event(1), event(2)], nextCursor: cursor(2), hasNextPage: true },
      { data: [event(3), event(4)], nextCursor: cursor(4), hasNextPage: true },
      { data: [event(5)], nextCursor: cursor(5), hasNextPage: false },
    ];
    const { queryPage, calls } = pagedQuery(pages);
    const notified: string[] = [];
    const persisted: EventCursor[] = [];

    const result = await drainCycleFinalizedEvents(null, {
      queryPage,
      notify: async (e) => {
        notified.push(e.id.txDigest);
        return 'sent';
      },
      persistCursor: async (c) => {
        persisted.push(c);
      },
    });

    // All five events processed in ascending order across three pages.
    expect(notified).toEqual([
      'digest-1',
      'digest-2',
      'digest-3',
      'digest-4',
      'digest-5',
    ]);
    expect(result.pages).toBe(3);
    expect(result.sent).toBe(5);
    expect(result.processed).toBe(5);
    expect(result.halted).toBe(false);

    // Cursor persisted after EVERY page, newest-last; final cursor is the
    // newest event of the final page — never the oldest of the batch.
    expect(persisted).toEqual([cursor(2), cursor(4), cursor(5)]);
    expect(result.finalCursor).toEqual(cursor(5));

    // Each subsequent page was queried from the previous page's newest cursor.
    expect(calls).toEqual([null, cursor(2), cursor(4)]);
  });

  it('persists nothing and notifies nobody when there are no new events', async () => {
    const { queryPage } = pagedQuery([
      { data: [], nextCursor: null, hasNextPage: false },
    ]);
    const notify = jest.fn<Promise<NotifyOutcome>, [CycleFinalizedEventEnvelope]>();
    const persistCursor = jest.fn<Promise<void>, [EventCursor]>();

    const result = await drainCycleFinalizedEvents(cursor(7), {
      queryPage,
      notify,
      persistCursor,
    });

    expect(notify).not.toHaveBeenCalled();
    expect(persistCursor).not.toHaveBeenCalled();
    // Final cursor stays at the initial cursor when nothing new arrived.
    expect(result.finalCursor).toEqual(cursor(7));
    expect(result.processed).toBe(0);
  });

  it('resumes from the stored cursor (passes it to the first page query)', async () => {
    const { queryPage, calls } = pagedQuery([
      { data: [event(9)], nextCursor: cursor(9), hasNextPage: false },
    ]);

    await drainCycleFinalizedEvents(cursor(8), {
      queryPage,
      notify: async () => 'sent',
      persistCursor: async () => undefined,
    });

    expect(calls[0]).toEqual(cursor(8));
  });

  it('halts without advancing past a failing event so the next run retries it', async () => {
    const { queryPage } = pagedQuery([
      {
        data: [event(1), event(2), event(3)],
        nextCursor: cursor(3),
        hasNextPage: false,
      },
    ]);
    const persisted: EventCursor[] = [];

    const result = await drainCycleFinalizedEvents(null, {
      queryPage,
      notify: async (e) => (e.id.txDigest === 'digest-2' ? 'halt' : 'sent'),
      persistCursor: async (c) => {
        persisted.push(c);
      },
    });

    expect(result.halted).toBe(true);
    // Only event 1 completed; the cursor stops just before event 2 so the
    // retry re-queries it (cursors are exclusive).
    expect(persisted).toEqual([cursor(1)]);
    expect(result.finalCursor).toEqual(cursor(1));
    expect(result.sent).toBe(1);
    expect(result.processed).toBe(1);
  });

  it('treats a thrown notify error as halt', async () => {
    const { queryPage } = pagedQuery([
      { data: [event(1), event(2)], nextCursor: cursor(2), hasNextPage: false },
    ]);
    const persisted: EventCursor[] = [];

    const result = await drainCycleFinalizedEvents(null, {
      queryPage,
      notify: async (e) => {
        if (e.id.txDigest === 'digest-1') return 'sent';
        throw new Error('postgres is down');
      },
      persistCursor: async (c) => {
        persisted.push(c);
      },
    });

    expect(result.halted).toBe(true);
    expect(persisted).toEqual([cursor(1)]);
  });

  it('halting on the FIRST event of a run persists no cursor at all', async () => {
    const { queryPage } = pagedQuery([
      { data: [event(1), event(2)], nextCursor: cursor(2), hasNextPage: false },
    ]);
    const persistCursor = jest.fn<Promise<void>, [EventCursor]>();

    const result = await drainCycleFinalizedEvents(cursor(0), {
      queryPage,
      notify: async () => 'halt',
      persistCursor,
    });

    expect(result.halted).toBe(true);
    expect(persistCursor).not.toHaveBeenCalled();
    expect(result.finalCursor).toEqual(cursor(0));
  });

  it('advances past per-recipient send failures instead of wedging', async () => {
    const { queryPage } = pagedQuery([
      {
        data: [event(1), event(2), event(3)],
        nextCursor: cursor(3),
        hasNextPage: false,
      },
    ]);
    const persisted: EventCursor[] = [];

    const result = await drainCycleFinalizedEvents(null, {
      queryPage,
      notify: async (e) => (e.id.txDigest === 'digest-2' ? 'failed' : 'sent'),
      persistCursor: async (c) => {
        persisted.push(c);
      },
    });

    expect(result.halted).toBe(false);
    expect(result.failed).toBe(1);
    expect(result.sent).toBe(2);
    expect(persisted).toEqual([cursor(3)]);
  });

  it('falls back to the last processed event id when the node omits nextCursor', async () => {
    const { queryPage } = pagedQuery([
      { data: [event(1), event(2)], nextCursor: null, hasNextPage: false },
    ]);
    const persisted: EventCursor[] = [];

    const result = await drainCycleFinalizedEvents(null, {
      queryPage,
      notify: async () => 'sent',
      persistCursor: async (c) => {
        persisted.push(c);
      },
    });

    expect(persisted).toEqual([cursor(2)]);
    expect(result.finalCursor).toEqual(cursor(2));
  });

  it('respects the maxPages safety cap', async () => {
    // Every page claims more data; without the cap this would loop forever.
    let n = 0;
    const queryPage = async (): Promise<EventPage> => {
      n += 1;
      return { data: [event(n)], nextCursor: cursor(n), hasNextPage: true };
    };
    const persisted: EventCursor[] = [];

    const result = await drainCycleFinalizedEvents(null, {
      queryPage,
      notify: async () => 'sent',
      persistCursor: async (c) => {
        persisted.push(c);
      },
      maxPages: 3,
    });

    expect(result.pages).toBe(3);
    expect(result.processed).toBe(3);
    expect(result.finalCursor).toEqual(cursor(3));
  });
});

describe('parseCycleFinalizedEvent', () => {
  it('parses the on-chain payload shape (escrow_id, no circle_id)', () => {
    expect(
      parseCycleFinalizedEvent({
        escrow_id: '0xabc',
        cycle_no: '4',
        recipient: '0xdef',
        amount: '2500000000',
        finalized_by: '0x123',
      }),
    ).toEqual({
      escrowId: '0xabc',
      cycleNo: 4,
      recipient: '0xdef',
      amount: '2500000000',
    });
  });

  it('rejects payloads missing the recipient — the silent no-op bug', () => {
    expect(
      parseCycleFinalizedEvent({ escrow_id: '0xabc', cycle_no: '4', amount: '1' }),
    ).toBeNull();
  });

  it('rejects payloads missing the escrow id and non-objects', () => {
    expect(parseCycleFinalizedEvent({ recipient: '0xdef' })).toBeNull();
    expect(parseCycleFinalizedEvent(null)).toBeNull();
    expect(parseCycleFinalizedEvent('nope')).toBeNull();
  });
});

describe('formatCoinAmount', () => {
  it('formats whole, fractional, and zero amounts', () => {
    expect(formatCoinAmount('0', 9, 'SUI')).toBe('0 SUI');
    expect(formatCoinAmount('1000000000', 9, 'SUI')).toBe('1 SUI');
    expect(formatCoinAmount('1500000000', 9, 'SUI')).toBe('1.5 SUI');
    expect(formatCoinAmount('350000000', 6, 'USDC')).toBe('350 USDC');
  });

  it('falls back to raw text for unparseable input', () => {
    expect(formatCoinAmount('not-a-number', 9, 'SUI')).toBe('not-a-number SUI');
  });
});
