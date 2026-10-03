/**
 * The "Recipient" box on the manage page's WhatsApp card.
 *
 * It renders the server's mask ("+237 ••• ••• 1234") and never a raw number:
 * GET /api/whatsapp/admin-link-circle does not send one, and the status this
 * box reads has no field that could hold one (src/lib/whatsapp-link-status.ts).
 * When the mask is missing the box says why, instead of sitting empty.
 */

import React from 'react';
import type { RecipientGap, WhatsAppLinkStatus } from '@/lib/whatsapp-link-status';

const GAP_COPY: Record<RecipientGap, string> = {
  'sign-in': 'Sign in again to see which number is linked.',
  unavailable: "The linked number can't be shown right now.",
};

interface WhatsAppLinkedRecipientProps {
  status: WhatsAppLinkStatus;
}

const WhatsAppLinkedRecipient: React.FC<WhatsAppLinkedRecipientProps> = ({ status }) => {
  const { maskedRecipient, linkedAt, recipientGap } = status;

  // Nothing was asked for: this is not the admin's view.
  if (!maskedRecipient && !recipientGap) return null;

  return (
    <div className="rounded-[18px] border border-stone-200 bg-white p-3">
      <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">Recipient</p>
      {maskedRecipient ? (
        <p className="mt-2 text-lg font-semibold text-gray-900">{maskedRecipient}</p>
      ) : (
        <p className="mt-2 text-sm text-gray-600">{GAP_COPY[recipientGap ?? 'unavailable']}</p>
      )}
      {linkedAt && (
        <p className="mt-2 text-xs text-gray-500">
          Linked on: {new Date(linkedAt).toLocaleDateString()}
        </p>
      )}
    </div>
  );
};

export default WhatsAppLinkedRecipient;
