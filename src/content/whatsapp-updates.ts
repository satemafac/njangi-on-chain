// whatsapp-updates.ts — what the WhatsApp channel sends, as we describe it to
// users.
//
// Two places tell people what a linked number receives: the webhook's reply to
// "help" (src/pages/api/whatsapp/webhook.ts) and the linked-number card on the
// circle's manage page (src/components/WhatsAppCircleIntegration.tsx). Both
// used to promise messages nothing sends: deadline reminders, a "cycle
// started" note for every round, and (in the help reply) circle insights. Both
// also promised contribution and payout updates, whose streams listen for
// events no live circle emits. Both now render the lists below.
//
// RULE: list only what something sends today. Each circle update names the
// CIRCLE_EVENT_STREAMS entries that send it (src/lib/whatsapp-bot/
// circle-events.ts). src/content/__tests__/whatsapp-updates.test.ts fails if a
// name is not a stream, or if the stream listens for a retired payment-rail
// event. Contributions and payouts can be added once their streams listen for
// the escrow's events.
//
// COPY RULES: src/content is in check:copy's SCAN_DIRS, so the guard scans
// this file. It skips the webhook route, like everything under src/pages/api.

export interface CircleUpdate {
  /** One line, shown as a bullet in the help reply and on the manage page. */
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
    text: 'Security deposits paid or returned',
    streams: ['security_deposit', 'deposit_returned'],
  },
  { text: 'Changes to the payout order', streams: ['rotation_changed'] },
  { text: 'The circle going live', streams: ['circle_activated'] },
];

/**
 * The "your turn" nudge (src/lib/your-turn-notification.ts), which
 * /api/cron/cycle-finalized sends to the number the round's recipient linked.
 * The wording promises no advance notice: the app finalizes a round inside
 * the recipient's own collect transaction, so the nudge usually arrives after
 * the payout is collected.
 */
export const YOUR_TURN_UPDATE = '"It\'s your turn" for each round you collect';

export const WHATSAPP_UPDATE_LINES: readonly string[] = [
  ...CIRCLE_UPDATES.map((update) => update.text),
  YOUR_TURN_UPDATE,
];

export const WHATSAPP_HELP_REPLY = [
  '✅ *Njangi WhatsApp Channel*',
  '',
  'This is a notification-only channel. A number linked to a circle gets:',
  '',
  ...WHATSAPP_UPDATE_LINES.map((line) => `• ${line}`),
  '',
  '*Available Commands:*',
  '/status <circle-id> - Get live circle status from blockchain',
  '/help - Show this message',
  '',
  '*Example:*',
  '/status 0x1639fcff0c0f7a48ba0a1aa9f727985f1c9360d399bd8210dc99f26c07237d8e',
].join('\n');
