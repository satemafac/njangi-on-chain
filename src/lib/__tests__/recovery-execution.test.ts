import {
  loadRecoveryExecutionStatus,
  loadRecoveryStablecoinCoinType,
} from '@/lib/recovery-execution';

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
        .mockResolvedValueOnce({ data: [] })
        .mockResolvedValueOnce({ data: [] })
        .mockResolvedValueOnce({ data: [] }),
    };

    await expect(
      loadRecoveryExecutionStatus({
        client: client as never,
        packageId: '0xpackage',
        circleId: '0xCircle',
      }),
    ).resolves.toBeNull();
  });

  it('resolves the most recent stablecoin coin type for a circle', async () => {
    const client = {
      queryEvents: jest
        .fn()
        .mockResolvedValueOnce({
          data: [
            {
              timestampMs: '1200',
              parsedJson: {
                circle_id: '0xCircle',
                coin_type: '0x1::usdc::USDC',
              },
            },
          ],
        })
        .mockResolvedValueOnce({
          data: [
            {
              timestampMs: '1250',
              parsedJson: {
                circle_id: '0xOther',
                coin_type: '0x1::usdt::USDT',
              },
            },
          ],
        })
        .mockResolvedValueOnce({
          data: [
            {
              timestampMs: '1300',
              parsedJson: {
                circle_id: '0xCircle',
                coin_type: '0x2::sui_usde::SUI_USDE',
              },
            },
          ],
        }),
    };

    await expect(
      loadRecoveryStablecoinCoinType({
        client: client as never,
        packageId: '0xpackage',
        circleId: '0xCircle',
      }),
    ).resolves.toBe('0x2::sui_usde::SUI_USDE');
  });
});
