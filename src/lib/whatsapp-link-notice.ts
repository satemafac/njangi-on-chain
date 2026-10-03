/**
 * What the round panel (CycleEscrowPanel) tells its viewer about the circle's
 * WhatsApp link.
 *
 * Only the circle admin is told anything. Every WhatsApp send goes to a number
 * a circle admin linked:
 *
 *   - circle updates (CIRCLE_EVENT_STREAMS in src/lib/whatsapp-bot/
 *     circle-events.ts) go to the one number linked to the circle
 *     (resolveCirclePhone in src/lib/whatsapp-bot/circle-phone.ts);
 *   - the "your turn" nudge (src/lib/your-turn-notification.ts) goes to a
 *     number the round's recipient linked themselves (resolveMemberPhone in
 *     src/lib/whatsapp-notifier.ts matches the link's `linked_by`);
 *
 * and only the circle admin can link one: whatsapp_integration::link_circle
 * aborts for anyone else. Nothing a member does changes what a member
 * receives. The panel used to tell every viewer of an unlinked circle to ask
 * the admin to link it "so you get round reminders, payout alerts, and KYC
 * confirmations". Nothing sends round reminders, payout updates wait on the
 * escrow event relay, and ramps (the only KYC confirmations) are off in
 * production. Even once linked, none of it would have reached the member.
 * Members now get no notice, and no probe request is made for them.
 *
 * The admin is told when linking would change something: no link at all, or a
 * group link, which nothing can message. WhatsApp lets a business number
 * message only groups it created itself, and every sender reads only a phone
 * number. The notice names no updates, so it stays true as streams are added
 * or repointed.
 */

import type { NetworkType } from '@/config/public-env';

export type WhatsAppLinkNotice = 'no-link' | 'group-link';

/** whatsapp_integration::LINK_TYPE_GROUP */
const GROUP_LINK_TYPE = 2;

interface LinkProbeBody {
  data?: { isLinked?: unknown; linkType?: unknown };
}

/**
 * The notice the panel should show, or null for none. Members get null
 * without a request. For the admin, a failed or malformed probe is also null:
 * no notice is better than a wrong one.
 */
export async function loadWhatsAppLinkNotice({
  circleId,
  network,
  isAdmin,
}: {
  circleId: string;
  network: NetworkType;
  isAdmin: boolean;
}): Promise<WhatsAppLinkNotice | null> {
  if (!isAdmin) return null;
  try {
    // The public link-existence probe: it never decrypts the linked number.
    const response = await fetch(
      `/api/whatsapp/admin-link-circle?circleId=${encodeURIComponent(circleId)}&network=${network}`,
    );
    if (!response.ok) return null;
    const link = ((await response.json()) as LinkProbeBody | null)?.data;
    if (typeof link?.isLinked !== 'boolean') return null;
    if (!link.isLinked) return 'no-link';
    return Number(link.linkType) === GROUP_LINK_TYPE ? 'group-link' : null;
  } catch {
    return null;
  }
}
