// ramp-kyc-bridge.ts — Translates a ramp partner's webhook payload into
// (a) a queued ComplianceAttestation issuance request and (b) a WhatsApp
// confirmation to the member. Centralised so we don't drift between the
// three webhook handlers.

import type { NetworkType } from '../services/whatsapp-registry-service';
import type { PolicyDocument } from '../services/compliance-attestation-service';
import { enqueueAttestation } from './attestation-queue';
import { sendMemberNotification } from './whatsapp-notifier';
import { appLogger } from '../utils/logger';

export type RampKycOutcome = 'approved' | 'declined' | 'pending';

/**
 * What the partner's webhook event actually evidences. The attestation
 * policy may claim ONLY this — never checks Njangi did not perform.
 *
 *  - 'partner_kyc_decision': the provider delivered a DEDICATED KYC-status
 *    event (e.g. Transak `KYC_APPROVED`, MoonPay `identity_check_updated`).
 *    Strongest signal we receive: the partner's own KYC program reached an
 *    explicit decision on this case.
 *  - 'purchase_completed': the provider completed a fiat purchase. A
 *    regulated ramp will not settle without having run its own KYC/AML
 *    program on the buyer, so completion implies partner KYC — but it is
 *    NOT a documented sanctions-screening or jurisdiction-allow-listing
 *    decision, and Njangi holds no artifact of one. The policy criteria
 *    must therefore never assert those checks.
 */
export type RampKycEvidence = 'partner_kyc_decision' | 'purchase_completed';

export interface RampKycEvent {
  provider: 'coinbase' | 'moonpay' | 'transak';
  outcome: RampKycOutcome;
  /**
   * What the webhook event actually attests. Each handler sets this from
   * the concrete event type it received, and the value is embedded in the
   * (hashed, on-chain-anchored) policy criteria — so it must be truthful.
   */
  evidence: RampKycEvidence;
  /** Provider's case identifier (orderId, sessionId, etc.). Required. */
  providerCaseId: string;
  /** Sui address of the member that just passed KYC. */
  subjectAddress?: string;
  /** Network to scope the attestation issuance + lookup. */
  network: NetworkType;
  /** Optional override if we already know the member's WhatsApp number. */
  phoneOverride?: string;
  /** Amount string for the WhatsApp confirmation copy. */
  amount?: string;
}

const DEFAULT_TTL_MS = 90 * 24 * 60 * 60 * 1000;

function policyName(provider: RampKycEvent['provider']): string {
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
 * Truthful-attestation rule (2026-06 GTM audit, HIGH finding): the
 * criteria claims ONLY what the partner event evidences. Njangi performs
 * no sanctions screening and no jurisdiction allow-listing itself, so the
 * policy must never assert them — it asserts reliance on the named
 * partner's own KYC/AML program, with the evidence type recorded.
 *
 * Fields:
 *  - partner_kyc:<provider>      — the regulated partner whose program we
 *                                  rely on.
 *  - evidence:<RampKycEvidence>  — the concrete webhook signal received
 *                                  (dedicated KYC decision vs completed
 *                                  purchase).
 *  - evidence_ref:provider_case_id — the partner case artifact backing the
 *                                  claim; the raw id is retained in the
 *                                  attestation queue entry and its HMAC is
 *                                  anchored on chain as external_ref_hash,
 *                                  so the claim stays auditable without
 *                                  leaking the id.
 *  - binding:ramp_destination_address — KNOWN LIMITATION: the attestation
 *                                  subject is the destination wallet
 *                                  address taken from the partner's
 *                                  webhook payload. Nothing proves the
 *                                  KYC'd person controls that address (a
 *                                  buyer who passes partner KYC can route
 *                                  a purchase to an arbitrary address).
 *                                  Downstream consumers must treat this
 *                                  binding as weak. Stronger binding — a
 *                                  signed challenge from the subject
 *                                  address captured at ramp-session
 *                                  creation — is planned for Phase 2.
 */
