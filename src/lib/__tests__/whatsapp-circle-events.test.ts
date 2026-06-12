/**
 * Pure-logic tests for the circle-event stream definitions powering
 * GET /api/cron/whatsapp-circle-events — the fold-in of the retired
 * whatsapp-bot-backend listener. Covers event payload parsing (field
 * extraction, the CustodyDeposited operation_type filter, malformed
 * payload rejection), amount formatting, and the message bodies.
 */

import {
  CIRCLE_EVENT_STREAMS,
  circleEventCursorKey,
  circleEventDedupeKey,
  formatTokenAmount,
  getCoinLabelFromType,
  shortAddress,
  type CircleEventMessageContext,
  type CircleEventStream,
} from '../whatsapp-bot/circle-events';

const CIRCLE = '0x' + 'c1'.repeat(32);
const MEMBER = '0x' + 'ab'.repeat(32);
const PKG = '0x' + 'aa'.repeat(32);

function stream(name: string): CircleEventStream {
  const found = CIRCLE_EVENT_STREAMS.find((s) => s.name === name);
  if (!found) throw new Error(`stream ${name} not registered`);
  return found;
}

function ctx(overrides: Partial<CircleEventMessageContext> = {}): CircleEventMessageContext {
  return {
    circleName: 'Bamenda Savers',
    memberName: null,
    resolvedCoinType: null,
    appBaseUrl: 'https://njangionchain.com',
    ...overrides,
  };
}

describe('amount formatting helpers', () => {
  it('labels coin types like the legacy bot', () => {
    expect(getCoinLabelFromType(null)).toBe('SUI');
    expect(getCoinLabelFromType('0x2::sui::SUI')).toBe('SUI');
    expect(getCoinLabelFromType('0xdead::usdc::USDC')).toBe('USDC');
    expect(getCoinLabelFromType('0xdead::coin::USDT')).toBe('USDT');
    expect(getCoinLabelFromType('0xdead::njangi::STABLECOIN')).toBe('Stablecoin');
    expect(getCoinLabelFromType('0xdead::mod::WETH')).toBe('WETH');
  });

  it('formats SUI with 9 decimals / 4 fraction digits', () => {
    expect(formatTokenAmount('1500000000', null)).toBe('1.5000 SUI');
    expect(formatTokenAmount(2_000_000_000, '0x2::sui::SUI')).toBe('2.0000 SUI');
  });

  it('formats stablecoins with 6 decimals / 2 fraction digits', () => {
    expect(formatTokenAmount('2500000', '0xdead::usdc::USDC')).toBe('2.50 USDC');
  });

  it('returns null for unparseable amounts', () => {
    expect(formatTokenAmount('not-a-number', null)).toBeNull();
    expect(formatTokenAmount(undefined, null)).toBeNull();
  });

  it('shortens addresses', () => {
    expect(shortAddress(MEMBER)).toBe(`${MEMBER.slice(0, 6)}...${MEMBER.slice(-4)}`);
  });
});

describe('stream registry', () => {
  it('registers every ported legacy stream exactly once', () => {
    const names = CIRCLE_EVENT_STREAMS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.sort()).toEqual(
      [
        'circle_activated',
        'circle_linked',
        'circle_unlinked',
        'contribution',
        'contribution_stablecoin',
        'deposit_returned',
        'member_joined',
        'member_removed',
        'payout_processed',
        'rotation_changed',
        'security_deposit',
      ].sort(),
    );
  });

  it('builds event type tags from the defining package id', () => {
    expect(stream('contribution').eventType(PKG)).toBe(
      `${PKG}::njangi_payments::ContributionMade`,
    );
    expect(stream('circle_linked').eventType(PKG)).toBe(
      `${PKG}::whatsapp_integration::CircleLinked`,
    );
    expect(stream('circle_linked').source).toBe('whatsapp');
    expect(stream('contribution').source).toBe('core');
  });

  it('every parser rejects malformed payloads instead of throwing', () => {
    for (const s of CIRCLE_EVENT_STREAMS) {
      expect(s.parse(null)).toBeNull();
      expect(s.parse('string')).toBeNull();
      expect(s.parse({})).toBeNull();
    }
  });
});

describe('circle_linked / circle_unlinked', () => {
  it('confirms a new link with a deep link to the circle', () => {
    const parsed = stream('circle_linked').parse({ circle_id: CIRCLE });
    expect(parsed).not.toBeNull();
    expect(parsed!.circleId).toBe(CIRCLE);
    expect(parsed!.includeDisabledLink).toBeUndefined();
    const body = parsed!.buildBody(ctx());
    expect(body).toContain('Bamenda Savers is now linked');
    expect(body).toContain(`https://njangionchain.com/circle/${CIRCLE}`);
  });

  it('unlink confirmations resolve via the disabled link', () => {
    const parsed = stream('circle_unlinked').parse({ circle_id: CIRCLE });
    expect(parsed!.includeDisabledLink).toBe(true);
    const body = parsed!.buildBody(ctx());
    expect(body).toContain('no longer linked');
    expect(body).toContain(`/circle/${CIRCLE}/manage`);
  });
});

