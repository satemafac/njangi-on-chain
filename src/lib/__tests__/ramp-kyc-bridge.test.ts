/**
 * ramp-kyc-bridge.test.ts — Truthful-attestation policy shape.
 *
 * 2026-06 GTM audit (HIGH): the v1 bridge converted a completed fiat
 * purchase into an on-chain attestation claiming "sanctions screened,
 * jurisdiction allow-listed" — checks Njangi never performed. The v2
 * policy claims ONLY what the partner event evidences (partner KYC
 * reliance + evidence type) and records the weak address binding.
 *
 * These tests run the bridge against the REAL attestation queue
 * (in-memory fallback, DATABASE_URL unset), so they also pin the policy
 * shape that GET /api/compliance/queue serves to the attestor console.
 */

import {
  handleRampKycEvent,
  type RampKycEvent,
} from '@/lib/ramp-kyc-bridge';
import {
  listPendingAttestations,
  __resetAttestationQueueForTests,
} from '@/lib/attestation-queue';
import { sendMemberNotification } from '@/lib/whatsapp-notifier';

jest.mock('@/lib/whatsapp-notifier', () => ({
  sendMemberNotification: jest.fn(),
}));

const mockedNotify = sendMemberNotification as jest.MockedFunction<
  typeof sendMemberNotification
>;

const ISSUER =
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SUBJECT =
  '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcd';

function approvedEvent(overrides: Partial<RampKycEvent> = {}): RampKycEvent {
  return {
    provider: 'coinbase',
    outcome: 'approved',
    evidence: 'purchase_completed',
    providerCaseId: 'case-123',
    subjectAddress: SUBJECT,
    network: 'testnet',
    ...overrides,
  };
}

describe('handleRampKycEvent — truthful attestation policy', () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalSalt = process.env.COMPLIANCE_REF_HMAC_SALT;

  beforeEach(() => {
    jest.clearAllMocks();
    __resetAttestationQueueForTests();
    delete process.env.DATABASE_URL;
    process.env.COMPLIANCE_REF_HMAC_SALT = 'test-ref-salt';
    mockedNotify.mockResolvedValue(
      undefined as unknown as Awaited<ReturnType<typeof sendMemberNotification>>,
    );
  });

  afterAll(() => {
    if (originalDatabaseUrl !== undefined) {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
    if (originalSalt !== undefined) {
      process.env.COMPLIANCE_REF_HMAC_SALT = originalSalt;
    } else {
      delete process.env.COMPLIANCE_REF_HMAC_SALT;
    }
  });

  it('queues a purchase-completion policy that claims only partner-KYC reliance', async () => {
    await handleRampKycEvent(approvedEvent(), ISSUER);

    const entries = await listPendingAttestations();
    expect(entries).toHaveLength(1);
    const { policy } = entries[0];

    expect(policy).toEqual({
      name: 'Coinbase Onramp KYC',
      version: '2.0.0',
      issuer: ISSUER,
      provider: 'coinbase',
      criteria:
        'partner_kyc:coinbase, evidence:purchase_completed, ' +
        'evidence_ref:provider_case_id, binding:ramp_destination_address',
    });
  });

  it('records a dedicated partner KYC decision as stronger evidence', async () => {
    await handleRampKycEvent(
      approvedEvent({
        provider: 'transak',
        evidence: 'partner_kyc_decision',
        providerCaseId: 'kyc-case-9',
      }),
      ISSUER,
    );

    const entries = await listPendingAttestations();
    expect(entries).toHaveLength(1);
    expect(entries[0].policy.provider).toBe('transak');
    expect(entries[0].policy.criteria).toContain('partner_kyc:transak');
    expect(entries[0].policy.criteria).toContain(
      'evidence:partner_kyc_decision',
    );
  });

  it('never claims sanctions screening or jurisdiction allow-listing Njangi did not perform', async () => {
    for (const provider of ['coinbase', 'moonpay', 'transak'] as const) {
      for (const evidence of [
        'purchase_completed',
        'partner_kyc_decision',
      ] as const) {
        await handleRampKycEvent(
          approvedEvent({
            provider,
            evidence,
            providerCaseId: `case-${provider}-${evidence}`,
          }),
          ISSUER,
        );
      }
    }

    const entries = await listPendingAttestations();
    expect(entries).toHaveLength(6);
    for (const entry of entries) {
      const serialized = JSON.stringify(entry.policy);
      expect(serialized).not.toMatch(/sanction/i);
      expect(serialized).not.toMatch(/jurisdiction/i);
      expect(serialized).not.toMatch(/allow[\s-]?list/i);
    }
  });

  it('discloses the weak subject binding so downstream consumers can weigh it', async () => {
    // The subject is the destination wallet from the ramp payload — nothing
    // proves the KYC'd person controls it. The policy must say so; a signed
    // challenge from the subject address is the Phase-2 upgrade.
    await handleRampKycEvent(approvedEvent(), ISSUER);

    const entries = await listPendingAttestations();
    expect(entries[0].policy.criteria).toContain(
      'binding:ramp_destination_address',
    );
    expect(entries[0].policy.criteria).toContain(
      'evidence_ref:provider_case_id',
    );
  });

  it('keeps the provider case id on the queue entry as the auditable artifact reference', async () => {
    await handleRampKycEvent(
      approvedEvent({ providerCaseId: 'order-artifact-42' }),
      ISSUER,
    );

    const entries = await listPendingAttestations();
    expect(entries[0].providerCaseId).toBe('order-artifact-42');
    expect(entries[0].providerCaseHmac).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not enqueue or notify for non-approved outcomes', async () => {
    await handleRampKycEvent(approvedEvent({ outcome: 'pending' }), ISSUER);
    await handleRampKycEvent(approvedEvent({ outcome: 'declined' }), ISSUER);

    expect(await listPendingAttestations()).toHaveLength(0);
    expect(mockedNotify).not.toHaveBeenCalled();
  });

  it('does not enqueue when the subject address is missing', async () => {
    await handleRampKycEvent(
      approvedEvent({ subjectAddress: undefined }),
      ISSUER,
    );

    expect(await listPendingAttestations()).toHaveLength(0);
  });

  it('still sends the WhatsApp confirmation and rethrows when the enqueue fails', async () => {
    // Without the HMAC salt the queue cannot compute the case-id hash and
    // the enqueue throws; the bridge must still notify, then surface the
    // failure so the webhook handler releases its dedupe claim.
    delete process.env.COMPLIANCE_REF_HMAC_SALT;

    await expect(
      handleRampKycEvent(approvedEvent(), ISSUER),
    ).rejects.toThrow(/COMPLIANCE_REF_HMAC_SALT/);

    expect(mockedNotify).toHaveBeenCalledTimes(1);
    expect(mockedNotify).toHaveBeenCalledWith(
      expect.objectContaining({
        memberAddress: SUBJECT,
        kind: 'ramp_kyc_complete',
        dedupeKey: 'coinbase:case-123',
      }),
    );
  });
});
