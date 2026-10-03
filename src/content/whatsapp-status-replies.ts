// whatsapp-status-replies.ts — what the webhook answers to a bare "/status"
// when it has no circle status to send (src/pages/api/whatsapp/webhook.ts).
//
// Two different answers, on purpose. NO_LINKED_CIRCLES_REPLY is a fact, sent
// only when every lookup behind it answered. When the link index, the
// on-chain registry or a Walrus read failed, the sender may well have a
// linked circle: LINKED_CIRCLES_UNCHECKED_REPLY says the check did not
// happen, instead of telling a linked member they have none.
//
// COPY RULES: src/content is in check:copy's SCAN_DIRS, so the guard scans
// this file. It skips the webhook route, like everything under src/pages/api.

export const NO_LINKED_CIRCLES_REPLY = [
  '❌ No circles linked to your number.',
  '',
  'Please link a circle via the Njangi app first.',
  '',
  'Or use: /status <circle-id>',
].join('\n');

export const LINKED_CIRCLES_UNCHECKED_REPLY = [
  "⏳ We couldn't look up your linked circles right now.",
  '',
  'Please try again in a few minutes.',
  '',
  'Or use: /status <circle-id>',
].join('\n');
