/**
 * The form of a phone number that the WhatsApp lookup index is keyed by.
 * indexWhatsAppLink and lookupCirclesForPhone (src/lib/whatsapp-link-index.ts)
 * store and query HMAC(WALRUS_LOOKUP_SALT, normalizePhone(number)), and the
 * GDPR deletion executor (scripts/process-deletion-request.mjs) must hash the
 * same string: a hash of any other form of the number matches no row, and
 * nothing reports the miss. Before this module existed, the executor hashed
 * `--phone` with its "+", so its deletes matched nothing.
 *
 * The app bundles this file, Node runs it directly for the script (type
 * stripping; the package.json next to it marks the folder as ESM, so Node
 * does not warn), and jest runs
 * src/__tests__/scripts/process-deletion-request.test.ts against it. Keep it
 * erasable TypeScript without imports: no enums, namespaces or parameter
 * properties.
 */

/**
 * The index form of a phone number or WhatsApp group id: no surrounding
 * whitespace, no leading "+". The link form sends E.164 ("+2376…") and Meta's
 * webhook sends the same digits without the "+", so both reach the same row.
 *
 * It trims both before and after removing the "+". The original order
 * (remove, then trim) kept the "+" of " +2376…", a hash no webhook lookup can
 * match. For every other input the two orders agree, so rows already in the
 * index keep their hashes.
 */
export function normalizePhone(value: string): string {
  return value.trim().replace(/^\+/, '').trim();
}

/**
 * The deletion executor's `--phone`, in the index form, or null when it is
 * not an international number: "+", then 7 to 15 digits that do not start
 * with 0 (E.164). Spaces, dots and hyphens are dropped, so a number copied
 * as "+237 6XX XX XX XX" works.
 *
 * Anything else is refused rather than guessed. A national number
 * ("6XX XX XX XX", "07700 …"), a "00" prefix or a "(0)" trunk digit hashes
 * to a value no row has, and an erasure that matches nothing looks the same
 * as one for a number that never linked a circle.
 */
export function phoneForErasure(input: string): string | null {
  const compact = input.replace(/[\s.-]/g, '');
  return /^\+[1-9]\d{6,14}$/.test(compact) ? normalizePhone(compact) : null;
}
