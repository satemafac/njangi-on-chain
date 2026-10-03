// ramp-kyc-bridge.ts — Translates a ramp partner's webhook payload into
// (a) a queued ComplianceAttestation issuance request and (b) a WhatsApp
// confirmation to the member. Centralised so we don't drift between the
// three webhook handlers.

import type { NetworkType } from '../services/whatsapp-registry-service';
import type { PolicyDocument } from '../services/compliance-attestation-service';
import { enqueueAttestation } from './attestation-queue';
import {
  KYC_POLICY_VERSION,
  buildKycPolicyCriteria,
  kycPolicyName,
  type KycEvidence,
  type KycProvider,
} from './kyc-attestation-policy';
import { sendMemberNotification } from './whatsapp-notifier';
import { appLogger } from '../utils/logger';

export type RampKycOutcome = 'approved' | 'declined' | 'pending';

/** What the partner's webhook event evidences (see kyc-attestation-policy.ts). */
export type RampKycEvidence = KycEvidence;

export interface RampKycEvent {
  provider: KycProvider;
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

function approvalMessage(
  provider: RampKycEvent['provider'],
  amount?: string,
): string {
  const friendlyAmount = amount ? ` Your ${amount} purchase is on the way.` : '';
  return (
    `✅ *KYC complete with ${kycPolicyName(provider)}*\n\n` +
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

  // The shared v2 policy (kyc-attestation-policy.ts): partner-KYC reliance
  // plus the concrete evidence type, never the v1 blanket "sanctions
  // screened, jurisdiction allow-listed" claim (2026-06 GTM audit, HIGH).
  // The attestor console proposes the same policy for manual issuance.
  const policy: PolicyDocument = {
    name: kycPolicyName(event.provider),
    version: KYC_POLICY_VERSION,
    issuer: issuerAddress,
    provider: event.provider,
    criteria: buildKycPolicyCriteria(event.provider, event.evidence),
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
