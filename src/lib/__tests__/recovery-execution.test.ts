import { readFileSync } from 'fs';
import { join } from 'path';
import { loadRecoveryExecutionStatus } from '@/lib/recovery-execution';

describe('recovery-execution helpers', () => {
  it('builds recovery execution state from matching events only', async () => {
    const client = {
      queryEvents: jest
        .fn()
        .mockResolvedValueOnce({
          data: [
            {
              timestampMs: '1000',
              parsedJson: {
                circle_id: '0xCircle',
                timestamp: '1000',
                executor: '0xAdmin',
                member_count: '4',
                total_sui_refund: '3000000000',
                total_stablecoin_refund: '2000000',
                used_auto_release: false,
                trigger_role: '0',
              },
            },
          ],
          hasNextPage: false,
          nextCursor: null,
        })
        .mockResolvedValueOnce({
          data: [
            {
              timestampMs: '1200',
              parsedJson: {
                circle_id: '0xCircle',
                member: '0xA',
                timestamp: '1200',
                sui_contributions_refunded: '1000000000',
                sui_deposit_refunded: '500000000',
                stablecoin_contributions_refunded: '1000000',
                stablecoin_deposit_refunded: '250000',
              },
            },
            {
              timestampMs: '1300',
              parsedJson: {
                circle_id: '0xOther',
                member: '0xB',
                timestamp: '1300',
                sui_contributions_refunded: '999',
                sui_deposit_refunded: '999',
                stablecoin_contributions_refunded: '999',
                stablecoin_deposit_refunded: '999',
              },
            },
          ],
          hasNextPage: false,
          nextCursor: null,
        })
        .mockResolvedValueOnce({
          data: [
            {
              timestampMs: '1500',
              parsedJson: {
                circle_id: '0xCircle',
                refunded_members: '1',
                timestamp: '1500',
              },
            },
          ],
          hasNextPage: false,
          nextCursor: null,
        }),
    };

    await expect(
      loadRecoveryExecutionStatus({
        client: client as never,
        packageId: '0xpackage',
        circleId: '0xCircle',
      }),
    ).resolves.toEqual({
      startedAt: 1000,
      completedAt: 1500,
      executor: '0xAdmin',
      refundedMembers: 1,
      totalMembers: 4,
      totalSuiRefundRaw: 3000000000n,
      totalStablecoinRefundRaw: 2000000n,
      usedAutoRelease: false,
      triggerRole: 'vote_execution',
      memberRefunds: [
        {
          member: '0xA',
          timestamp: 1200,
          suiRefundRaw: 1500000000n,
          stablecoinRefundRaw: 1250000n,
        },
      ],
    });
  });

  it('returns null when no matching recovery execution exists', async () => {
    const client = {
      queryEvents: jest
        .fn()
        .mockResolvedValueOnce({ data: [], hasNextPage: false, nextCursor: null })
        .mockResolvedValueOnce({ data: [], hasNextPage: false, nextCursor: null })
        .mockResolvedValueOnce({ data: [], hasNextPage: false, nextCursor: null }),
    };

    await expect(
      loadRecoveryExecutionStatus({
        client: client as never,
        packageId: '0xpackage',
        circleId: '0xCircle',
      }),
    ).resolves.toBeNull();
  });

  // A page that does not say the list ends (hasNextPage: false) is not the
  // whole list: the load rejects rather than answer from what it read so far.
  const startedEvent = {
    id: { txDigest: 'tx-started-1', eventSeq: '0' },
    timestampMs: '1000',
    parsedJson: {
      circle_id: '0xCircle',
      timestamp: '1000',
      executor: '0xAdmin',
      member_count: '4',
      total_sui_refund: '0',
      total_stablecoin_refund: '0',
      used_auto_release: false,
      trigger_role: '0',
    },
  };
  const malformedStartedPages: Array<[string, unknown]> = [
    ['hasNextPage is missing', { data: [startedEvent] }],
    ['hasNextPage is missing from an empty page', { data: [] }],
    ['hasNextPage is not a boolean', { data: [startedEvent], hasNextPage: 'false', nextCursor: null }],
    ['hasNextPage is true with no cursor', { data: [startedEvent], hasNextPage: true, nextCursor: null }],
    ['hasNextPage is true with a malformed cursor', { data: [startedEvent], hasNextPage: true, nextCursor: { txDigest: 'tx-started-1' } }],
    ['the cursor never moves past the page', { data: [startedEvent], hasNextPage: true, nextCursor: { txDigest: 'tx-started-1', eventSeq: '0' } }],
    ['data is not a list', { data: null, hasNextPage: false, nextCursor: null }],
  ];

  it.each(malformedStartedPages)('rejects instead of answering when %s', async (_label, page) => {
    const queryEvents = jest.fn(async ({ query }: { query: { MoveEventType: string } }) =>
      query.MoveEventType.endsWith('::RecoveryExecutionStarted')
        ? page
        : { data: [], hasNextPage: false, nextCursor: null },
    );

    await expect(
      loadRecoveryExecutionStatus({
        client: { queryEvents } as never,
        packageId: '0xpackage',
        circleId: '0xCircle',
      }),
    ).rejects.toThrow('RecoveryExecutionStarted');
  });
});

describe('the recovery coin type comes from the custody wallet, not from events', () => {
  // execute_recovery<CoinType> / trigger_auto_release<CoinType> and the refund
  // decimals used to take their coin type from event scans that describe no
  // escrow-era wallet: StablecoinContributionMade is emitted only by the
  // retired legacy rail, StablecoinDepositWithPrice carries the literal
  // "stablecoin" instead of a type, and StablecoinHoldingUpdated an unprefixed
  // type name. resolveRecoveryCoinType reads the wallet itself.
  const LEGACY_STABLECOIN_EVENTS = [
    'StablecoinContributionMade',
    'StablecoinDepositWithPrice',
    'StablecoinHoldingUpdated',
  ];

  it.each(['src/lib/recovery-execution.ts', 'src/pages/circle/[id]/index.tsx'])(
    '%s queries none of the legacy stablecoin events',
    (rel) => {
      const source = readFileSync(join(process.cwd(), rel), 'utf8');
      for (const eventName of LEGACY_STABLECOIN_EVENTS) {
        expect(source).not.toMatch(new RegExp(`::${eventName}\\b`));
      }
    },
  );

  it('the circle page resolves the recovery coin type from the wallet', () => {
    const source = readFileSync(join(process.cwd(), 'src/pages/circle/[id]/index.tsx'), 'utf8');
    expect(source).toContain('resolveRecoveryCoinType');
    expect(source).not.toContain('loadRecoveryStablecoinCoinType');
  });
});
