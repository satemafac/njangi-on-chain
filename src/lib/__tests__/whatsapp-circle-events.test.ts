/**
 * Pure-logic tests for the circle-event stream definitions powering
 * GET /api/cron/whatsapp-circle-events — the fold-in of the retired
 * whatsapp-bot-backend listener. Covers event payload parsing (field
 * extraction, the CustodyDeposited operation_type filter, malformed
 * payload rejection), the escrow-object read behind the escrow-rail
 * streams, amount formatting, and the message bodies.
 */

import {
  CIRCLE_EVENT_STREAMS,
  circleEventCursorKey,
  circleEventDedupeKey,
  formatTokenAmount,
  getCoinLabelFromType,
  parseEscrowSubject,
  shortAddress,
  type CircleEventMessageContext,
  type CircleEventStream,
  type EscrowSubject,
} from '../whatsapp-bot/circle-events';
import type { WhatsAppTemplatePayload } from '../whatsapp-notifier';

const CIRCLE = '0x' + 'c1'.repeat(32);
const MEMBER = '0x' + 'ab'.repeat(32);
const RECIPIENT = '0x' + '1f'.repeat(32);
const ESCROW = '0x' + 'e3'.repeat(32);
const PKG = '0x' + 'aa'.repeat(32);
const USDC = '0x' + '26'.repeat(32) + '::usdc::USDC';
const SUI = '0x2::sui::SUI';

const THIRD_MEMBER = '0x' + 'df'.repeat(32);

/**
 * What the cron hands escrow-rail parsers after reading the escrow. Its
 * events carry cycle_no 5 (a lap); the recipient sits in the second of three
 * seats, so the round is (5 − 1) × 3 + 2 = 14.
 */
const USDC_ESCROW: EscrowSubject = {
  circleId: CIRCLE,
  coinType: USDC,
  requiredContributors: 2,
  recipient: RECIPIENT,
  members: [MEMBER, RECIPIENT, THIRD_MEMBER],
};

/**
 * getObject({ showType, showContent }) response for a CycleEscrow<T>, in
 * the shape testnet publicnode returns (escrow 0xe30c91…, round 5 of
 * circle 0xa3fada…): u64s as strings, the snapshot as { type, fields }.
 */
