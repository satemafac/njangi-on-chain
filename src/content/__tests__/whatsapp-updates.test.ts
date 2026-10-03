/**
 * The WhatsApp channel may advertise only what something sends.
 *
 * The help reply promised "Deadline reminders" and "Circle insights", which
 * nothing sends, plus contribution and payout updates whose streams listened
 * for events no live circle emits. The manage page's card promised deadline
 * reminders, contributions and payouts too. The link confirmation (the
 * circle_linked stream) promised contribution and payout updates before
 * anything relayed them, and its approved template still lists cycle
 * deadlines. All three now render src/content/whatsapp-updates.ts, and every
 * circle update there names the CIRCLE_EVENT_STREAMS entries that send it.
 *
 * Deposit returns: a stop-and-refund (njangi_circles::execute_recovery /
 * trigger_auto_release) returns security deposits but emits only
 * RecoveryMemberRefunded, which no stream relays. "Security deposits paid or
 * returned" promised a message for it, so WhatsApp copy may promise a return
 * only when an admin removes a member: admin_remove_member emits
 * SecurityDepositReturned, which the deposit_returned stream relays.
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
  buildLinkConfirmation,
} from '@/content/whatsapp-updates';
import { DICTIONARIES } from '@/lib/i18n';
import {
  CIRCLE_EVENT_STREAMS,
  type CircleEventMessageContext,
} from '@/lib/whatsapp-bot/circle-events';

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

const CIRCLE = '0x' + 'c1'.repeat(32);
const CTX: CircleEventMessageContext = {
  circleName: 'Bamenda Savers',
  memberName: null,
  resolvedCoinType: null,
  appBaseUrl: 'https://njangionchain.com',
};

/** What the circle_linked stream makes of a link to CIRCLE. */
function parsedLinkEvent() {
  const parsed = CIRCLE_EVENT_STREAMS.find((s) => s.name === 'circle_linked')?.parse({
    circle_id: CIRCLE,
  });
  if (!parsed) throw new Error('circle_linked rejected its fixture payload');
  return parsed;
}

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

  it('advertises every stream the circle-events cron sends', () => {
    // A stream no line names is a message the lists leave out.
    const advertised = new Set(CIRCLE_UPDATES.flatMap((update) => update.streams));
    expect([...streamsByName.keys()].filter((name) => !advertised.has(name))).toEqual([]);
  });

  it('builds the help reply bullets from those lines and nothing else', () => {
    const bullets = WHATSAPP_HELP_REPLY.split('\n').filter((line) => line.startsWith('• '));

    expect(bullets).toEqual(WHATSAPP_UPDATE_LINES.map((line) => `• ${line}`));
    expect(WHATSAPP_UPDATE_LINES).toContain(YOUR_TURN_UPDATE);
    expect(WHATSAPP_HELP_REPLY).not.toMatch(/deadline|insight/i);
  });
});

describe('WhatsApp link confirmation', () => {
  const body = parsedLinkEvent().buildBody(CTX);
  const lines = body.split('\n');

  it('lists exactly the lines the help reply lists', () => {
    expect(lines.filter((line) => line.startsWith('• '))).toEqual(
      WHATSAPP_UPDATE_LINES.map((line) => `• ${line}`),
    );
    expect(body).toBe(
      buildLinkConfirmation(CTX.circleName, `https://njangionchain.com/circle/${CIRCLE}`),
    );
  });

  it('promises nothing besides those lines', () => {
    // The rest is the heading, the "now linked" sentence and the circle link.
    const rest = lines.filter((line) => !line.startsWith('• '));
    expect(
      rest.filter((line) =>
        /receive|update|contribution|payout|deadline|remind|alert|insight/i.test(line),
      ),
    ).toEqual([]);
  });

  it('sends no template while the approved circle_link body over-promises', () => {
    // WHATSAPP_TEMPLATES.md: the approved body lists cycle deadlines and
    // "important alerts". Wire a template again only once Meta approves a
    // body that names no updates, and change this test with it.
    expect(parsedLinkEvent().buildTemplate?.(CTX) ?? null).toBeNull();
  });
});

describe('WhatsApp copy on deposit returns', () => {
  // Wording that promises a deposit coming back, in EN or FR, either order.
  const DEPOSIT_RETURN =
    /\bdeposits?\b.*\b(?:return|refund|given back|sent back|paid back)|\b(?:return|refund)\w*\b.*\bdeposits?\b|\bd[ée]p[ôo]ts?\b.*(?:restitu|rembours|rendu)|(?:restitu|rembours)\S*.*\bd[ée]p[ôo]ts?\b/i;
  // The one return that is sent: an admin removing a member.
  const ON_ADMIN_REMOVAL =
    /\bwhen (?:the|an) admin removes\b|\bon removal\b|\bquand l['’]administrat(?:eur|rice) retire\b/i;
  const STOP_AND_REFUND_EVENT = '::njangi_circles::RecoveryMemberRefunded';

  const unsentReturnPromises = (text: string): string[] =>
    text.split('\n').filter((line) => DEPOSIT_RETURN.test(line) && !ON_ADMIN_REMOVAL.test(line));

  // The help reply, the link confirmation (the card renders the same lines),
  // and every locale's strings about WhatsApp: pricing and the Premium upsell.
  const copy: Array<[string, string]> = [
    ['help reply', WHATSAPP_HELP_REPLY],
    ['link confirmation', parsedLinkEvent().buildBody(CTX)],
    ...Object.entries(DICTIONARIES).flatMap(([locale, dict]) =>
      Object.entries(dict)
        .filter(([key, text]) => /whatsapp/i.test(key) || /whatsapp/i.test(text))
        .map(([key, text]): [string, string] => [`${locale} ${key}`, text]),
    ),
  ];

  it('no stream relays a stop-and-refund yet', () => {
    // Once one relays RecoveryMemberRefunded, every return is sent: broaden
    // the deposit line in whatsapp-updates.ts and drop the qualifier check.
    const eventTypes = CIRCLE_EVENT_STREAMS.map((stream) => stream.eventType('0xpkg'));
    expect(eventTypes.filter((type) => type.endsWith(STOP_AND_REFUND_EVENT))).toEqual([]);
  });

  it.each(copy)('%s promises a deposit return only when an admin removes a member', (_where, text) => {
    expect(unsentReturnPromises(text)).toEqual([]);
  });

  it('covers copy that mentions deposit returns, in EN and FR', () => {
    // So the check above is not vacuous: each of these passes only because
    // it names the admin removal.
    const mentions = copy.filter(([, text]) => DEPOSIT_RETURN.test(text)).map(([where]) => where);
    expect(mentions).toEqual(
      expect.arrayContaining([
        'help reply',
        'link confirmation',
        'en billing.whatsappSuite.body',
        'fr billing.whatsappSuite.body',
      ]),
    );
  });

  it('rejects the copy it replaced', () => {
    const replaced = [
      '• Security deposits paid or returned',
      "Link a WhatsApp number to your circle, and that number gets the circle's updates: who joins or is removed, security deposits paid or returned, changes to the payout order, and the circle going live.",
      "Reliez un numéro WhatsApp à votre cercle, et ce numéro reçoit ses mises à jour : qui le rejoint ou en est retiré, les dépôts de garantie versés ou restitués, les changements de l'ordre des versements et le démarrage du cercle.",
    ];

    for (const text of replaced) {
      expect(unsentReturnPromises(text)).not.toEqual([]);
    }
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
