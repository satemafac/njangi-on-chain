// whatsapp-recipient-mask.ts — the only form in which a circle's linked
// WhatsApp number leaves the server.
//
// The manage page's WhatsApp card shows the admin which number the circle is
// linked to, so they can tell their own number from an old one. The number is
// Walrus-encrypted PII (src/lib/walrus-pii.ts). GET
// /api/whatsapp/admin-link-circle?includeRecipient=true decrypts it for the
// verified circle admin and returns only this mask, e.g. "+237 ••• ••• 1234".
// A HAR file, a browser extension or a stolen session cookie therefore gets
// the calling code and a few trailing digits at most, never the E.164.

// The same parser, with the same metadata, that validated the number in the
// card's link form (isValidPhoneNumber).
import { parsePhoneNumber } from 'react-phone-number-input';

/** Always the same, so the mask does not reveal how long the number is. */
const HIDDEN_DIGITS = '••• •••';

/** Trailing digits shown at most; the usual "ending in 1234". */
const MAX_SHOWN_DIGITS = 4;

/**
 * Masks an E.164 number for display: the calling code, a fixed run of
 * bullets, then the last digits of the national number. At most four digits
 * are shown, and never more than half of the national number, so a short
 * number (five digits in the Falklands, +500) is not all but spelled out.
 *
 * Returns null for anything that does not parse as a phone number (a group
 * id, an empty value). Callers then show that the number is unavailable;
 * they never fall back to the raw value.
 */
export function maskPhoneNumber(phoneE164: unknown): string | null {
  if (typeof phoneE164 !== 'string' || phoneE164.trim() === '') return null;

  let parsed: ReturnType<typeof parsePhoneNumber>;
  try {
    parsed = parsePhoneNumber(phoneE164.trim());
  } catch {
    return null;
  }
  if (!parsed) return null;

  const national = String(parsed.nationalNumber);
  const shown = Math.min(MAX_SHOWN_DIGITS, Math.floor(national.length / 2));
  if (shown < 1) return null;

  return `+${parsed.countryCallingCode} ${HIDDEN_DIGITS} ${national.slice(-shown)}`;
}
