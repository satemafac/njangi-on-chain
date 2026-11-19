/**
 * NJA-2813 — FAQ: the payout order answers omit that the admin can change it
 * while the circle is paused.
 *
 * src/pages/faq.tsx:72 ("How is the money actually held?") says the rotation
 * order "is set by the circle admin before the circle starts", and :77 ("How is
 * the payout order determined?") describes the order as arranged once. The Move
 * package says otherwise: move/sources/njangi_circles.move:1374-1388
 * set_rotation_position (and reorder_rotation_positions_internal at :1393)
 * accept the admin's change whenever `!circle.is_active || circle.paused_after_cycle`,
 * i.e. before the circle starts OR while it is paused between laps, and the
 * manage page already explains that guard's refusal
 * (ECircleNotPausedForConfigChange, src/pages/circle/[id]/manage/index.tsx:365).
 * Neither FAQ answer mentions a paused or inactive circle at all.
 *
 * Source-text assertion rather than a render test: jest runs
 * `testEnvironment: 'node'` and only collects `.test.ts`, so the page cannot be
 * mounted here (same technique as
 * src/__tests__/learn/what-is-njangi-penalty-copy.test.ts). The page is read by
 * relative path and readFileSync throws if it is missing or unreadable — a
 * failed read must not pass as "the answers say it". No network, RPC or wallet
 * is touched.
 */
import { readFileSync } from 'fs';
import path from 'path';

const PAGE = path.resolve(__dirname, '../../pages/faq.tsx');

/** The `answer: "..."` string of the FAQ item with this id. Throws if absent. */
function answerOf(source: string, id: string): string {
  const match = source.match(
    new RegExp(
      `id:\\s*"${id}",\\s*question:\\s*"[^"]*",\\s*answer:\\s*"((?:[^"\\\\]|\\\\.)*)"`,
    ),
  );
  if (!match) {
    throw new Error(`FAQ item "${id}" not found in src/pages/faq.tsx`);
  }
  return match[1].replace(/\\"/g, '"');
}

describe('FAQ payout order answers say when the admin can change the order (NJA-2813)', () => {
  const source = readFileSync(PAGE, 'utf8');
  const heldAnswer = answerOf(source, 'smart-contracts-work');
  const orderAnswer = answerOf(source, 'payout-order');

  it('is reading the two answers that describe the rotation order', () => {
    // Guards that the items still exist and talk about the order, so the
    // assertions below are about the right text and not vacuously true.
    expect(heldAnswer).toMatch(/rotation order/i);
    expect(orderAnswer).toMatch(/rotation order/i);
  });

  it('"How is the money actually held?" says the admin sets the order before the circle starts and can change it while the circle is paused or inactive, with every change recorded on chain', () => {
    // faq.tsx:72 — "set by the circle admin before the circle starts" only.
    expect(heldAnswer).toMatch(/before the circle starts/i);
    // Fails on this commit: no mention of the paused-between-laps window
    // that set_rotation_position / reorder_rotation_positions allow.
    expect(heldAnswer).toMatch(/paused/i);
    expect(heldAnswer).toMatch(/inactive|before the circle starts/i);
    expect(heldAnswer).toMatch(/recorded (as an on-chain event|on[- ]chain)/i);
  });

  it('"How is the payout order determined?" says the admin can change the order while the circle is paused between laps or inactive, with every change recorded on chain', () => {
    // faq.tsx:77 already says changes are recorded as on-chain events …
    expect(orderAnswer).toMatch(/recorded (as an on-chain event|on[- ]chain)/i);
    // … but never says when a change is allowed. Fails on this commit.
    expect(orderAnswer).toMatch(/paused/i);
    expect(orderAnswer).toMatch(/inactive|before the circle starts/i);
  });
});