function escrowObjectResponse(coinType: string = USDC) {
  const type = `${PKG}::njangi_cycle_escrow::CycleEscrow<${coinType}>`;
  return {
    data: {
      objectId: ESCROW,
      version: '1006074990',
      digest: 'digest',
      type,
      content: {
        dataType: 'moveObject',
        type,
        hasPublicTransfer: false,
        fields: {
          id: { id: ESCROW },
          balance: '0',
          circle_id: CIRCLE,
          claimed: true,
          contributors_count: '2',
          finalized: true,
          refunded: false,
          requires_attestation: false,
          snapshot: {
            type: `${PKG}::njangi_cycle_escrow::CycleSnapshot`,
            fields: {
              cycle_no: '5',
              recipient: RECIPIENT,
              members: [MEMBER, RECIPIENT, THIRD_MEMBER],
              required_contributors: '2',
              contribution_amount: '100000',
              due_at_ms: '1792540800000',
              opened_at_ms: '1788742214815',
            },
          },
        },
      },
    },
  };
}

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
  it('registers every stream exactly once', () => {
    const names = CIRCLE_EVENT_STREAMS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.sort()).toEqual(
      [
        'circle_activated',
        'circle_linked',
        'circle_unlinked',
        'claim_redeemed',
        'contribution_recorded',
        'deposit_returned',
        'member_joined',
        'member_removed',
        'rotation_changed',
        'security_deposit',
      ].sort(),
    );
  });

  it('builds event type tags from the defining package id', () => {
    expect(stream('contribution_recorded').eventType(PKG)).toBe(
      `${PKG}::njangi_cycle_escrow::ContributionRecorded`,
    );
    expect(stream('claim_redeemed').eventType(PKG)).toBe(
      `${PKG}::njangi_cycle_escrow::ClaimRedeemed`,
    );
    expect(stream('circle_linked').eventType(PKG)).toBe(
      `${PKG}::whatsapp_integration::CircleLinked`,
    );
    expect(stream('circle_linked').source).toBe('whatsapp');
    expect(stream('contribution_recorded').source).toBe('core');
    expect(stream('claim_redeemed').source).toBe('core');
  });

  it('relays no refund event, so a cancelled stalled round is treated like an expired claim', () => {
    // Both refund paths set the escrow's `refunded` flag and emit their own
    // events (EscrowCancelled / ExpiredClaimRefunded, plus one
    // ContributionRefunded per member). Neither is relayed: the relay has
    // no refund message, and inventing one would mean a new WhatsApp
    // template to approve. The dashboard scanner skips the round the same
    // way (NjangiRoundAlerts: `if (state.refunded) continue`).
    const types = CIRCLE_EVENT_STREAMS.map((s) => s.eventType(PKG));
    for (const refund of [
      '::njangi_cycle_escrow::EscrowCancelled',
      '::njangi_cycle_escrow::ExpiredClaimRefunded',
      '::njangi_cycle_escrow::ContributionRefunded',
    ]) {
      expect(types.filter((t) => t.endsWith(refund))).toEqual([]);
    }
  });

  it('listens to no event of the retired legacy payment rail', () => {
    // njangi_payments::contribute / trigger_payout and
    // njangi_circles::contribute_stablecoin are off (isLegacyRailEnabled);
    // a stream keyed to their events never fires on a live circle.
    const types = CIRCLE_EVENT_STREAMS.map((s) => s.eventType(PKG));
    for (const legacy of [
      '::njangi_payments::ContributionMade',
      '::njangi_circles::StablecoinContributionMade',
      '::njangi_payments::PayoutProcessed',
    ]) {
      expect(types.filter((t) => t.endsWith(legacy))).toEqual([]);
    }
  });

  it('only the escrow-rail streams ask the cron to read an escrow', () => {
    const escrowStreams = CIRCLE_EVENT_STREAMS.filter((s) => s.escrowIdOf).map((s) => s.name);
    expect(escrowStreams.sort()).toEqual(['claim_redeemed', 'contribution_recorded']);
    for (const name of escrowStreams) {
      const s = stream(name);
      expect(s.escrowIdOf!({ escrow_id: ESCROW })).toBe(ESCROW);
      expect(s.escrowIdOf!({})).toBeNull();
      expect(s.escrowIdOf!(null)).toBeNull();
      expect(s.escrowIdOf!({ escrow_id: 42 })).toBeNull();
    }
  });

  it('every parser rejects malformed payloads instead of throwing', () => {
    for (const s of CIRCLE_EVENT_STREAMS) {
      for (const escrow of [undefined, USDC_ESCROW]) {
        expect(s.parse(null, escrow)).toBeNull();
        expect(s.parse('string', escrow)).toBeNull();
        expect(s.parse({}, escrow)).toBeNull();
      }
    }
  });
});

