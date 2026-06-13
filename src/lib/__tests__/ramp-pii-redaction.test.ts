// ramp-pii-redaction.test.ts — PII never reaches persisted onramp logs
// (2026-06 GTM audit): customer emails are masked to `e***@domain`, names,
// phones, DOB, postal addresses, and identity-document references are
// dropped, while reconciliation fields (ids, statuses, amounts, masked
// wallet addresses) and correlation ids are preserved.

import {
  maskEmailForLogs,
  recordOnrampEvent,
  redactSensitiveData,
} from '@/lib/onramp-logging';

describe('maskEmailForLogs', () => {
  it('masks the local part and keeps the domain', () => {
    expect(maskEmailForLogs('john.doe@gmail.com')).toBe('j***@gmail.com');
    expect(maskEmailForLogs('a@njangi.app')).toBe('a***@njangi.app');
  });

  it('fully masks values that do not look like an email', () => {
    expect(maskEmailForLogs('@gmail.com')).toBe('***');
    expect(maskEmailForLogs('not-an-email')).toBe('***');
    expect(maskEmailForLogs('trailing@')).toBe('***');
  });
});

describe('redactSensitiveData — ramp webhook PII', () => {
  it('masks email values regardless of the key they appear under', () => {
    const payload = {
      email: 'member@example.com',
      customer: { contact: 'cemac.user@yahoo.fr' },
    };

    expect(redactSensitiveData(payload)).toEqual({
      email: 'm***@example.com',
      customer: { contact: 'c***@yahoo.fr' },
    });
  });

  it('drops customer names, phones, DOB, postal address, and document references', () => {
    const payload = {
      firstName: 'Marie',
      lastName: 'Ngo',
      fullName: 'Marie Ngo',
      name: 'Marie Ngo',
      phoneNumber: '+237612345678',
      mobileNumber: '+237612345678',
      dateOfBirth: '1990-01-31',
      dob: '1990-01-31',
      passportNumber: 'AB1234567',
      address: '12 Rue de la Paix',
      addressLine1: '12 Rue de la Paix',
      city: 'Douala',
      postCode: '00237',
    };

    expect(redactSensitiveData(payload)).toEqual({
      firstName: '***',
      lastName: '***',
      fullName: '***',
      name: '***',
      phoneNumber: '***',
      mobileNumber: '***',
      dateOfBirth: '***',
      dob: '***',
      passportNumber: '***',
      address: '***',
      addressLine1: '***',
      city: '***',
      postCode: '***',
    });
  });

  it('keeps reconciliation fields and masks wallet addresses for correlation', () => {
    const payload = {
      id: 'case-7f2a',
      status: 'completed',
      fiatAmount: 65000,
      fiatCurrency: 'XAF',
      partnerOrderId: 'njangi-order-42',
      walletAddress:
        '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcd',
    };

    expect(redactSensitiveData(payload)).toEqual({
      id: 'case-7f2a',
      status: 'completed',
      fiatAmount: 65000,
      fiatCurrency: 'XAF',
      partnerOrderId: 'njangi-order-42',
      walletAddress: '0x123456...abcd',
    });
  });

  it('redacts PII nested inside provider customer objects (MoonPay/Transak shapes)', () => {
    const payload = {
      data: {
        id: 'tx-1',
        status: 'completed',
        customer: {
          firstName: 'Jean',
          lastName: 'Mballa',
          email: 'jean.mballa@gmail.com',
          phone: '+237699887766',
          address: { street: 'Avenue Kennedy', town: 'Yaounde' },
        },
      },
    };

    expect(redactSensitiveData(payload)).toEqual({
      data: {
        id: 'tx-1',
        status: 'completed',
        customer: {
          firstName: '***',
          lastName: '***',
          email: 'j***@gmail.com',
          phone: '***',
          address: '***',
        },
      },
    });
  });
});

describe('recordOnrampEvent — persistence boundary', () => {
  it('writes the redacted payload with a correlation id, never raw PII', async () => {
    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});

    await recordOnrampEvent({
      provider: 'transak',
      payload: {
        id: 'order-99',
        status: 'COMPLETED',
        email: 'buyer@protonmail.com',
        firstName: 'Aissatou',
        phoneNumber: '+237677001122',
        walletAddress:
          '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcd',
      },
      receivedAt: new Date('2026-06-12T10:00:00.000Z'),
    });

    expect(infoSpy).toHaveBeenCalledTimes(1);
    const serialized = infoSpy.mock.calls[0][0] as string;

    expect(serialized).not.toContain('buyer@protonmail.com');
    expect(serialized).not.toContain('Aissatou');
    expect(serialized).not.toContain('+237677001122');
    expect(serialized).not.toContain(
      '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcd',
    );

    const record = JSON.parse(serialized) as {
      correlationId: string;
      metadata: { provider: string; payload: Record<string, unknown> };
    };
    expect(record.correlationId).toEqual(expect.any(String));
    expect(record.correlationId.length).toBeGreaterThan(0);
    expect(record.metadata.provider).toBe('transak');
    expect(record.metadata.payload).toEqual({
      id: 'order-99',
      status: 'COMPLETED',
      email: 'b***@protonmail.com',
      firstName: '***',
      phoneNumber: '***',
      walletAddress: '0x123456...abcd',
    });

    infoSpy.mockRestore();
  });
});
