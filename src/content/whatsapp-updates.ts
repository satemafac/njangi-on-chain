// whatsapp-updates.ts — what the WhatsApp channel sends, as we describe it to
// users.
//
// Three places tell people what a linked number receives: the webhook's reply
// to "help" (src/pages/api/whatsapp/webhook.ts), the linked-number card on the
// circle's manage page (src/components/WhatsAppCircleIntegration.tsx), and the
// confirmation sent when an admin links a circle (the circle_linked stream in
// src/lib/whatsapp-bot/circle-events.ts). They used to promise messages
// nothing sent: deadline reminders, a "cycle started" note for every round,
// circle insights and, before the escrow relays, contributions and payouts.
// All three now render the lists below, so a line added here reaches all three.
//
// RULE: list only what something sends today. Each circle update names the
// CIRCLE_EVENT_STREAMS entries that send it (src/lib/whatsapp-bot/
// circle-events.ts), and a line claims no more than those streams send.
// src/content/__tests__/whatsapp-updates.test.ts fails if a name is not a
// stream, if the stream listens for a retired payment-rail event, or if
// WhatsApp copy promises a deposit return that no stream relays.
//
// COPY RULES: src/content is in check:copy's SCAN_DIRS, so the guard scans
// this file. It skips the webhook route, like everything under src/pages/api.

export interface CircleUpdate {
  /** One line, shown as a bullet in the help reply, the link confirmation and on the manage page. */
  text: string;
  /** The CIRCLE_EVENT_STREAMS entries that send it to the circle's linked number. */
  streams: readonly string[];
}

export const CIRCLE_UPDATES: readonly CircleUpdate[] = [
  {
    text: 'A confirmation when a circle is linked or unlinked',
    streams: ['circle_linked', 'circle_unlinked'],
  },
  { text: 'Members joining or being removed', streams: ['member_joined', 'member_removed'] },
  {
    // Deposits also come back through a stop-and-refund
    // (njangi_circles::execute_recovery / trigger_auto_release), which emits
    // RecoveryMemberRefunded. No stream relays that event, so this line names
    // only the return that is sent: admin_remove_member's SecurityDepositReturned.
    text: 'Security deposits paid, and returned when the admin removes a member',
    streams: ['security_deposit', 'deposit_returned'],
  },
  // Every contribute* entrypoint of the round escrow emits ContributionRecorded.
  { text: 'Each contribution paid into a round', streams: ['contribution_recorded'] },
  // Both ways to collect (redeem_claim, finalize_and_redeem) emit ClaimRedeemed.
  { text: 'Each payout when its recipient collects it', streams: ['claim_redeemed'] },
  { text: 'Changes to the payout order', streams: ['rotation_changed'] },
  { text: 'The circle going live', streams: ['circle_activated'] },
];

/**
 * The "your turn" nudge (src/lib/your-turn-notification.ts), which
 * /api/cron/cycle-finalized sends to the number the round's recipient linked
 * once the contribution that fills the round's pot is recorded. The cron runs
 * every 15 minutes and drops the nudge if, by then, the recipient has
 * collected the payout or the round was refunded. So the line ties it to a
 * payout waiting to be collected instead of promising one for every round.
 */
export const YOUR_TURN_UPDATE = '"It\'s your turn" when your payout is ready to collect';

export const WHATSAPP_UPDATE_LINES: readonly string[] = [
  ...CIRCLE_UPDATES.map((update) => update.text),
  YOUR_TURN_UPDATE,
];

const UPDATE_BULLETS = WHATSAPP_UPDATE_LINES.map((line) => `• ${line}`);

export const WHATSAPP_HELP_REPLY = [
  '✅ *Njangi WhatsApp Channel*',
  '',
  'This is a notification-only channel. A number linked to a circle gets:',
  '',
  ...UPDATE_BULLETS,
  '',
  '*Available Commands:*',
  '/status <circle-id> - Get live circle status from blockchain',
  '/help - Show this message',
  '',
  '*Example:*',
  '/status 0x1639fcff0c0f7a48ba0a1aa9f727985f1c9360d399bd8210dc99f26c07237d8e',
].join('\n');

/**
 * The message the circle_linked stream sends to a number an admin just linked
 * (src/lib/whatsapp-bot/circle-events.ts). It lists the help reply's lines and
 * promises nothing else.
 */
export function buildLinkConfirmation(circleName: string, circleUrl: string): string {
  return [
    'Circle connected.',
    `${circleName} is now linked to this WhatsApp number. This number gets:`,
    ...UPDATE_BULLETS,
    `Open circle: ${circleUrl}`,
  ].join('\n');
}
