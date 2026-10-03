// whatsapp-link-status.test.ts — the manage page's WhatsApp card used to call
// the public link-existence probe only, so its "Recipient" box was always
// empty and "Linked on" never rendered. The admin view now asks for the
// masked number (includeRecipient=true); these tests pin that a refused or
// failed admin read still shows whether the circle is linked, and that only
// the server's mask ever reaches the card.

import { fetchWhatsAppLinkStatus } from '../whatsapp-link-status';

const CIRCLE_ID = '0x' + 'c3'.repeat(32);
const PHONE = '+237650001234';
const MASKED = '+237 ••• ••• 1234';
const LINKED_AT = '2026-09-30T10:15:00.000Z';

type Reply = { status: number; body?: unknown } | Error;

/**
 * A fetch that answers each call with the next reply and records the URLs.
 * An Error reply rejects, like a network failure.
 */
function fakeFetch(...replies: Reply[]) {
  const urls: string[] = [];
  const impl = jest.fn(async (input: RequestInfo | URL) => {
    urls.push(String(input));
    const reply = replies.shift();
    if (!reply) throw new Error('unexpected extra request');
    if (reply instanceof Error) throw reply;
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      json: async () => reply.body,
    } as Response;
  });
  return { impl: impl as unknown as typeof fetch, urls };
}

const linked = (data: Record<string, unknown> = {}) => ({
  status: 200,
  body: { success: true, data: { isLinked: true, linkType: 1, ...data } },
});

const params = (includeRecipient: boolean) => ({
  circleId: CIRCLE_ID,
  network: 'testnet',
  includeRecipient,
});

const query = (url: string) => new URLSearchParams(url.slice(url.indexOf('?') + 1));

describe('fetchWhatsAppLinkStatus in the admin view', () => {
  it('asks for the masked number and returns it with the link date', async () => {
    const { impl, urls } = fakeFetch(
      linked({ maskedRecipient: MASKED, linkedAt: LINKED_AT }),
    );

    const status = await fetchWhatsAppLinkStatus(params(true), impl);

    expect(status).toEqual({
      isLinked: true,
      linkType: 1,
      maskedRecipient: MASKED,
      linkedAt: LINKED_AT,
    });
    expect(urls).toHaveLength(1);
    expect(urls[0].startsWith('/api/whatsapp/admin-link-circle?')).toBe(true);
    expect(query(urls[0]).get('circleId')).toBe(CIRCLE_ID);
    expect(query(urls[0]).get('network')).toBe('testnet');
    expect(query(urls[0]).get('includeRecipient')).toBe('true');
  });

  it.each([401, 403])(
    'falls back to the link-existence probe on %i and says to sign in again',
    async (refusal) => {
      const { impl, urls } = fakeFetch(
        { status: refusal, body: { success: false, error: 'refused' } },
        linked(),
      );

      const status = await fetchWhatsAppLinkStatus(params(true), impl);

      expect(status).toEqual({ isLinked: true, linkType: 1, recipientGap: 'sign-in' });
      expect(urls).toHaveLength(2);
      expect(query(urls[1]).has('includeRecipient')).toBe(false);
    },
  );

  it('reports an unlinked circle from the probe after a refusal, with no gap', async () => {
    const { impl } = fakeFetch(
      { status: 401, body: { success: false } },
      { status: 200, body: { success: true, data: { isLinked: false } } },
    );

    await expect(fetchWhatsAppLinkStatus(params(true), impl)).resolves.toEqual({
      isLinked: false,
    });
  });

  it.each([
    ['a server error', { status: 500, body: { success: false } }],
    ['a network failure', new Error('network down')],
  ])('falls back to the probe after %s and marks the number unavailable', async (_label, reply) => {
    const { impl, urls } = fakeFetch(reply as Reply, linked());

    const status = await fetchWhatsAppLinkStatus(params(true), impl);

    expect(status).toEqual({ isLinked: true, linkType: 1, recipientGap: 'unavailable' });
    expect(urls).toHaveLength(2);
  });

  it('marks the number unavailable when the admin read could not open it', async () => {
    // e.g. every blob for the link failed to fetch or decrypt
    const { impl, urls } = fakeFetch(linked());

    const status = await fetchWhatsAppLinkStatus(params(true), impl);

    expect(status).toEqual({ isLinked: true, linkType: 1, recipientGap: 'unavailable' });
    expect(urls).toHaveLength(1);
  });

  it('never passes on a full number, even from a server that sent one', async () => {
    // A server from before the mask returned `recipient` in full.
    const { impl } = fakeFetch(linked({ recipient: PHONE, maskedRecipient: MASKED }));

    const status = await fetchWhatsAppLinkStatus(params(true), impl);

    expect(JSON.stringify(status)).not.toContain(PHONE);
    expect(JSON.stringify(status)).not.toContain('650001234');
    expect(status.maskedRecipient).toBe(MASKED);
  });

  it('drops a link date that is not a date', async () => {
    const { impl } = fakeFetch(linked({ maskedRecipient: MASKED, linkedAt: 'soon' }));

    const status = await fetchWhatsAppLinkStatus(params(true), impl);

    expect(status.linkedAt).toBeUndefined();
  });

  it('still throws when the probe itself fails, so the card keeps its own fallback', async () => {
    const { impl } = fakeFetch({ status: 403 }, { status: 500 });

    await expect(fetchWhatsAppLinkStatus(params(true), impl)).rejects.toThrow('(500)');
  });

  it('falls back to the probe when the admin reply has no isLinked flag', async () => {
    const { impl, urls } = fakeFetch({ status: 200, body: { success: true, data: {} } }, linked());

    const status = await fetchWhatsAppLinkStatus(params(true), impl);

    expect(status).toEqual({ isLinked: true, linkType: 1, recipientGap: 'unavailable' });
    expect(urls).toHaveLength(2);
  });
});

describe('fetchWhatsAppLinkStatus outside the admin view', () => {
  it('only probes for the link and never asks for the number', async () => {
    const { impl, urls } = fakeFetch(linked());

    const status = await fetchWhatsAppLinkStatus(params(false), impl);

    expect(status).toEqual({ isLinked: true, linkType: 1 });
    expect(urls).toHaveLength(1);
    expect(query(urls[0]).has('includeRecipient')).toBe(false);
  });

  it('throws when the probe fails', async () => {
    const { impl } = fakeFetch({ status: 500 });

    await expect(fetchWhatsAppLinkStatus(params(false), impl)).rejects.toThrow();
  });

  it.each([
    ['no data', { success: true }],
    ['no isLinked flag', { success: true, data: {} }],
    ['a non-boolean isLinked', { success: true, data: { isLinked: 'yes' } }],
    ['an empty body', null],
  ])('throws on a 200 reply with %s instead of reading it as not linked', async (_label, body) => {
    const { impl } = fakeFetch({ status: 200, body });

    await expect(fetchWhatsAppLinkStatus(params(false), impl)).rejects.toThrow(
      'no isLinked flag',
    );
  });
});
