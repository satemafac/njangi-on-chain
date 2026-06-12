// attestation-queue.ts — Server-side queue of pending compliance
// attestations. Ramp partners (Coinbase / MoonPay / Transak) POST here
// after a successful KYC decision so the attestor console can one-click
// the on-chain issuance later.
//
// Phase 10 storage model:
//   * When DATABASE_URL is configured, entries live in a Postgres table
//     keyed by `(network, subject, providerCaseHmac)` so multiple app
//     instances (web + notifier + admin) read the same queue.
//   * When DATABASE_URL is absent (local dev, Vercel preview, etc.) we
//     fall back to an in-memory Map so the console still works during
//     development. A `warnFallbackOnce` log makes that obvious.
//
// Security model:
//   * POSTs require `x-internal-auth` matching COMPLIANCE_ISSUANCE_SECRET
//     (or INTERNAL_NOTIFY_SECRET fallback). The queue layer assumes its
//     caller has already enforced that gate; do not expose these helpers
//     behind unauthenticated HTTP.
//   * Raw case ids are only kept when the operator needs to inspect them
//     in the admin console. The list endpoint can opt-out of returning
//     them.

import type { Pool } from 'pg';
import { getSharedPgPool, isPostgresConfigured } from './pg-pool';
import { computeExternalRefHash } from '../services/compliance-attestation-service';
import type { PolicyDocument } from '../services/compliance-attestation-service';
import type { NetworkType } from '../services/whatsapp-registry-service';

export interface AttestationQueueEntry {
  id: string;
  subject: string;
  providerCaseId: string;
  providerCasePreview: string;
  providerCaseHmac: string;
  policy: PolicyDocument;
  ttlMs: number;
  network: NetworkType;
  queuedAt: number;
  status: 'pending' | 'issued' | 'dismissed';
  issuedTxDigest?: string;
}

export interface EnqueueInput {
  subject: string;
  providerCaseId: string;
  policy: PolicyDocument;
  ttlMs?: number;
  network: NetworkType;
}

const DEFAULT_KYC_TTL_MS = 90 * 24 * 60 * 60 * 1000;

let setupPromise: Promise<void> | null = null;
let memoryWarned = false;
const memoryStore: Map<string, AttestationQueueEntry> = new Map();

function isPostgresAvailable(): boolean {
  return isPostgresConfigured();
}

// Shared lazy pool (SSL resolved from sslmode/PGSSLMODE, verified TLS by
// default in production) — see src/lib/pg-pool.ts.
function getPool(): Pool {
  return getSharedPgPool();
}

async function ensureTable(): Promise<void> {
  if (!setupPromise) {
    setupPromise = getPool()
      .query(
        `
        CREATE TABLE IF NOT EXISTS compliance_attestation_queue (
          id TEXT PRIMARY KEY,
          network TEXT NOT NULL,
          subject TEXT NOT NULL,
          provider_case_id TEXT NOT NULL,
          provider_case_preview TEXT NOT NULL,
          provider_case_hmac TEXT NOT NULL,
          policy JSONB NOT NULL,
          ttl_ms BIGINT NOT NULL,
          queued_at BIGINT NOT NULL,
          status TEXT NOT NULL,
          issued_tx_digest TEXT
        );
        CREATE INDEX IF NOT EXISTS compliance_attestation_queue_status_idx
          ON compliance_attestation_queue (status, queued_at);
        CREATE UNIQUE INDEX IF NOT EXISTS compliance_attestation_queue_dedupe_idx
          ON compliance_attestation_queue (network, subject, provider_case_hmac)
          WHERE status = 'pending';
        `,
      )
      .then(() => undefined);
  }
  return setupPromise;
}

function warnFallbackOnce() {
  if (memoryWarned) return;
  memoryWarned = true;
  console.warn(
    '[attestation-queue] DATABASE_URL not configured; using in-memory fallback. ' +
      'OK for local dev only — production must persist the queue across restarts.',
  );
}

function makePreview(caseId: string): string {
  if (caseId.length <= 16) return caseId;
  return `${caseId.slice(0, 8)}…${caseId.slice(-4)}`;
}

function normalizeAddress(addr: string): string {
  const lower = addr.toLowerCase();
  return lower.startsWith('0x') ? lower : `0x${lower}`;
}

function makeEntryId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

type DbRow = {
  id: string;
  network: NetworkType;
  subject: string;
  provider_case_id: string;
  provider_case_preview: string;
  provider_case_hmac: string;
  policy: PolicyDocument;
  ttl_ms: string | number;
  queued_at: string | number;
  status: 'pending' | 'issued' | 'dismissed';
  issued_tx_digest: string | null;
};

