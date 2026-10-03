/**
 * Source guards for the linked number on the manage page's WhatsApp card.
 *
 * The card's "Recipient" box was always empty and "Linked on" never rendered:
 * the card called the public link-existence probe of
 * GET /api/whatsapp/admin-link-circle, which never decrypts anything. The
 * admin view now asks for `includeRecipient=true`; the route answers only a
 * session it can prove is the on-chain admin, and with a mask
 * ("+237 ••• ••• 1234") and the link date, never the number. A refusal
 * (401/403) falls back to the probe (src/lib/whatsapp-link-status.ts, unit
 * tested). These guards pin the wiring in the .tsx files: who asks, through
 * what, and what gets rendered or logged.
 *
 * Source-text assertions rather than render tests, as in
 * src/lib/__tests__/copy-guards.test.ts: jest runs `testEnvironment: 'node'`
 * and matches only `.test.ts`, so nothing can render a `.tsx` here.
 */
import { readFileSync } from 'fs';
import path from 'path';

const read = (rel: string) => readFileSync(path.resolve(__dirname, '..', rel), 'utf8');

/** Comments explain the rule; they must not trip it. */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** The argument lists of every console call, with string literals blanked. */
const consoleArguments = (source: string): string[] =>
  Array.from(source.matchAll(/console\.\w+\(([\s\S]*?)\);/g), ([, args]) =>
    args.replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, '""'),
  );

const card = stripComments(read('components/WhatsAppCircleIntegration.tsx'));
const box = stripComments(read('components/WhatsAppLinkedRecipient.tsx'));
const statusLib = stripComments(read('lib/whatsapp-link-status.ts'));
const managePage = stripComments(read('pages/circle/[id]/manage/index.tsx'));

describe('WhatsApp card: which number the circle is linked to', () => {
  it('reads link status only through fetchWhatsAppLinkStatus', () => {
    // An inline GET would bypass the 401/403 fallback to the probe.
    expect(card).toContain('fetchWhatsAppLinkStatus(');
    expect(card).not.toMatch(/admin-link-circle\?/);
    expect(card).not.toContain('includeRecipient=');
  });

  it('asks for the number only when the manage page says this is the admin', () => {
    expect(card).toMatch(/includeRecipient:\s*isAdmin\b/);
    expect(card).toMatch(/\bisAdmin\s*=\s*false\b/);
    expect(card).not.toMatch(/includeRecipient:\s*true\b/);

    const start = managePage.indexOf('<WhatsAppCircleIntegration');
    expect(start).toBeGreaterThan(-1);
    const element = managePage.slice(start, managePage.indexOf('/>', start));
    expect(element).toContain('isAdmin={Boolean(userAddress && circle.admin === userAddress)}');
  });

  it('renders the server mask and never a raw recipient', () => {
    expect(card).toContain('<WhatsAppLinkedRecipient status={linkedStatus} />');
    expect(box).toContain('{maskedRecipient}');

    for (const source of [card, box, statusLib]) {
      // `recipient` was the full number; `phone_e164` is the payload field.
      expect(source).not.toMatch(/\.recipient\b/);
      expect(source).not.toMatch(/\bphone_e164\b/);
    }
  });

  it('renders "Linked on" from the date the route returns', () => {
    expect(box).toMatch(/Linked on:\s*\{new Date\(linkedAt\)\.toLocaleDateString\(\)\}/);
  });

  it('says why the number is missing instead of leaving the box empty', () => {
    expect(box).toContain("'sign-in': 'Sign in again to see which number is linked.'");
    expect(box).toContain("unavailable: \"The linked number can't be shown right now.\"");
  });

  it('never logs the link status or a number', () => {
    // The status carries the masked number; phoneOrGroup is what the admin
    // typed (`phone` once group links are gone).
    const forbidden = /\b(?:linkedStatus|maskedRecipient|recipient|phoneOrGroup|phone)\b/;
    const cardLogs = consoleArguments(card);
    expect(cardLogs.length).toBeGreaterThan(0);
    for (const args of cardLogs) {
      expect(args).not.toMatch(forbidden);
    }

    expect(consoleArguments(box)).toEqual([]);
    expect(consoleArguments(statusLib)).toEqual([]);
  });
});