function buildPolicyCriteria(
  provider: RampKycEvent['provider'],
  evidence: RampKycEvidence,
): string {
  return [
    `partner_kyc:${provider}`,
    `evidence:${evidence}`,
    'evidence_ref:provider_case_id',
    'binding:ramp_destination_address',
  ].join(', ');
}

function approvalMessage(
  provider: RampKycEvent['provider'],
  amount?: string,
): string {
  const friendlyAmount = amount ? ` Your ${amount} purchase is on the way.` : '';
  return (
    `✅ *KYC complete with ${policyName(provider)}*\n\n` +
    `You can now pay your share or collect a payout in any njangi circle that requires KYC.${friendlyAmount}\n\n` +
    `Open the Njangi app to continue.`
  );
}

/**
 * Single entry point each ramp webhook handler calls when the partner
 * returns a final KYC decision. Approved cases queue an attestation and
 * send a WhatsApp confirmation; declined / pending cases are recorded in
 * application logs only (no on-chain state, no member nudge).
 *
 * MUST be awaited by the webhook handler before it responds: on serverless
 * the function instance is frozen as soon as the response is sent, so a
 * fire-and-forget call may never execute. Throws when the attestation
 * enqueue fails so the handler can release its webhook-dedupe claim and
 * return non-2xx — the provider's retry then re-runs this function, which
 * is idempotent end to end (the queue dedupes pending rows on
 * (network, subject, case-hash); the notifier dedupes successful sends on
 * (kind, address, dedupeKey)).
 */
export async function handleRampKycEvent(
  event: RampKycEvent,
  issuerAddress: string,
): Promise<void> {
  if (event.outcome !== 'approved') {
    appLogger.info('[ramp-kyc-bridge] non-approved outcome — skipping issuance', {
      provider: event.provider,
      outcome: event.outcome,
      providerCaseId: event.providerCaseId,
    });
    return;
  }

  if (!event.subjectAddress) {
    appLogger.warn('[ramp-kyc-bridge] approved but missing subject — cannot enqueue', {
      provider: event.provider,
      providerCaseId: event.providerCaseId,
    });
    return;
  }

  // Policy v2.0.0: criteria rewritten to the truthful form — it records
  // partner-KYC reliance plus the concrete evidence type, instead of the
  // v1 blanket "sanctions screened, jurisdiction allow-listed" claim that
  // asserted checks Njangi never performed (2026-06 GTM audit, HIGH).
  const policy: PolicyDocument = {
    name: policyName(event.provider),
    version: '2.0.0',
    issuer: issuerAddress,
    provider: event.provider,
    criteria: buildPolicyCriteria(event.provider, event.evidence),
  };

  let enqueueError: unknown = null;
  try {
    await enqueueAttestation({
      subject: event.subjectAddress,
      providerCaseId: event.providerCaseId,
      policy,
      ttlMs: DEFAULT_TTL_MS,
      network: event.network,
    });
  } catch (err) {
    enqueueError = err;
    appLogger.warn('[ramp-kyc-bridge] enqueue failed', {
      provider: event.provider,
      providerCaseId: event.providerCaseId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Whatever the outcome of the queue write, attempt the WhatsApp
  // confirmation so the member knows their KYC went through. The
  // dispatcher is idempotent on `(kind, address, dedupeKey)` so a webhook
  // retry won't double-send.
  await sendMemberNotification({
    memberAddress: event.subjectAddress,
    phoneOverride: event.phoneOverride,
    body: approvalMessage(event.provider, event.amount),
    kind: 'ramp_kyc_complete',
    network: event.network,
    dedupeKey: `${event.provider}:${event.providerCaseId}`,
    dedupeWindowMs: 24 * 60 * 60 * 1000,
  });

  if (enqueueError) {
    // Surface the dropped attestation to the webhook handler so it can
    // release its dedupe claim and answer non-2xx; the provider retry
    // re-runs the enqueue while the WhatsApp send above stays deduped.
    throw enqueueError instanceof Error
      ? enqueueError
      : new Error(String(enqueueError));
  }
}