describe('parseEscrowSubject (the escrow-rail object read)', () => {
  it('reads circle id, coin type, round target and seats off a CycleEscrow<USDC>', () => {
    expect(parseEscrowSubject(escrowObjectResponse())).toEqual(USDC_ESCROW);
  });

  it('reads the coin type of a SUI-settled escrow', () => {
    expect(parseEscrowSubject(escrowObjectResponse(SUI))?.coinType).toBe(SUI);
  });

  it('keeps a nested generic coin type whole', () => {
    const nested = '0xabc::wrapper::Wrapped<0x2::sui::SUI>';
    expect(parseEscrowSubject(escrowObjectResponse(nested))?.coinType).toBe(nested);
  });

  it('falls back to content.type when the object type was not requested', () => {
    const response = escrowObjectResponse();
    delete (response.data as { type?: string }).type;
    expect(parseEscrowSubject(response)?.coinType).toBe(USDC);
  });

  it('leaves the round target null when the snapshot is unreadable', () => {
    const response = escrowObjectResponse();
    delete (response.data.content.fields as { snapshot?: unknown }).snapshot;
    expect(parseEscrowSubject(response)).toEqual({
      circleId: CIRCLE,
      coinType: USDC,
      requiredContributors: null,
      recipient: null,
      members: null,
    });
  });

  it('returns null when the response holds no CycleEscrow', () => {
    // The RPC's answer for an id with no object behind it.
    expect(
      parseEscrowSubject({ error: { code: 'notExists', object_id: ESCROW } }),
    ).toBeNull();
    expect(parseEscrowSubject(null)).toBeNull();
    expect(parseEscrowSubject({ data: null })).toBeNull();

    const circleObject = escrowObjectResponse();
    circleObject.data.type = `${PKG}::njangi_circles::Circle`;
    circleObject.data.content.type = `${PKG}::njangi_circles::Circle`;
    expect(parseEscrowSubject(circleObject)).toBeNull();

    const noCircle = escrowObjectResponse();
    delete (noCircle.data.content.fields as { circle_id?: string }).circle_id;
    expect(parseEscrowSubject(noCircle)).toBeNull();
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

describe('contribution_recorded (njangi_cycle_escrow::ContributionRecorded)', () => {
  const contribution = stream('contribution_recorded');
  // Lap 5 of testnet circle 0xa3fada…: the second of two payers.
  const EVENT = {
    escrow_id: ESCROW,
    cycle_no: '5',
    contributor: MEMBER,
    amount: '100000',
    contributors_so_far: '2',
    total_contributed: '200000',
  };

  it('attributes the event to the escrow circle and the contributor', () => {
    const parsed = contribution.parse(EVENT, USDC_ESCROW);
    expect(parsed!.circleId).toBe(CIRCLE);
    expect(parsed!.memberAddress).toBe(MEMBER);
    expect(parsed!.includeDisabledLink).toBeUndefined();
  });

  it('reports a USDC contribution with 6 decimals, the round and progress', () => {
    const body = contribution
      .parse(EVENT, USDC_ESCROW)!
      .buildBody(ctx({ memberName: 'Aminata' }));
    expect(body).toBe(
      'Contribution received in Bamenda Savers.\n' +
        `Round 14: Aminata (${shortAddress(MEMBER)}) paid 0.10 USDC. ` +
        '2 of 2 members have paid in for this round.\n' +
        `View progress: https://njangionchain.com/circle/${CIRCLE}`,
    );
  });

  it('reports a SUI-settled contribution with 9 decimals', () => {
    const body = contribution
      .parse(
        { ...EVENT, amount: '1500000000', contributors_so_far: '1' },
        { ...USDC_ESCROW, coinType: SUI, requiredContributors: 4 },
      )!
      .buildBody(ctx());
    expect(body).toContain(`${shortAddress(MEMBER)} paid 1.5000 SUI.`);
    expect(body).toContain('1 of 4 members have paid in for this round.');
  });

  it('omits the figure for a coin whose decimals are unknown', () => {
    const body = contribution
      .parse(
        { ...EVENT, amount: '1500000000' },
        { ...USDC_ESCROW, coinType: '0xbeef::wrapped::WETH' },
      )!
      .buildBody(ctx());
    expect(body).toContain('paid their share.');
    expect(body).not.toMatch(/\d\.\d+ WETH/);
  });

  it('numbers the round circle-wide, never by the lap in cycle_no', () => {
    const body = contribution.parse(EVENT, USDC_ESCROW)!.buildBody(ctx());
    expect(body).not.toContain('Round 5:');
    // Without the seats the round cannot be placed, and none is named.
    const unplaced = contribution
      .parse(EVENT, { ...USDC_ESCROW, members: null })!
      .buildBody(ctx());
    expect(unplaced).not.toMatch(/Round \d/);
    expect(unplaced).toContain(`${shortAddress(MEMBER)} paid 0.10 USDC.`);
  });

  it('drops the progress clause when the round target is unreadable', () => {
    const body = contribution
      .parse(EVENT, { ...USDC_ESCROW, requiredContributors: null })!
      .buildBody(ctx());
    expect(body).toContain('paid 0.10 USDC.\n');
    expect(body).not.toContain('members have paid in');
  });

  it('cannot build without the escrow the cron resolved', () => {
    expect(contribution.parse(EVENT)).toBeNull();
    expect(contribution.parse({ ...EVENT, contributor: undefined }, USDC_ESCROW)).toBeNull();
  });

  it('stays on the freeform text fallback (no approved template)', () => {
    expect(contribution.parse(EVENT, USDC_ESCROW)!.buildTemplate).toBeUndefined();
  });
});

describe('claim_redeemed (njangi_cycle_escrow::ClaimRedeemed)', () => {
  const payout = stream('claim_redeemed');
  // Lap 5 of testnet circle 0xa3fada…: two 0.10 USDC shares collected.
  const EVENT = { escrow_id: ESCROW, cycle_no: '5', recipient: RECIPIENT, amount: '200000' };

  it('reports the collection to the recipient display name', () => {
    const parsed = payout.parse(EVENT, USDC_ESCROW);
    expect(parsed!.circleId).toBe(CIRCLE);
    expect(parsed!.memberAddress).toBe(RECIPIENT);
    expect(parsed!.buildBody(ctx({ memberName: 'Aminata' }))).toBe(
      'Payout collected in Bamenda Savers.\n' +
        `Round 14: Aminata (${shortAddress(RECIPIENT)}) received 0.20 USDC.\n` +
        `View circle: https://njangionchain.com/circle/${CIRCLE}`,
    );
  });

  it('formats a SUI payout with 9 decimals', () => {
    const body = payout
      .parse({ ...EVENT, amount: '3000000000' }, { ...USDC_ESCROW, coinType: SUI })!
      .buildBody(ctx());
    expect(body).toContain(`${shortAddress(RECIPIENT)} received 3.0000 SUI.`);
  });

  it('omits the figure for a coin whose decimals are unknown', () => {
    const body = payout
      .parse(EVENT, { ...USDC_ESCROW, coinType: '0xbeef::wrapped::WETH' })!
      .buildBody(ctx());
    expect(body).toContain('received their payout.');
  });

  it('cannot build without the escrow the cron resolved', () => {
    expect(payout.parse(EVENT)).toBeNull();
    expect(payout.parse({ ...EVENT, recipient: '' }, USDC_ESCROW)).toBeNull();
  });
});

describe('deposit_returned / rotation_changed / circle_activated', () => {
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
});

describe('buildTemplate (Meta-approved business-initiated sends)', () => {
  function bodyParams(t: WhatsAppTemplatePayload): string[] {
    const body = t.components?.find((c) => c.type === 'body');
    return (body?.parameters ?? []).map((p) => p.text);
  }
  function buttonParam(t: WhatsAppTemplatePayload): string | undefined {
    const btn = t.components?.find((c) => c.type === 'button');
    return btn?.parameters?.[0]?.text;
  }
  function template(
    name: string,
    parsedJson: unknown,
    overrides: Partial<CircleEventMessageContext> = {},
    escrow?: EscrowSubject,
  ): WhatsAppTemplatePayload | null {
    const parsed = stream(name).parse(parsedJson, escrow);
    if (!parsed) throw new Error(`stream ${name} rejected its fixture payload`);
    if (!parsed.buildTemplate) return null;
    return parsed.buildTemplate(ctx(overrides));
  }

  it('circle_linked sends no template, because the approved circle_link body over-promises', () => {
    // WHATSAPP_TEMPLATES.md: that body promises cycle deadlines and
    // "important alerts", which nothing sends. The confirmation goes as text
    // built from src/content/whatsapp-updates.ts instead.
    expect(template('circle_linked', { circle_id: CIRCLE })).toBeNull();
  });

  it('circle_unlinked → circle_unlink whose button deep-links to /manage', () => {
    const t = template('circle_unlinked', { circle_id: CIRCLE })!;
    expect(t.name).toBe('circle_unlink');
    expect(bodyParams(t)).toEqual(['Bamenda Savers']);
    expect(buttonParam(t)).toBe(`${CIRCLE}/manage`);
  });

  it('member_joined → member_joins with circle, name, short address', () => {
    const t = template('member_joined', { circle_id: CIRCLE, member: MEMBER }, {
      memberName: 'Aminata',
    })!;
    expect(t.name).toBe('member_joins');
    expect(bodyParams(t)).toEqual(['Bamenda Savers', 'Aminata', shortAddress(MEMBER)]);
    expect(buttonParam(t)).toBe(CIRCLE);
  });

  it('member_joined falls back to "New Member" without a resolved name', () => {
    const t = template('member_joined', { circle_id: CIRCLE, member: MEMBER })!;
    expect(bodyParams(t)[1]).toBe('New Member');
  });

  it('member_removed → member_removed with name, address, circle, date', () => {
    const t = template('member_removed', {
      circle_id: CIRCLE,
      member: MEMBER,
      deposit_returned: true,
    })!;
    expect(t.name).toBe('member_removed');
    const params = bodyParams(t);
    expect(params).toHaveLength(4);
    expect(params[0]).toBe('Member'); // no memberName override
    expect(params[1]).toBe(shortAddress(MEMBER));
    expect(params[2]).toBe('Bamenda Savers');
    expect(params[3]).not.toHaveLength(0); // send-time date
    expect(buttonParam(t)).toBe(CIRCLE);
  });

  it('deposit_returned → deposit_returned only when the amount parsed', () => {
    const t = template('deposit_returned', {
      circle_id: CIRCLE,
      member: MEMBER,
      amount: '1000000000',
      coin_type: '0x2::sui::SUI',
    })!;
    expect(t.name).toBe('deposit_returned');
    const params = bodyParams(t);
    expect(params[0]).toBe('Bamenda Savers');
    expect(params[1]).toBe('1.0000 SUI');
    expect(params).toHaveLength(3);
    expect(buttonParam(t)).toBe(CIRCLE);

    // Unparseable amount → no template (keep the freeform fallback).
    expect(
      template('deposit_returned', { circle_id: CIRCLE, member: MEMBER, amount: 'x' }),
    ).toBeNull();
  });

  it('rotation_changed → order_changed only when the member count is present', () => {
    const t = template('rotation_changed', { circle_id: CIRCLE, member_count: '7' })!;
    expect(t.name).toBe('order_changed');
    expect(bodyParams(t)[0]).toBe('Bamenda Savers');
    expect(bodyParams(t)[1]).toBe('7');
    expect(bodyParams(t)).toHaveLength(3);
    expect(buttonParam(t)).toBe(CIRCLE);

    // No member_count on the event → keep the freeform fallback.
    expect(template('rotation_changed', { circle_id: CIRCLE })).toBeNull();
  });

  it('claim_redeemed → payout_processed (the payout has been sent)', () => {
    const t = template(
      'claim_redeemed',
      { escrow_id: ESCROW, cycle_no: '5', recipient: RECIPIENT, amount: '200000' },
      { memberName: 'Aminata' },
      USDC_ESCROW,
    )!;
    expect(t.name).toBe('payout_processed');
    expect(t.language).toBe('en');
    const params = bodyParams(t);
    expect(params).toHaveLength(5);
    expect(params[0]).toBe('Bamenda Savers');
    expect(params[1]).toBe('14');
    expect(params[2]).toBe('Aminata');
    expect(params[3]).toBe('0.20 USDC');
    expect(params[4]).not.toHaveLength(0); // send-time date with weekday
    // The button deep-links to the escrow's circle, never the escrow.
    expect(buttonParam(t)).toBe(CIRCLE);
  });

  it('claim_redeemed falls back to the short address without a resolved name', () => {
    const t = template(
      'claim_redeemed',
      { escrow_id: ESCROW, cycle_no: '5', recipient: RECIPIENT, amount: '200000' },
      {},
      USDC_ESCROW,
    )!;
    expect(bodyParams(t)[2]).toBe(shortAddress(RECIPIENT));
  });

  it('claim_redeemed keeps the text fallback when the amount or round is missing', () => {
    // An approved positional layout cannot carry an empty {{2}} or {{4}}.
    const event = { escrow_id: ESCROW, cycle_no: '5', recipient: RECIPIENT, amount: '200000' };
    expect(
      template('claim_redeemed', event, {}, { ...USDC_ESCROW, coinType: '0xbeef::wrapped::WETH' }),
    ).toBeNull();
    expect(
      template('claim_redeemed', { ...event, cycle_no: undefined }, {}, USDC_ESCROW),
    ).toBeNull();
    // A round that cannot be numbered is missing too: never the lap.
    expect(template('claim_redeemed', event, {}, { ...USDC_ESCROW, members: null })).toBeNull();
  });

  it('keeps aggregate-heavy streams on the freeform text fallback (no template)', () => {
    // deposit_received / recieve_contribution / live_circle are not on the
    // notifier's approved reuse list (their layouts need aggregates or
    // schedules) — these streams must NOT define buildTemplate.
    const textOnly: Array<[string, unknown, EscrowSubject?]> = [
      ['security_deposit', { circle_id: CIRCLE, member: MEMBER, amount: '5', operation_type: 3 }],
      [
        'contribution_recorded',
        { escrow_id: ESCROW, cycle_no: '5', contributor: MEMBER, amount: '100000', contributors_so_far: '1' },
        USDC_ESCROW,
      ],
      ['circle_activated', { circle_id: CIRCLE }],
    ];
    for (const [name, payload, escrow] of textOnly) {
      const parsed = stream(name).parse(payload, escrow);
      expect(parsed).not.toBeNull();
      expect(parsed!.buildTemplate).toBeUndefined();
    }
  });
});

describe('keys', () => {
  it('builds stable dedupe and cursor keys', () => {
    expect(circleEventDedupeKey('contribution_recorded', 'tx1', '0')).toBe(
      'contribution_recorded:tx1:0',
    );
    expect(circleEventCursorKey('contribution_recorded', PKG, 'testnet')).toBe(
      `whatsapp-events:contribution_recorded:${PKG}:testnet`,
    );
  });

  it('gives the escrow-rail streams cursor rows the legacy streams never wrote', () => {
    // The escrow events share the legacy events' DEFINING package (both
    // exist since v1), so only the stream name keeps a cursor paged over
    // ContributionMade/PayoutProcessed from being resumed against the
    // escrow events. The legacy names must never be reused.
    const retired = ['contribution', 'contribution_stablecoin', 'payout_processed'];
    const liveKeys = CIRCLE_EVENT_STREAMS.map((s) => circleEventCursorKey(s.name, PKG, 'testnet'));
    for (const name of retired) {
      expect(liveKeys).not.toContain(circleEventCursorKey(name, PKG, 'testnet'));
    }
  });
});
