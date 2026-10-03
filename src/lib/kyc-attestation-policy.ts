// kyc-attestation-policy.ts — the policy every KYC attestation is issued
// under, shared by the ramp webhooks (ramp-kyc-bridge.ts) and the attestor
// console (/admin/compliance). njangi_compliance::issue anchors the SHA-256
// of this document on chain (computePolicyHash), so it may claim only what
// the KYC provider decided. Njangi runs no KYC, sanctions screening or
// jurisdiction allow-listing of its own in this flow; the OFAC address
// screen (src/lib/sanctions.ts) is a separate control and is not part of
// any attestation.
//
// No imports, so the browser console and the server share one copy.

/**
 * v2.0.0 (2026-06 GTM review, HIGH finding): v1 claimed "sanctions
 * screened, jurisdiction allow-listed", checks Njangi never performed. v2
 * records reliance on the named provider's KYC program and the evidence
 * received, nothing more.
 */
export const KYC_POLICY_VERSION = '2.0.0';

/** The regulated partners whose KYC decisions an attestation can record. */
export type KycProvider = 'coinbase' | 'moonpay' | 'transak';

/**
 * What the partner's event actually evidences. The policy may claim ONLY
 * this, never a check Njangi did not perform.
 *
 *  - 'partner_kyc_decision': the provider delivered a DEDICATED KYC-status
 *    event (e.g. Transak `KYC_APPROVED`, MoonPay `identity_check_updated`),
 *    or the attestor read the provider's own KYC decision on the case.
 *    Strongest signal we receive: the partner's own KYC program reached an
 *    explicit decision on this case.
 *  - 'purchase_completed': the provider completed a fiat purchase. A
 *    regulated ramp will not settle without having run its own KYC/AML
 *    program on the buyer, so completion implies partner KYC — but it is
 *    NOT a documented sanctions-screening or jurisdiction-allow-listing
 *    decision, and Njangi holds no artifact of one. The policy criteria
 *    must therefore never assert those checks.
 */
export type KycEvidence = 'partner_kyc_decision' | 'purchase_completed';

export function kycPolicyName(provider: KycProvider): string {
  switch (provider) {
    case 'coinbase':
      return 'Coinbase Onramp KYC';
    case 'moonpay':
      return 'MoonPay KYC';
    case 'transak':
      return 'Transak KYC';
  }
}

/**
 * Builds the policy criteria string that gets SHA-256-anchored on chain.
 *
 * Truthful-attestation rule (2026-06 GTM review, HIGH finding): the
 * criteria claims ONLY what the partner evidences. Njangi performs no
 * sanctions screening and no jurisdiction allow-listing in this flow, so
 * the policy must never assert them — it asserts reliance on the named
 * partner's own KYC/AML program, with the evidence type recorded.
 *
 * Fields:
 *  - partner_kyc:<provider>      — the regulated partner whose program we
 *                                  rely on.
 *  - evidence:<KycEvidence>      — the concrete signal received (dedicated
 *                                  KYC decision vs completed purchase).
 *  - evidence_ref:provider_case_id — the partner case artifact backing the
 *                                  claim; the raw id is retained in the
 *                                  attestation queue entry and its HMAC is
 *                                  anchored on chain as external_ref_hash,
 *                                  so the claim stays auditable without
 *                                  leaking the id.
 *  - binding:ramp_destination_address — KNOWN LIMITATION: the attestation
 *                                  subject is the destination wallet
 *                                  address from the partner's case.
 *                                  Nothing proves the KYC'd person controls
 *                                  that address (a buyer who passes partner
 *                                  KYC can route a purchase to an arbitrary
 *                                  address). Downstream consumers must
 *                                  treat this binding as weak. Stronger
 *                                  binding — a signed challenge from the
 *                                  subject address captured at ramp-session
 *                                  creation — is planned for Phase 2.
 */
export function buildKycPolicyCriteria(provider: KycProvider, evidence: KycEvidence): string {
  return [
    `partner_kyc:${provider}`,
    `evidence:${evidence}`,
    'evidence_ref:provider_case_id',
    'binding:ramp_destination_address',
  ].join(', ');
}

/**
 * The policy the attestor console proposes when the operator records a
 * provider's KYC decision by hand: the same name, version and criteria the
 * ramp webhooks queue for a dedicated KYC decision, so both paths make the
 * same claim in the same words.
 */
export function manualKycPolicy(provider: KycProvider): {
  name: string;
  version: string;
  criteria: string;
} {
  return {
    name: kycPolicyName(provider),
    version: KYC_POLICY_VERSION,
    criteria: buildKycPolicyCriteria(provider, 'partner_kyc_decision'),
  };
}
