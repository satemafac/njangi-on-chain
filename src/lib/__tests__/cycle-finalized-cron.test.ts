// cycle-finalized-cron.test.ts — Pure-function coverage for the cron's
// cursor-advance logic. The June 2026 ops audit found the legacy worker
// persisted the OLDEST event id of each batch and never followed
// nextCursor (re-processing the batch every poll, advancing one event per
// minute). These tests pin the fixed contract: ascending pages are drained
// until hasNextPage is false, and the NEWEST processed cursor is persisted
// after every page.

import {
  DEFAULT_YOUR_TURN_MAX_EVENT_AGE_MS,
  drainCycleFinalizedEvents,
  formatCoinAmount,
  formatEscrowPayout,
  parseContributionRecordedEvent,
  parseYourTurnEscrow,
  yourTurnCursorKey,
  yourTurnMaxEventAgeMs,
  yourTurnSkipReason,
  type CycleFinalizedEventEnvelope,
  type EventCursor,
  type EventPage,
  type NotifyOutcome,
  type ParsedContributionRecorded,
  type YourTurnEscrow,
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

// ---------------------------------------------------------------------------
// "Your turn" trigger
//
// Fixtures follow a live testnet round (circle 0xa3fada18…, escrow
// 0xe30c91fe…, 2026-09-07): its pot filled at 00:51:31 UTC (tx AUztZAjp…)
// and the recipient collected 65s later in tx FLtRuWh…, which emitted
// CycleFinalized and ClaimRedeemed together. A nudge keyed to
// CycleFinalized could only ever arrive after the collection.
// ---------------------------------------------------------------------------

const PACKAGE = '0x89cddf4dfe654e7c7b16333096d9e750cf04bb96f7de934403a512d460594f02';
const USDC = '0x26b3bc67befc214058ca78ea9a2690298d731a2d4309485ec3d40198063c4abc::usdc::USDC';
const ESCROW = '0xe30c91fee48d74587d6dc549b301f8c7424031116e7c8d8cefaf410c3894fbe0';
const CIRCLE = '0xa3fada18d0d030f0f26e9a7ea77cd4f260a13649426a97bc9063c6f47de675ed';
const RECIPIENT = '0x1f8d4bdfa384503b0901c73c9925c5b29dad510766542a30dc3b6904ddba897b';
const PAYER_1 = '0xe833deaa9c038ac2edd397323ed5dbde1e622aadfd0d526332a214a31f9de17d';
const PAYER_2 = '0xdf98684462fb5b3e85dffcc34fda108b7c34e7da37ab88f0ae3a530ef804a97d';

/** The pot-filling ContributionRecorded's parsedJson, as the RPC returned it. */
const POT_FILLING_EVENT = {
  amount: '100000',
  contributor: PAYER_2,
  contributors_so_far: '2',
  cycle_no: '5',
  escrow_id: ESCROW,
  total_contributed: '200000',
};

interface EscrowOverrides {
  coinType?: string;
  claimed?: boolean;
  finalized?: boolean;
  refunded?: boolean;
  snapshot?: Record<string, unknown>;
}

/** A getObject({ showType, showContent }) response shaped like the live read. */
function escrowResponse(overrides: EscrowOverrides = {}) {
  const type = `${PACKAGE}::njangi_cycle_escrow::CycleEscrow<${overrides.coinType ?? USDC}>`;
  return {
    data: {
      objectId: ESCROW,
      type,
      content: {
        dataType: 'moveObject',
        type,
        fields: {
          balance: '200000',
          circle_id: CIRCLE,
          claim_expires_at_ms: '0',
          claimed: overrides.claimed ?? false,
          compliance_config_id: null,
          contributors_count: '2',
          finalized: overrides.finalized ?? false,
          id: { id: ESCROW },
          refunded: overrides.refunded ?? false,
          requires_attestation: false,
          snapshot: {
            type: `${PACKAGE}::njangi_cycle_escrow::CycleSnapshot`,
            fields: {
              contribution_amount: '100000',
              cycle_no: '5',
              members: [PAYER_1, PAYER_2, RECIPIENT],
              recipient: RECIPIENT,
              required_contributors: '2',
              ...overrides.snapshot,
            },
          },
        },
      },
    },
  };
}

const OPEN_ESCROW: YourTurnEscrow = {
  circleId: CIRCLE,
  coinType: USDC,
  recipient: RECIPIENT,
  requiredContributors: 2,
  claimed: false,
  refunded: false,
};

const POT_FILLING: ParsedContributionRecorded = {
  escrowId: ESCROW,
  cycleNo: 5,
  contributorsSoFar: 2,
  totalContributed: '200000',
};

describe('parseContributionRecordedEvent', () => {
  it('parses the live payload (u64s arrive as strings)', () => {
    expect(parseContributionRecordedEvent(POT_FILLING_EVENT)).toEqual(POT_FILLING);
  });

  it('accepts u64s that arrive as numbers', () => {
    expect(
      parseContributionRecordedEvent({
        ...POT_FILLING_EVENT,
        contributors_so_far: 2,
        cycle_no: 5,
        total_contributed: 200000,
      }),
    ).toEqual(POT_FILLING);
  });

  it.each(['escrow_id', 'cycle_no', 'contributors_so_far', 'total_contributed'])(
    'rejects a payload without %s',
    (field) => {
      const payload: Record<string, unknown> = { ...POT_FILLING_EVENT };
      delete payload[field];
      expect(parseContributionRecordedEvent(payload)).toBeNull();
    },
  );

  it('rejects malformed numbers and non-objects', () => {
    expect(
      parseContributionRecordedEvent({ ...POT_FILLING_EVENT, total_contributed: '1.5' }),
    ).toBeNull();
    expect(
      parseContributionRecordedEvent({ ...POT_FILLING_EVENT, contributors_so_far: '-1' }),
    ).toBeNull();
    expect(parseContributionRecordedEvent(null)).toBeNull();
    expect(parseContributionRecordedEvent('nope')).toBeNull();
    expect(parseContributionRecordedEvent([POT_FILLING_EVENT])).toBeNull();
  });
});

describe('parseYourTurnEscrow', () => {
  it('reads the circle, coin, recipient, required count and live state', () => {
    expect(parseYourTurnEscrow(escrowResponse({ claimed: true, finalized: true }))).toEqual({
      ...OPEN_ESCROW,
      claimed: true,
    });
  });

  it("takes the coin from the object's type argument, SUI included", () => {
    expect(parseYourTurnEscrow(escrowResponse({ coinType: '0x2::sui::SUI' }))?.coinType).toBe(
      '0x2::sui::SUI',
    );
  });

  it('accepts a flattened snapshot and a type that is only on the content', () => {
    const response = escrowResponse();
    const { fields } = response.data.content;
    const flattened = {
      data: {
        objectId: ESCROW,
        content: {
          ...response.data.content,
          fields: { ...fields, snapshot: fields.snapshot.fields },
        },
      },
    };
    expect(parseYourTurnEscrow(flattened)).toEqual(OPEN_ESCROW);
  });

  it('returns null for an object that does not exist or was deleted', () => {
    expect(parseYourTurnEscrow({ error: { code: 'notExists', object_id: ESCROW } })).toBeNull();
    expect(parseYourTurnEscrow({ error: { code: 'deleted', object_id: ESCROW } })).toBeNull();
  });

  it('returns null for an object of another type', () => {
    expect(
      parseYourTurnEscrow({ data: { objectId: ESCROW, type: `${PACKAGE}::njangi_circles::Circle` } }),
    ).toBeNull();
    expect(parseYourTurnEscrow({ data: { objectId: ESCROW, type: 'package' } })).toBeNull();
  });

  it('returns null when a field the nudge needs is missing or malformed', () => {
    expect(parseYourTurnEscrow(escrowResponse({ snapshot: { recipient: undefined } }))).toBeNull();
    expect(
      parseYourTurnEscrow(escrowResponse({ snapshot: { required_contributors: '0' } })),
    ).toBeNull();
    const claimedAsText = escrowResponse();
    (claimedAsText.data.content.fields as Record<string, unknown>).claimed = 'true';
    expect(parseYourTurnEscrow(claimedAsText)).toBeNull();
  });

  it('throws when the response is not an answer, so the cron halts instead of skipping', () => {
    expect(() => parseYourTurnEscrow({ error: { code: 'displayError' } })).toThrow(
      /displayError/,
    );
    expect(() => parseYourTurnEscrow({})).toThrow(/no object type/);
    expect(() => parseYourTurnEscrow({ data: { objectId: ESCROW } })).toThrow(/no object type/);
    const noContent = escrowResponse();
    expect(() =>
      parseYourTurnEscrow({ data: { objectId: ESCROW, type: noContent.data.type } }),
    ).toThrow(/no object content/);
  });
});

describe('yourTurnSkipReason', () => {
  it('nudges for the contribution that fills the pot', () => {
    expect(yourTurnSkipReason(POT_FILLING, OPEN_ESCROW)).toBeNull();
  });

  it('skips a contribution that leaves the pot short', () => {
    expect(yourTurnSkipReason({ ...POT_FILLING, contributorsSoFar: 1 }, OPEN_ESCROW)).toBe(
      'not_pot_filling',
    );
  });

  it('skips a pot the recipient already collected, like the live 2026-09-07 round', () => {
    const live = parseYourTurnEscrow(escrowResponse({ claimed: true, finalized: true }));
    expect(live && yourTurnSkipReason(POT_FILLING, live)).toBe('already_collected');
  });

  it('skips a refunded round', () => {
    expect(yourTurnSkipReason(POT_FILLING, { ...OPEN_ESCROW, refunded: true })).toBe('refunded');
  });

  it('still nudges a round finalized to the recipient but not yet collected', () => {
    // finalize_to_recipient mints a Claim into the recipient's wallet: the
    // escrow reads finalized, unclaimed, and the payout is still waiting.
    const finalizedOnly = parseYourTurnEscrow(escrowResponse({ finalized: true }));
    expect(finalizedOnly && yourTurnSkipReason(POT_FILLING, finalizedOnly)).toBeNull();
  });
});

describe('formatEscrowPayout', () => {
  it("states the pot in the escrow's own coin", () => {
    // The env-wide default (9 decimals, SUI) printed this pot as "0.0002 SUI".
    expect(formatEscrowPayout('200000', USDC)).toBe('0.2 USDC');
    expect(formatEscrowPayout('350000000', USDC)).toBe('350 USDC');
    expect(formatEscrowPayout('3000000000', '0x2::sui::SUI')).toBe('3 SUI');
    expect(formatEscrowPayout('2500000', '0xabc::usdt::USDT')).toBe('2.5 USDT');
  });

  it('returns null for a coin whose decimals are unknown', () => {
    expect(formatEscrowPayout('100', '0xabc::fake::FAKE')).toBeNull();
  });
});

describe('yourTurnCursorKey', () => {
  it('names its own row, so the CycleFinalized cursor is never resumed', () => {
    expect(yourTurnCursorKey('0xpkg', 'testnet')).toBe(
      'your-turn:contribution_recorded:0xpkg:testnet',
    );
    expect(yourTurnCursorKey('0xpkg', 'testnet')).not.toBe('0xpkg:testnet');
  });
});

describe('yourTurnMaxEventAgeMs', () => {
  it.each([
    [undefined, DEFAULT_YOUR_TURN_MAX_EVENT_AGE_MS],
    ['', DEFAULT_YOUR_TURN_MAX_EVENT_AGE_MS],
    ['   ', DEFAULT_YOUR_TURN_MAX_EVENT_AGE_MS],
    ['abc', DEFAULT_YOUR_TURN_MAX_EVENT_AGE_MS],
    ['NaN', DEFAULT_YOUR_TURN_MAX_EVENT_AGE_MS],
    ['-5', DEFAULT_YOUR_TURN_MAX_EVENT_AGE_MS],
    ['3600000', 3_600_000],
    [' 7200000 ', 7_200_000],
    ['0', 0],
  ])('%p → %p', (raw, expected) => {
    expect(yourTurnMaxEventAgeMs(raw)).toBe(expected);
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