function rowToEntry(row: DbRow): AttestationQueueEntry {
  return {
    id: row.id,
    subject: row.subject,
    providerCaseId: row.provider_case_id,
    providerCasePreview: row.provider_case_preview,
    providerCaseHmac: row.provider_case_hmac,
    policy: row.policy,
    ttlMs: Number(row.ttl_ms),
    network: row.network,
    queuedAt: Number(row.queued_at),
    status: row.status,
    issuedTxDigest: row.issued_tx_digest ?? undefined,
  };
}

export async function enqueueAttestation(input: EnqueueInput): Promise<AttestationQueueEntry> {
  const subject = normalizeAddress(input.subject);
  const ttlMs = input.ttlMs ?? DEFAULT_KYC_TTL_MS;
  const hmac = computeExternalRefHash(input.providerCaseId).toString('hex');

  if (!isPostgresAvailable()) {
    warnFallbackOnce();
    for (const existing of memoryStore.values()) {
      if (
        existing.status === 'pending' &&
        existing.network === input.network &&
        existing.subject === subject &&
        existing.providerCaseHmac === hmac
      ) {
        return existing;
      }
    }
    const entry: AttestationQueueEntry = {
      id: makeEntryId(),
      subject,
      providerCaseId: input.providerCaseId,
      providerCasePreview: makePreview(input.providerCaseId),
      providerCaseHmac: hmac,
      policy: input.policy,
      ttlMs,
      network: input.network,
      queuedAt: Date.now(),
      status: 'pending',
    };
    memoryStore.set(entry.id, entry);
    return entry;
  }

  await ensureTable();
  const client = getPool();
  // Dedupe on (network, subject, provider_case_hmac) for pending rows.
  const existing = await client.query<DbRow>(
    `SELECT * FROM compliance_attestation_queue
      WHERE status = 'pending' AND network = $1 AND subject = $2 AND provider_case_hmac = $3
      LIMIT 1`,
    [input.network, subject, hmac],
  );
  if (existing.rowCount && existing.rows[0]) {
    return rowToEntry(existing.rows[0]);
  }

  const id = makeEntryId();
  const queuedAt = Date.now();
  const inserted = await client.query<DbRow>(
    `INSERT INTO compliance_attestation_queue (
       id, network, subject, provider_case_id, provider_case_preview,
       provider_case_hmac, policy, ttl_ms, queued_at, status
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')
     RETURNING *`,
    [
      id,
      input.network,
      subject,
      input.providerCaseId,
      makePreview(input.providerCaseId),
      hmac,
      input.policy,
      ttlMs,
      queuedAt,
    ],
  );
  return rowToEntry(inserted.rows[0]);
}

export async function listPendingAttestations(): Promise<AttestationQueueEntry[]> {
  if (!isPostgresAvailable()) {
    warnFallbackOnce();
    return Array.from(memoryStore.values())
      .filter((entry) => entry.status === 'pending')
      .sort((a, b) => a.queuedAt - b.queuedAt);
  }

  await ensureTable();
  const result = await getPool().query<DbRow>(
    `SELECT * FROM compliance_attestation_queue
      WHERE status = 'pending'
      ORDER BY queued_at ASC
      LIMIT 200`,
  );
  return result.rows.map(rowToEntry);
}

export async function markIssued(
  entryId: string,
  txDigest: string,
): Promise<AttestationQueueEntry | null> {
  if (!isPostgresAvailable()) {
    warnFallbackOnce();
    const entry = memoryStore.get(entryId);
    if (!entry) return null;
    entry.status = 'issued';
    entry.issuedTxDigest = txDigest;
    return entry;
  }

  await ensureTable();
  const result = await getPool().query<DbRow>(
    `UPDATE compliance_attestation_queue
        SET status = 'issued', issued_tx_digest = $2
      WHERE id = $1
      RETURNING *`,
    [entryId, txDigest],
  );
  if (!result.rowCount) return null;
  return rowToEntry(result.rows[0]);
}

export async function dismissEntry(entryId: string): Promise<boolean> {
  if (!isPostgresAvailable()) {
    warnFallbackOnce();
    const entry = memoryStore.get(entryId);
    if (!entry) return false;
    entry.status = 'dismissed';
    return true;
  }

  await ensureTable();
  const result = await getPool().query(
    `UPDATE compliance_attestation_queue SET status = 'dismissed' WHERE id = $1`,
    [entryId],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Exposed so tests can reset between cases. Not used in production. */
export function __resetAttestationQueueForTests(): void {
  memoryStore.clear();
  setupPromise = null;
}
