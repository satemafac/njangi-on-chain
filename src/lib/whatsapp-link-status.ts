// whatsapp-link-status.ts — how the manage page's WhatsApp card reads a
// circle's link status from GET /api/whatsapp/admin-link-circle.
//
// The admin view asks for `includeRecipient=true`. The route answers that
// only for a session it can prove is the on-chain circle admin, and even then
// it sends a mask ("+237 ••• ••• 1234") and the link date, never the number.
// When the route refuses (401: no zkLogin session; 403: a session for another
// address) or the request fails, the card falls back to the public
// link-existence probe, so it still shows whether the circle is linked.

const STATUS_PATH = '/api/whatsapp/admin-link-circle';

/**
 * Why a linked card shows no number:
 * - 'sign-in': the route refused the admin read (401/403);
 * - 'unavailable': the admin read failed, or the number could not be opened.
 * Unset when the number is shown, and when it was never asked for.
 */
export type RecipientGap = 'sign-in' | 'unavailable';

export interface WhatsAppLinkStatus {
  isLinked: boolean;
  /** 1 = phone number, 2 = WhatsApp group. */
  linkType?: 1 | 2;
  /** Masked by the server, e.g. "+237 ••• ••• 1234". */
  maskedRecipient?: string;
  /** When the link was made (ISO 8601). Admin read only. */
  linkedAt?: string;
  recipientGap?: RecipientGap;
}

export interface FetchWhatsAppLinkStatusParams {
  circleId: string;
  network: string;
  /** True only in the circle admin's own view (the manage page). */
  includeRecipient: boolean;
}

function statusUrl(circleId: string, network: string, includeRecipient: boolean): string {
  const query = new URLSearchParams({ circleId, network });
  if (includeRecipient) query.set('includeRecipient', 'true');
  return `${STATUS_PATH}?${query.toString()}`;
}

/**
 * Keeps the fields the card renders and drops everything else. Only the
 * masked number is read, so a full number in a response (a server from
 * before the mask, mid-deploy) never reaches the card.
 */
function readStatus(body: unknown): WhatsAppLinkStatus {
  const data = (body as { data?: Record<string, unknown> } | null | undefined)?.data;
  // A reply without a boolean isLinked is not an answer. Throw, so a failed
  // admin read falls back to the probe and a failed probe reads as unknown,
  // never as "not linked".
  if (!data || typeof data.isLinked !== 'boolean') {
    throw new Error('WhatsApp link status reply has no isLinked flag');
  }
  if (!data.isLinked) return { isLinked: false };

  const status: WhatsAppLinkStatus = { isLinked: true };
  if (data.linkType === 1 || data.linkType === 2) status.linkType = data.linkType;
  if (typeof data.maskedRecipient === 'string' && data.maskedRecipient !== '') {
    status.maskedRecipient = data.maskedRecipient;
  }
  if (typeof data.linkedAt === 'string' && Number.isFinite(Date.parse(data.linkedAt))) {
    status.linkedAt = data.linkedAt;
  }
  return status;
}

/**
 * Reads a circle's WhatsApp link status for the manage page's card.
 *
 * A refused, failed or malformed admin read never throws: it falls back to the
 * public probe and records why the number is missing. Only a failed probe, or
 * a probe reply without a boolean isLinked, throws, so the caller keeps
 * deciding what an unknown status shows.
 */
export async function fetchWhatsAppLinkStatus(
  { circleId, network, includeRecipient }: FetchWhatsAppLinkStatusParams,
  fetchImpl: typeof fetch = fetch,
): Promise<WhatsAppLinkStatus> {
  let recipientGap: RecipientGap | undefined;

  if (includeRecipient) {
    try {
      const response = await fetchImpl(statusUrl(circleId, network, true));
      if (response.ok) {
        const status = readStatus(await response.json());
        if (status.isLinked && !status.maskedRecipient) status.recipientGap = 'unavailable';
        return status;
      }
      recipientGap =
        response.status === 401 || response.status === 403 ? 'sign-in' : 'unavailable';
    } catch {
      recipientGap = 'unavailable';
    }
  }

  const response = await fetchImpl(statusUrl(circleId, network, false));
  if (!response.ok) {
    throw new Error(`WhatsApp link status request failed (${response.status})`);
  }
  const status = readStatus(await response.json());
  if (status.isLinked && recipientGap) status.recipientGap = recipientGap;
  return status;
}
