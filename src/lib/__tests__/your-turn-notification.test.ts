/**
 * The "your turn" nudge body and send shape. The copy says the pot is full
 * and the payout is ready to collect, so it must state the payout exactly
 * or not at all, and it must not ride a template whose approved copy says
 * the payout was already sent (`payout_processed`).
 */

jest.mock('../whatsapp-notifier', () => ({
  sendMemberNotification: jest.fn(),
}));

import {
  buildYourTurnMessage,
  sendYourTurnNotification,
  type SupportedLocale,
} from '../your-turn-notification';
import { sendMemberNotification } from '../whatsapp-notifier';

const sendMemberMock = sendMemberNotification as jest.Mock;

const CIRCLE = '0xa3fada18d0d030f0f26e9a7ea77cd4f260a13649426a97bc9063c6f47de675ed';
const RECIPIENT = '0x1f8d4bdfa384503b0901c73c9925c5b29dad510766542a30dc3b6904ddba897b';
const LOCALES: SupportedLocale[] = ['en', 'fr', 'pcm', 'sw', 'am', 'ar', 'fa'];

describe('buildYourTurnMessage', () => {
  it('states the payout when it is known', () => {
    const body = buildYourTurnMessage('en', CIRCLE, 5, '0.2 USDC');
    expect(body).toContain('The pot for circle 0xa3fada… is full for round 5.');
    expect(body).toContain('Your payout of 0.2 USDC is ready to collect.');
  });

  it('leaves the figure out when it is not', () => {
    const body = buildYourTurnMessage('en', CIRCLE, 5, null);
    expect(body).toContain('Your payout is ready to collect.');
    expect(body).not.toContain(' of ');
  });

  it.each(LOCALES)('%s renders both variants without a stray placeholder', (locale) => {
    const withAmount = buildYourTurnMessage(locale, CIRCLE, 5, '0.2 USDC');
    const withoutAmount = buildYourTurnMessage(locale, CIRCLE, 5, null);
    expect(withAmount).toContain('0.2 USDC');
    expect(withoutAmount).not.toMatch(/null|undefined|USDC/);
    expect(withoutAmount).toContain('5');
    expect(withoutAmount).not.toBe(withAmount);
  });
});

describe('sendYourTurnNotification', () => {
  beforeEach(() => {
    sendMemberMock.mockReset().mockResolvedValue({ sent: true });
  });

  it('sends the freeform body with no template, under the round dedupe key', async () => {
    await sendYourTurnNotification({
      circleId: CIRCLE,
      cycleNo: 5,
      amount: '0.2 USDC',
      recipient: RECIPIENT,
      network: 'testnet',
      dedupeKey: '0xescrow:5',
    });

    expect(sendMemberMock).toHaveBeenCalledTimes(1);
    const input = sendMemberMock.mock.calls[0][0];
    expect(input).toMatchObject({
      memberAddress: RECIPIENT,
      body: buildYourTurnMessage('en', CIRCLE, 5, '0.2 USDC'),
      kind: 'cycle_finalized',
      network: 'testnet',
      dedupeKey: '0xescrow:5',
      dedupeWindowMs: 24 * 60 * 60 * 1000,
    });
    expect(input.template).toBeUndefined();
  });

  it('defaults the dedupe key to circle:round', async () => {
    await sendYourTurnNotification({
      circleId: CIRCLE,
      cycleNo: 5,
      amount: null,
      recipient: RECIPIENT,
      network: 'testnet',
    });

    expect(sendMemberMock.mock.calls[0][0].dedupeKey).toBe(`${CIRCLE}:5`);
  });
});
