// compliance-attestation-service.ts — Off-chain helper for issuing the
// Phase 3 ComplianceAttestation anchors defined in `njangi_compliance.move`.
//
// Attestations pair with the regulated ramp partner flow: once Coinbase,
// MoonPay, or Transak returns a successful KYC/sanctions decision for a
// given user address, the operator's attestor service calls `issue(...)`
// on the Move module with:
//   * `policy_hash`       = SHA-256 of the signed off-chain policy document
//                           (provider name, jurisdiction rules, rule version).
//   * `external_ref_hash` = HMAC-SHA256(secret, provider_case_id).
//   * `ttl_ms`            = validity window; typically 90 days for KYC and
//                           shorter for sanctions rescreens.
//
// Nothing about the underlying case (phone number, country, document
// scans) ever leaves the compliance system. Downstream Move code — for
// example, a future version of `open_cycle` that gates on attestation
// freshness — only sees the opaque hash pair on chain.

import { createHash, createHmac, randomUUID } from 'crypto';
import { Transaction } from '@mysten/sui/transactions';
import type { NetworkType } from './whatsapp-registry-service';

const POLICY_HASH_BYTES = 32;
const REF_HASH_BYTES = 32;
const DEFAULT_KYC_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

export interface PolicyDocument {
  /** Human-readable policy name, e.g. "FATF travel rule v2". */
  name: string;
  /** Semver-style version string. */
  version: string;
  /** Issuer address (AttestorCap holder). */
  issuer: string;
  /** Regulated counterparty that actually performed KYC. */
  provider: 'coinbase' | 'moonpay' | 'transak' | 'internal';
  /** Free-form criteria summary; not used for verification but logged. */
  criteria: string;
}

export interface AttestationIssuanceInput {
  subject: string; // the user's Sui address
  policy: PolicyDocument;
  providerCaseId: string; // issuer-side reference (never published raw)
  ttlMs?: number;
  network: NetworkType;
}

export interface AttestationIssuancePayload {
  policyHashHex: string;
  externalRefHashHex: string;
  ttlMs: number;
  buildTransaction: (txb: Transaction, attestorCapId: string) => void;
}

function packageIdFor(network: NetworkType): string {
  const envKey =
    network === 'mainnet'
      ? 'NEXT_PUBLIC_MAINNET_PACKAGE_ID'
      : 'NEXT_PUBLIC_TESTNET_PACKAGE_ID';
  const id = process.env[envKey];
  if (!id) {
    throw new Error(`Missing ${envKey}; cannot build compliance attestations.`);
  }
  return id;
}

/**
 * Canonicalizes the policy document to a stable JSON representation and
 * returns the SHA-256 hash. Two processes that agree on the policy
 * fields will produce identical hashes regardless of input key order.
 */
export function computePolicyHash(policy: PolicyDocument): Buffer {
  const canonical = JSON.stringify({
    name: policy.name,
    version: policy.version,
    issuer: policy.issuer,
    provider: policy.provider,
    criteria: policy.criteria,
  });
  const hash = createHash('sha256').update(canonical).digest();
  if (hash.length !== POLICY_HASH_BYTES) {
    throw new Error(`Unexpected policy hash length: ${hash.length}`);
  }
  return hash;
}

/**
 * HMAC-SHA256 of the provider case ID using the dedicated compliance
 * salt. Stored on chain so the issuer can later prove the anchor refers
 * to a specific case without leaking the case ID itself.
 */
export function computeExternalRefHash(providerCaseId: string): Buffer {
  const salt = process.env.COMPLIANCE_REF_HMAC_SALT;
  if (!salt) {
    throw new Error(
      'COMPLIANCE_REF_HMAC_SALT is not set; refusing to build an attestation without a reference salt.',
    );
  }
  const hmac = createHmac('sha256', salt).update(providerCaseId).digest();
  if (hmac.length !== REF_HASH_BYTES) {
    throw new Error(`Unexpected external ref hash length: ${hmac.length}`);
  }
  return hmac;
}

/**
 * Prepares an attestation issuance payload. The returned `buildTransaction`
 * callback is suitable for both the server signer
 * (`enokiZkLoginService.sendTransaction`) and the Phase 2 client-side
 * signer (`useZkLoginSigner.signAndExecute`) — it just needs the
 * AttestorCap object id to be passed in at build time.
 */
export function prepareAttestationIssuance(
  input: AttestationIssuanceInput,
): AttestationIssuancePayload {
  const policyHash = computePolicyHash(input.policy);
  const externalRefHash = computeExternalRefHash(input.providerCaseId);
  const ttlMs = input.ttlMs ?? DEFAULT_KYC_TTL_MS;
  if (ttlMs <= 0) {
    throw new Error('Attestation TTL must be positive.');
  }

  const packageId = packageIdFor(input.network);
  return {
    policyHashHex: policyHash.toString('hex'),
    externalRefHashHex: externalRefHash.toString('hex'),
    ttlMs,
    buildTransaction: (txb: Transaction, attestorCapId: string) => {
      txb.moveCall({
        target: `${packageId}::njangi_compliance::issue`,
        arguments: [
          txb.object(attestorCapId),
          txb.pure.address(input.subject),
          txb.pure.vector('u8', Array.from(policyHash)),
          txb.pure.vector('u8', Array.from(externalRefHash)),
          txb.pure.u64(ttlMs),
          txb.object('0x6'),
        ],
      });
    },
  };
}

/**
 * Convenience: generate a correlation id the issuer can use to keep the
 * off-chain case DB and on-chain attestation in sync. Not cryptographic;
 * just a UUID so audit logs can be correlated without leaking PII.
 */
export function makeIssuanceCorrelationId(): string {
  return randomUUID();
}
