/**
 * One KYC attestation policy for the ramp webhooks and the attestor console.
 *
 * njangi_compliance::issue anchors the SHA-256 of the policy document on
 * chain, so it may claim only what the KYC provider decided. The ramp path
 * moved to the truthful v2.0.0 policy after the 2026-06 GTM review (HIGH),
 * but the console (/admin/compliance) kept pre-filling v1.0.0 and "Identity
 * verified, sanctions screened, jurisdiction allow-listed." for manual
 * issuance: checks Njangi does not perform.
 *
 * The console is a `.tsx` page and jest runs `testEnvironment: 'node'` on
 * `.test.ts` files only, so its wiring is pinned with source-text
 * assertions, as in src/__tests__/whatsapp-card-status-check.test.ts.
 */

import { readFileSync } from 'fs';
import path from 'path';
import {
  KYC_POLICY_VERSION,
  buildKycPolicyCriteria,
  kycPolicyName,
  manualKycPolicy,
  type KycProvider,
} from '@/lib/kyc-attestation-policy';
import { handleRampKycEvent } from '@/lib/ramp-kyc-bridge';
import {
  listPendingAttestations,
  __resetAttestationQueueForTests,
} from '@/lib/attestation-queue';
import { sendMemberNotification } from '@/lib/whatsapp-notifier';

jest.mock('@/lib/whatsapp-notifier', () => ({
  sendMemberNotification: jest.fn(),
}));

const PROVIDERS: KycProvider[] = ['coinbase', 'moonpay', 'transak'];
const ISSUER = `0x${'a'.repeat(64)}`;
const SUBJECT = `0x${'1234567890abcdef'.repeat(4)}`;
/** Claims of checks Njangi does not perform in this flow. */
const UNPERFORMED_CHECKS = /sanction|jurisdiction|identity verified|screen/i;

describe('the shared KYC attestation policy', () => {
  it('is version 2.0.0, the truthful policy (a bump changes every hash, so make it on purpose)', () => {
    expect(KYC_POLICY_VERSION).toBe('2.0.0');
  });

  it('claims only partner-KYC reliance, the evidence and the weak address binding', () => {
    for (const provider of PROVIDERS) {
      for (const evidence of ['partner_kyc_decision', 'purchase_completed'] as const) {
        const criteria = buildKycPolicyCriteria(provider, evidence);
        expect(criteria).toBe(
          `partner_kyc:${provider}, evidence:${evidence}, ` +
            'evidence_ref:provider_case_id, binding:ramp_destination_address',
        );
        expect(criteria).not.toMatch(UNPERFORMED_CHECKS);
      }
      expect(kycPolicyName(provider)).not.toMatch(UNPERFORMED_CHECKS);
    }
  });
});

describe('manualKycPolicy (what the attestor console fills in)', () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalSalt = process.env.COMPLIANCE_REF_HMAC_SALT;

  beforeEach(() => {
    // The real attestation queue, on its in-memory fallback.
    __resetAttestationQueueForTests();
    delete process.env.DATABASE_URL;
    process.env.COMPLIANCE_REF_HMAC_SALT = 'test-ref-salt';
    (sendMemberNotification as jest.Mock).mockResolvedValue(undefined);
  });

  afterAll(() => {
    if (originalDatabaseUrl !== undefined) process.env.DATABASE_URL = originalDatabaseUrl;
    if (originalSalt !== undefined) process.env.COMPLIANCE_REF_HMAC_SALT = originalSalt;
    else delete process.env.COMPLIANCE_REF_HMAC_SALT;
  });

  it('is built from the shared version and criteria', () => {
    for (const provider of PROVIDERS) {
      expect(manualKycPolicy(provider)).toEqual({
        name: kycPolicyName(provider),
        version: KYC_POLICY_VERSION,
        criteria: buildKycPolicyCriteria(provider, 'partner_kyc_decision'),
      });
    }
  });

  it('matches the policy the ramp webhooks queue for a KYC decision', async () => {
    for (const provider of PROVIDERS) {
      __resetAttestationQueueForTests();
      await handleRampKycEvent(
        {
          provider,
          outcome: 'approved',
          evidence: 'partner_kyc_decision',
          providerCaseId: `case-${provider}`,
          subjectAddress: SUBJECT,
          network: 'testnet',
        },
        ISSUER,
      );
      const [entry] = await listPendingAttestations();
      const { name, version, criteria } = entry.policy;
      expect(manualKycPolicy(provider)).toEqual({ name, version, criteria });
    }
  });
});

describe('attestor console (/admin/compliance)', () => {
  /** Comments explain the rule; they must not trip it. */
  const stripComments = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const page = stripComments(
    readFileSync(path.resolve(__dirname, '../../pages/admin/compliance.tsx'), 'utf8'),
  );

  it('defaults the policy version to the shared constant', () => {
    expect(page).toContain('useState(KYC_POLICY_VERSION)');
    expect(page).not.toMatch(/['"]\d+\.\d+\.\d+['"]/);
  });

  it('claims nothing until the attestor picks the provider, then fills in the shared policy', () => {
    expect(page).toContain("const [provider, setProvider] = useState<ProviderChoice | ''>('');");
    expect(page).toContain("const [policyName, setPolicyName] = useState('');");
    expect(page).toContain("const [criteria, setCriteria] = useState('');");
    expect(page).toContain('manualKycPolicy(next)');
    expect(page).toContain('onChange={(e) => chooseProvider(');
  });

  it('refuses to issue without a provider, a policy name and criteria', () => {
    expect(page).toContain("if (!provider || !policyName.trim() || !criteria.trim()) {");
  });

  it('claims no sanctions or jurisdiction check, in the defaults or the copy', () => {
    expect(page).not.toMatch(
      /sanctions screened|jurisdiction allow-listed|sanctions decision|identity verified/i,
    );
  });
});
