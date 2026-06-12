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

export interface RampKycEvent {
  provider: 'coinbase' | 'moonpay' | 'transak';
  outcome: RampKycOutcome;
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
  /** Free-form criteria summary stored in the off-chain audit log only. */
  criteria?: string;
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

  const policy: PolicyDocument = {
    name: policyName(event.provider),
    version: '1.0.0',
    issuer: issuerAddress,
    provider: event.provider,
    criteria:
      event.criteria ??
      'Identity verified, sanctions screened, jurisdiction allow-listed by ramp partner.',
  };

  try {
    await enqueueAttestation({
      subject: event.subjectAddress,
      providerCaseId: event.providerCaseId,
      policy,
      ttlMs: DEFAULT_TTL_MS,
      network: event.network,
    });
  } catch (err) {
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
}
