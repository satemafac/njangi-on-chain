// compliance-gate.ts — Shared helpers for enforcing the Phase 3
// ComplianceAttestation primitive as a precondition for Phase 2 cycle
// escrow operations. The gate is OFF by default (feature flag) so early
// pilots in non-regulated corridors keep working; operators flip it on
// when a jurisdiction requires partner-led KYC checks before a member
// contributes or collects.
//
// Check flow:
//   1. Read NEXT_PUBLIC_COMPLIANCE_GATE_ENABLED (public; UI can preflight).
//   2. Query the member's owned ComplianceAttestation objects.
//   3. Require at least one attestation from the configured issuer that is
//      not revoked and whose `expires_at_ms` is in the future.
//
// The server-side `assertComplianceAttestationValid` helper is suitable
// for API routes and cron jobs; the browser-side `hasValidAttestation`
// powers the UI preflight.
//
// This module is the PREFLIGHT layer only — it exists so the server and
// UI can fail fast with a friendly error before building a transaction.
// Authoritative enforcement is on-chain (Phase 7): gated escrows in
// `njangi_cycle_escrow` pin the exact ComplianceConfig object id at
// open_cycle time and require every contributor and claimant to present
// a non-revoked, non-expired ComplianceAttestation validated against
// that pinned config, and `njangi_circles` carries a per-circle
// `requires_attestation` flag that cannot be disabled once members have
// joined. Bypassing this TypeScript check does not bypass the gate.

import type { SuiClient } from '@mysten/sui/client';
import type { NetworkType } from '../services/whatsapp-registry-service';
import { getNetworkConfig, getPackageIdForNetwork } from '../services/network-config';
import { getPooledSuiClient } from '../services/sui-rpc-failover';

function packageIdFor(network: NetworkType): string {
  const fromConfig = getPackageIdForNetwork(network);
  if (fromConfig && fromConfig.trim() !== '') return fromConfig;
  const envKey =
    network === 'mainnet'
      ? 'NEXT_PUBLIC_MAINNET_PACKAGE_ID'
      : 'NEXT_PUBLIC_TESTNET_PACKAGE_ID';
  const id = process.env[envKey];
  if (!id) {
    throw new Error(
      `Missing ${envKey}; cannot check compliance attestations. Restart the dev server.`,
    );
  }
  return id;
}

export function isComplianceGateEnabled(): boolean {
  return (
    (process.env.NEXT_PUBLIC_COMPLIANCE_GATE_ENABLED || 'false').toLowerCase() === 'true'
  );
}

export function expectedIssuerAddress(): string | null {
  const raw = process.env.NEXT_PUBLIC_NJANGI_ATTESTATION_ISSUER;
  return raw && raw.length > 0 ? raw.toLowerCase() : null;
}

export interface AttestationRow {
  objectId: string;
  subject: string;
  issuer: string;
  policyHash: string;
  externalRefHash: string;
  issuedAtMs: number;
  expiresAtMs: number;
  revoked: boolean;
}

function decodeBytesHex(raw: unknown): string {
  if (typeof raw === 'string') {
    if (/^[0-9a-fA-F]+$/.test(raw)) return raw;
    try {
      return Buffer.from(raw, 'base64').toString('hex');
    } catch {
      return '';
    }
  }
  if (Array.isArray(raw)) {
    return Buffer.from(raw as number[]).toString('hex');
  }
  return '';
}

/**
 * Fetches every non-revoked, non-expired ComplianceAttestation owned by
 * `subject`. Intended for UI preflight and server-side assertion.
 */
export async function fetchValidAttestations(
  subject: string,
  network: NetworkType,
  client?: SuiClient,
): Promise<AttestationRow[]> {
  const packageId = packageIdFor(network);
  const rpcClient =
    client ??
    getPooledSuiClient({
      network,
      rpcUrl: getNetworkConfig(network).rpcUrl,
    });
  const structType = `${packageId}::njangi_compliance::ComplianceAttestation`;
  const results: AttestationRow[] = [];
  let cursor: string | null | undefined = null;
  for (let page = 0; page < 5; page += 1) {
    const response = await rpcClient.getOwnedObjects({
      owner: subject,
      filter: { StructType: structType },
      options: { showContent: true },
      cursor,
    });
    for (const item of response.data) {
      const content = item.data?.content;
      if (!content || content.dataType !== 'moveObject') continue;
      const fields = (content as { fields: Record<string, unknown> }).fields;
      const expected: AttestationRow = {
        objectId: String(item.data?.objectId ?? ''),
        subject: String(fields.subject ?? ''),
        issuer: String(fields.issuer ?? ''),
        policyHash: decodeBytesHex(fields.policy_hash),
        externalRefHash: decodeBytesHex(fields.external_ref_hash),
        issuedAtMs: Number(fields.issued_at_ms ?? 0),
        expiresAtMs: Number(fields.expires_at_ms ?? 0),
        revoked: Boolean(fields.revoked),
      };
      if (expected.revoked) continue;
      if (expected.expiresAtMs <= Date.now()) continue;
      results.push(expected);
    }
    if (!response.hasNextPage || !response.nextCursor) break;
    cursor = response.nextCursor;
  }
  return results;
}

/**
 * Returns the freshest (latest `issued_at_ms`) non-revoked, non-expired
 * attestation the caller owns, optionally pinned to the configured
 * issuer. Used by the Phase 8 panel to pass an attestation object id
 * into the gated CycleEscrow entrypoints.
 */
export async function findFreshestAttestation(
  subject: string,
  network: NetworkType,
  client?: SuiClient,
): Promise<AttestationRow | null> {
  const rows = await fetchValidAttestations(subject, network, client);
  if (rows.length === 0) return null;
  const expectedIssuer = expectedIssuerAddress();
  const scoped = expectedIssuer
    ? rows.filter((r) => r.issuer.toLowerCase() === expectedIssuer)
    : rows;
  if (scoped.length === 0) return null;
  scoped.sort((a, b) => b.issuedAtMs - a.issuedAtMs);
  return scoped[0];
}

export async function hasValidAttestation(
  subject: string,
  network: NetworkType,
  client?: SuiClient,
): Promise<boolean> {
  if (!isComplianceGateEnabled()) return true;
  if (!subject) return false;
  const expectedIssuer = expectedIssuerAddress();
  const rows = await fetchValidAttestations(subject, network, client);
  if (rows.length === 0) return false;
  if (!expectedIssuer) return rows.length > 0;
  return rows.some((r) => r.issuer.toLowerCase() === expectedIssuer);
}

export class ComplianceGateError extends Error {
  readonly code = 'COMPLIANCE_GATE_FAILED';
  constructor(message: string) {
    super(message);
    this.name = 'ComplianceGateError';
  }
}

/**
 * Throws ComplianceGateError when the caller lacks a valid attestation
 * (only when the feature flag is on). Safe to call unconditionally from
 * server endpoints.
 */
export async function assertComplianceAttestationValid(
  subject: string,
  network: NetworkType,
): Promise<void> {
  if (!isComplianceGateEnabled()) return;
  const ok = await hasValidAttestation(subject, network);
  if (!ok) {
    throw new ComplianceGateError(
      'A current compliance attestation is required for this action. Please complete KYC with a ramp partner or your circle admin.',
    );
  }
}