describe('member_joined / member_removed', () => {
  it('announces a join with the resolved display name', () => {
    const parsed = stream('member_joined').parse({ circle_id: CIRCLE, member: MEMBER });
    expect(parsed!.memberAddress).toBe(MEMBER);
    const body = parsed!.buildBody(ctx({ memberName: 'Aminata' }));
    expect(body).toContain(`Aminata (${shortAddress(MEMBER)})`);
    expect(body).toContain('just joined');
  });

  it('falls back to the short address without a name', () => {
    const parsed = stream('member_joined').parse({ circle_id: CIRCLE, member: MEMBER });
    expect(parsed!.buildBody(ctx())).toContain(shortAddress(MEMBER));
  });

  it('mentions a returned deposit on removal only when returned', () => {
    const removed = stream('member_removed');
    const withDeposit = removed.parse({
      circle_id: CIRCLE,
      member: MEMBER,
      deposit_returned: true,
    });
    expect(withDeposit!.buildBody(ctx())).toContain('security deposit was returned');

    const withoutDeposit = removed.parse({
      circle_id: CIRCLE,
      member: MEMBER,
      deposit_returned: false,
    });
    expect(withoutDeposit!.buildBody(ctx())).not.toContain('security deposit was returned');
  });
});

describe('security_deposit (CustodyDeposited)', () => {
  const deposit = stream('security_deposit');

  it('only matches operation_type 3', () => {
    expect(
      deposit.parse({ circle_id: CIRCLE, member: MEMBER, amount: '5', operation_type: 1 }),
    ).toBeNull();
    expect(
      deposit.parse({ circle_id: CIRCLE, member: MEMBER, amount: '5', operation_type: '3' }),
    ).not.toBeNull();
  });

  it('includes the amount only when the coin type was resolved', () => {
    const parsed = deposit.parse({
      circle_id: CIRCLE,
      member: MEMBER,
      amount: '1500000000',
      operation_type: 3,
    });
    // Unknown coin type → no figure (decimals would be a guess).
    expect(parsed!.buildBody(ctx())).not.toContain('1.5000');
    expect(
      parsed!.buildBody(ctx({ resolvedCoinType: '0x2::sui::SUI' })),
    ).toContain('of 1.5000 SUI');
  });

  it('accepts the legacy depositor field', () => {
    const parsed = deposit.parse({
      circle_id: CIRCLE,
      depositor: MEMBER,
      amount: '1',
      operation_type: 3,
    });
    expect(parsed!.memberAddress).toBe(MEMBER);
  });
});

describe('contribution streams', () => {
  it('formats the SUI contribution with cycle number', () => {
    const parsed = stream('contribution').parse({
      circle_id: CIRCLE,
      member: MEMBER,
      amount: '1500000000',
      cycle: '2',
    });
    const body = parsed!.buildBody(ctx({ memberName: 'Aminata' }));
    expect(body).toContain('Cycle 2:');
    expect(body).toContain('paid 1.5000 SUI');
  });

  it('uses the on-event coin type for stablecoin contributions', () => {
    const parsed = stream('contribution_stablecoin').parse({
      circle_id: CIRCLE,
      member: MEMBER,
      amount: '2500000',
      cycle: 1,
      coin_type: '0xdead::usdc::USDC',
    });
    expect(parsed!.buildBody(ctx())).toContain('paid 2.50 USDC');
  });

  it('rejects contributions whose amount cannot be parsed', () => {
    expect(
      stream('contribution').parse({ circle_id: CIRCLE, member: MEMBER, amount: 'x' }),
    ).toBeNull();
  });
});

describe('deposit_returned / rotation_changed / circle_activated / payout_processed', () => {
  it('reports the returned amount using the event coin type', () => {
    const parsed = stream('deposit_returned').parse({
      circle_id: CIRCLE,
      member: MEMBER,
      amount: '1000000000',
      coin_type: '0x2::sui::SUI',
    });
    expect(parsed!.buildBody(ctx())).toContain('received 1.0000 SUI back');
  });

  it('mentions the rotation size when present', () => {
    const parsed = stream('rotation_changed').parse({
      circle_id: CIRCLE,
      member_count: '7',
    });
    expect(parsed!.buildBody(ctx())).toContain('7 members');
  });

  it('announces activation', () => {
    const parsed = stream('circle_activated').parse({ circle_id: CIRCLE });
    expect(parsed!.buildBody(ctx())).toContain('Bamenda Savers is now live');
  });

  it('reports legacy payouts in SUI to the recipient name', () => {
    const parsed = stream('payout_processed').parse({
      circle_id: CIRCLE,
      recipient: MEMBER,
      amount: '3000000000',
      cycle: 4,
    });
    expect(parsed!.memberAddress).toBe(MEMBER);
    const body = parsed!.buildBody(ctx({ memberName: 'Aminata' }));
    expect(body).toContain('Cycle 4:');
    expect(body).toContain('received 3.0000 SUI');
  });
});

describe('keys', () => {
  it('builds stable dedupe and cursor keys', () => {
    expect(circleEventDedupeKey('contribution', 'tx1', '0')).toBe('contribution:tx1:0');
    expect(circleEventCursorKey('contribution', PKG, 'testnet')).toBe(
      `whatsapp-events:contribution:${PKG}:testnet`,
    );
  });
});
