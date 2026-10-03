// whatsapp-recipient-mask.test.ts — the manage page's WhatsApp card shows a
// circle's linked number only as this mask. GET
// /api/whatsapp/admin-link-circle masks before it responds, so whatever these
// tests let through is all a browser can ever see of the number.

import { maskPhoneNumber } from '../whatsapp-recipient-mask';

/** The digits the mask shows after the bullets. */
const shownDigits = (masked: string): string =>
  masked.slice(masked.lastIndexOf('•') + 1).replace(/\D/g, '');

describe('maskPhoneNumber', () => {
  it.each([
    ['+237650001234', '+237 ••• ••• 1234'], // Cameroon mobile
    ['+14155552671', '+1 ••• ••• 2671'], // United States
    ['+447911123456', '+44 ••• ••• 3456'], // United Kingdom
    ['+2348031234567', '+234 ••• ••• 4567'], // Nigeria
    ['+79161234567', '+7 ••• ••• 4567'], // Russia
  ])('masks %s as %s', (phone, masked) => {
    expect(maskPhoneNumber(phone)).toBe(masked);
  });

  it('tolerates spacing around and inside the number', () => {
    expect(maskPhoneNumber('  +237 6 50 00 12 34 ')).toBe('+237 ••• ••• 1234');
  });

  it('shows at most half of a short national number', () => {
    // Falklands numbers have five digits: four shown would hide only one.
    expect(maskPhoneNumber('+50051234')).toBe('+500 ••• ••• 34');
  });

  it.each(['+237650001234', '+14155552671', '+447911123456', '+50051234', '+4915123456789'])(
    'never shows more than four digits, or half the national number, of %s',
    (phone) => {
      const masked = maskPhoneNumber(phone);
      expect(masked).not.toBeNull();
      const callingCode = masked!.slice(1, masked!.indexOf(' '));
      const national = phone.slice(1 + callingCode.length);

      expect(masked).not.toContain(national);
      expect(shownDigits(masked!).length).toBeLessThanOrEqual(4);
      expect(shownDigits(masked!).length).toBeLessThanOrEqual(national.length / 2);
    },
  );

  it('does not reveal how long the number is', () => {
    // A Berlin landline (8 national digits) and a German mobile (11).
    const landline = maskPhoneNumber('+4930123456');
    const mobile = maskPhoneNumber('+4915123456789');

    expect(landline).toBe('+49 ••• ••• 3456');
    expect(mobile).toBe('+49 ••• ••• 6789');
    expect(landline!.length).toBe(mobile!.length);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a number', 237650001234],
    ['an empty string', ''],
    ['whitespace', '   '],
    ['text', 'not-a-phone'],
    ['a bare calling code', '+1'],
    ['a number without its +', '237650001234'],
    ['a WhatsApp group id', '120363043968066561@g.us'],
  ])('returns null for %s instead of echoing it', (_label, value) => {
    expect(maskPhoneNumber(value)).toBeNull();
  });
});
