/**
 * The round panel's WhatsApp notice is for the circle admin only.
 *
 * CycleEscrowPanel told every viewer of an unlinked circle: "Ask your admin to
 * link it on the manage page so you get round reminders, payout alerts, and
 * KYC confirmations on WhatsApp." None of that reaches a member. Circle updates
 * go to the one number linked to the circle, the "your turn" nudge goes only
 * to a number the recipient linked as an admin, and only the circle admin can
 * link. Nothing sends round reminders at all.
 *
 * loadWhatsAppLinkNotice is tested directly. The panel's copy is checked as
 * source text, like src/lib/__tests__/copy-guards.test.ts: jest runs in `node`
 * and matches only `.test.ts`, so it cannot render the .tsx.
 */
import { readFileSync } from 'fs';
import path from 'path';
import { loadWhatsAppLinkNotice } from '@/lib/whatsapp-link-notice';

const CIRCLE = `0x${'c1'.repeat(32)}`;

const UNLINKED = { success: true, data: { isLinked: false, message: 'Circle not linked' } };
const PHONE_LINK = { success: true, data: { isLinked: true, linkType: 1 } };
const GROUP_LINK = { success: true, data: { isLinked: true, linkType: 2 } };

const ORIGINAL_FETCH = global.fetch;

function mockProbe(response: { ok?: boolean; body?: unknown } | Error): jest.Mock {
  const fetchMock =
    response instanceof Error
      ? jest.fn().mockRejectedValue(response)
      : jest.fn().mockResolvedValue({
          ok: response.ok ?? true,
          json: async () => response.body,
        });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
});

describe('loadWhatsAppLinkNotice', () => {
  it.each([
    ['an unlinked', UNLINKED],
    ['a group-linked', GROUP_LINK],
  ])('gives a member of %s circle no notice and makes no request', async (_label, body) => {
    const fetchMock = mockProbe({ body });

    await expect(
      loadWhatsAppLinkNotice({ circleId: CIRCLE, network: 'testnet', isAdmin: false }),
    ).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('tells the admin when no number is linked', async () => {
    const fetchMock = mockProbe({ body: UNLINKED });

    await expect(
      loadWhatsAppLinkNotice({ circleId: CIRCLE, network: 'testnet', isAdmin: true }),
    ).resolves.toBe('no-link');
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/whatsapp/admin-link-circle?circleId=${encodeURIComponent(CIRCLE)}&network=testnet`,
    );
  });

  it('tells the admin when the link is a group, which nothing can message', async () => {
    mockProbe({ body: GROUP_LINK });
    await expect(
      loadWhatsAppLinkNotice({ circleId: CIRCLE, network: 'testnet', isAdmin: true }),
    ).resolves.toBe('group-link');

    // The route sends a number today; a stringified one must still read as a group.
    mockProbe({ body: { success: true, data: { isLinked: true, linkType: '2' } } });
    await expect(
      loadWhatsAppLinkNotice({ circleId: CIRCLE, network: 'testnet', isAdmin: true }),
    ).resolves.toBe('group-link');
  });

  it('gives the admin no notice when a phone number is linked', async () => {
    mockProbe({ body: PHONE_LINK });

    await expect(
      loadWhatsAppLinkNotice({ circleId: CIRCLE, network: 'testnet', isAdmin: true }),
    ).resolves.toBeNull();
  });

  it.each([
    ['an error status', { ok: false, body: { success: false, error: 'boom' } }],
    ['a body without data', { body: { success: true } }],
    ['a body without isLinked', { body: { success: true, data: { linkType: 1 } } }],
    ['a null body', { body: null }],
    ['a network error', new Error('offline')],
  ])('shows nothing when the probe returns %s', async (_label, response) => {
    mockProbe(response);

    await expect(
      loadWhatsAppLinkNotice({ circleId: CIRCLE, network: 'testnet', isAdmin: true }),
    ).resolves.toBeNull();
  });
});

describe('CycleEscrowPanel WhatsApp notice', () => {
  const read = (rel: string) => readFileSync(path.resolve(__dirname, '../..', rel), 'utf8');

  /** Comments explain the rule; they must not trip it. */
  const stripComments = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  const panel = stripComments(read('components/CycleEscrowPanel.tsx'));

  /** The JSX the notice renders, from its condition to its `: null`. */
  const noticeBlock = (): string => {
    const start = panel.indexOf('{whatsAppNotice ? (');
    expect(start).toBeGreaterThan(-1);
    return panel.slice(start, panel.indexOf(') : null}', start));
  };

  it('probes only through the admin-gated loader', () => {
    // A direct fetch here would bypass the isAdmin check in the loader.
    expect(panel).not.toContain('/api/whatsapp/admin-link-circle');
    expect(panel).toMatch(/loadWhatsAppLinkNotice\(\{[^}]*\bisAdmin\b(?!\s*:)[^}]*\}\)/);
  });

  it('tells no one to ask the admin for updates that never reach them', () => {
    expect(panel).not.toMatch(/ask (?:your|the) admin/i);
    expect(panel).not.toMatch(/round reminders|payout alerts|KYC confirmations/i);
  });

  it('names no WhatsApp update, and says where the admin links a number', () => {
    // What a linked number gets changes as streams are fixed (contribution and
    // payout updates wait on the escrow event relay). The manage page's
    // WhatsApp section shows that list; the notice only sends the admin there.
    const notice = noticeBlock();

    expect(notice).not.toMatch(/remind|deadline|contribut|payout|KYC|insight/i);
    expect(notice).toContain('WhatsApp section of the manage page');
  });
});
