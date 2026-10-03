/**
 * The WhatsApp channel may advertise only what something sends.
 *
 * The help reply promised "Deadline reminders" and "Circle insights", which
 * nothing sends, plus contribution and payout updates whose streams listen
 * for events no live circle emits. The manage page's card promised deadline
 * reminders, contributions and payouts too. Both now render
 * src/content/whatsapp-updates.ts, and every circle update there names the
 * CIRCLE_EVENT_STREAMS entries that send it.
 *
 * The component checks are source-text assertions, like
 * src/lib/__tests__/copy-guards.test.ts: jest runs in `node` and matches only
 * `.test.ts`, so it cannot render the .tsx.
 */
import { readFileSync } from 'fs';
import path from 'path';
import {
  CIRCLE_UPDATES,
  WHATSAPP_HELP_REPLY,
  WHATSAPP_UPDATE_LINES,
  YOUR_TURN_UPDATE,
} from '@/content/whatsapp-updates';
import { CIRCLE_EVENT_STREAMS } from '@/lib/whatsapp-bot/circle-events';

// Events of the retired payment rail. Circles on the per-round escrow never
// emit them (none had fired on the testnet lineage as of 2026-10-02), so a
// stream that listens for one sends nothing.
const RETIRED_RAIL_EVENTS = [
  '::njangi_payments::ContributionMade',
  '::njangi_circles::StablecoinContributionMade',
  '::njangi_payments::PayoutProcessed',
];

const read = (rel: string) => readFileSync(path.resolve(__dirname, '../..', rel), 'utf8');

/** Comments explain the rule; they must not trip it. */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('WhatsApp update copy', () => {
  const streamsByName = new Map(CIRCLE_EVENT_STREAMS.map((stream) => [stream.name, stream]));

  it('backs every circle update with streams that exist', () => {
    for (const update of CIRCLE_UPDATES) {
      expect(update.streams.length).toBeGreaterThan(0);
      for (const name of update.streams) {
        expect([...streamsByName.keys()]).toContain(name);
      }
    }
  });

  it('advertises no stream that listens for a retired payment-rail event', () => {
    for (const update of CIRCLE_UPDATES) {
      for (const name of update.streams) {
        const eventType = streamsByName.get(name)?.eventType('0xpkg') ?? '';
        expect(RETIRED_RAIL_EVENTS.filter((event) => eventType.endsWith(event))).toEqual([]);
      }
    }
  });

  it('builds the help reply bullets from those lines and nothing else', () => {
    const bullets = WHATSAPP_HELP_REPLY.split('\n').filter((line) => line.startsWith('• '));

    expect(bullets).toEqual(WHATSAPP_UPDATE_LINES.map((line) => `• ${line}`));
    expect(WHATSAPP_UPDATE_LINES).toContain(YOUR_TURN_UPDATE);
    expect(WHATSAPP_HELP_REPLY).not.toMatch(/deadline|insight/i);
  });
});

describe('WhatsApp link form', () => {
  const component = stripComments(read('components/WhatsAppCircleIntegration.tsx'));

  it('lists the shared updates instead of its own', () => {
    expect(component).toContain('WHATSAPP_UPDATE_LINES.map');
    expect(component).not.toMatch(/Deadline reminders|Member contributions|New cycle started/);
  });

  it('offers no group option', () => {
    // A Cloud API number can message only groups it created through Meta's
    // Groups API, never a group id copied from the WhatsApp app.
    expect(component).not.toContain('@g.us');
    expect(component).not.toMatch(/<option[^>]*>[^<]*Group/);
    expect(component).toContain('linkType: PHONE_LINK_TYPE');
  });
});
