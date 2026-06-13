// legal-acceptance-server.ts — Server-side persistence for the legal
// acceptance gate (docs/legal-drafts/ACCEPTANCE-GATE-SPEC.md).
//
// Split from src/lib/legal-acceptance.ts on purpose: that module is
// client-safe (imported by the modal, footer, and /legal pages) and must
// never pull `pg`/`node:crypto` into a browser bundle. This module is the
// server half — only API routes import it.
//
// Invariants enforced here:
//  * Versions are resolved from CURRENT_LEGAL_VERSIONS — callers never pass
//    client-supplied versions (the optional `versions` parameter exists for
//    tests and version-bump simulations only; API routes use the default).
//  * Rows are append-only. Re-acceptance of a new version inserts a new row;
//    nothing is ever updated or deleted (consent/defense-of-claims records
//    are retained even through PII-deletion requests — the Privacy Policy
//    retention section says so).
//  * Identity key is (sub, aud) — the same durable root identity as the
//    `salts` table. `user_address` is stored alongside for audit only.
//  * ip_hash is HMAC-SHA256(ip, LEGAL_ACCEPT_IP_SALT); the raw IP is never
//    stored (same posture as /api/legal/data-deletion-request).
//
// Storage: the `legal_acceptances` Postgres table (created by
// scripts/migrate-postgres.mjs). Without DATABASE_URL the store falls back
// to an in-memory map for dev/tests; production fails fast instead —
// silently losing consent records is not an acceptable degradation.

import { createHmac } from 'node:crypto';
import { getSharedPgPool, isPostgresConfigured } from './pg-pool';
import {
  CURRENT_LEGAL_VERSIONS,
  LEGAL_DOC_IDS,
  type LegalDocId,
  type LegalLocale,
} from './legal-acceptance';

/** Server-verified identity (from the zkLogin session registry — never the request body). */
export interface VerifiedLegalIdentity {
  sub: string;
  aud: string;
  userAddr: string;
}

export interface LegalDocRequirement {
  doc: LegalDocId;
  currentVersion: string;
  /** Latest version this identity ever accepted for the doc (null = never). */
  acceptedVersion: string | null;
}

export interface LegalAcceptanceStatus {
  required: LegalDocRequirement[];
  /** Docs whose current version has not been accepted (first login OR version bump). */
  missing: LegalDocId[];
  allAccepted: boolean;
}

export interface RecordedAcceptance {
  doc: LegalDocId;
  version: string;
  /** False when the (sub, aud, doc, version) row already existed (idempotent re-POST). */
  inserted: boolean;
}

/**
 * HMAC of the client IP keyed with LEGAL_ACCEPT_IP_SALT; never the raw IP.
 * Returns null when the salt is unset (dev) — the row stores NULL rather
 * than a raw address.
 */
export function hashAcceptanceIp(ip: string): string | null {
  const salt = process.env.LEGAL_ACCEPT_IP_SALT;
  if (!salt) return null;
  return createHmac('sha256', salt).update(ip).digest('hex');
}

// ---------------------------------------------------------------------------
// In-memory fallback (dev / unit tests only)
// ---------------------------------------------------------------------------

interface MemoryRow {
  doc: LegalDocId;
  version: string;
  locale: LegalLocale;
  userAddress: string;
  ipHash: string | null;
  acceptedAt: number;
}

const GLOBAL_KEY = Symbol.for('njangi.legal.acceptance-store');

function getMemoryStore(): Map<string, MemoryRow[]> {
  const globalStore = globalThis as { [key: symbol]: unknown };
  if (!(globalStore[GLOBAL_KEY] instanceof Map)) {
    globalStore[GLOBAL_KEY] = new Map<string, MemoryRow[]>();
  }
  return globalStore[GLOBAL_KEY] as Map<string, MemoryRow[]>;
}

function memoryKey(sub: string, aud: string): string {
  return `${sub}\u0000${aud}`;
}

function durableStoreEnabled(): boolean {
  if (isPostgresConfigured()) {
    return true;
  }
  if (process.env.NODE_ENV === 'production') {
    // Fail fast: consent records vanishing with the lambda instance would
    // re-prompt users at random and leave no legal evidence. Never degrade.
    throw new Error(
      '[legal-acceptance] DATABASE_URL is required in production; ' +
        'refusing to keep legal acceptance records in per-instance memory.',
    );
  }
  return false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compares the identity's accepted versions against the current published
 * versions. `versions` defaults to the server-resolved constant; only tests
 * override it (e.g. to simulate a version bump).
 */
export async function getLegalAcceptanceStatus(
  sub: string,
  aud: string,
  versions: Record<LegalDocId, string> = CURRENT_LEGAL_VERSIONS,
): Promise<LegalAcceptanceStatus> {
  let rows: Array<{ doc: LegalDocId; version: string }>;

  if (durableStoreEnabled()) {
    const result = await getSharedPgPool().query<{ doc: LegalDocId; version: string }>(
      `SELECT doc, version FROM legal_acceptances
        WHERE sub = $1 AND aud = $2
        ORDER BY accepted_at ASC, id ASC`,
      [sub, aud],
    );
    rows = result.rows;
  } else {
    rows = (getMemoryStore().get(memoryKey(sub, aud)) ?? [])
      .slice()
      .sort((a, b) => a.acceptedAt - b.acceptedAt)
      .map((row) => ({ doc: row.doc, version: row.version }));
  }

  const acceptedVersionSets = new Map<LegalDocId, Set<string>>();
  const latestAccepted = new Map<LegalDocId, string>();
  for (const row of rows) {
    if (!acceptedVersionSets.has(row.doc)) {
      acceptedVersionSets.set(row.doc, new Set());
    }
    acceptedVersionSets.get(row.doc)!.add(row.version);
    latestAccepted.set(row.doc, row.version);
  }

  const required: LegalDocRequirement[] = LEGAL_DOC_IDS.map((doc) => ({
    doc,
    currentVersion: versions[doc],
    acceptedVersion: latestAccepted.get(doc) ?? null,
  }));
  const missing = LEGAL_DOC_IDS.filter(
    (doc) => !acceptedVersionSets.get(doc)?.has(versions[doc]),
  );

  return { required, missing, allAccepted: missing.length === 0 };
}

/** Convenience boolean + missing-docs view of the status. */
export async function hasAcceptedAllLegalDocs(
  sub: string,
  aud: string,
): Promise<{ accepted: boolean; missing: LegalDocId[] }> {
  const status = await getLegalAcceptanceStatus(sub, aud);
  return { accepted: status.allAccepted, missing: status.missing };
}

/**
 * Inserts one append-only row per doc at the CURRENT server-resolved
 * version, bound to the verified session identity. Duplicate acceptances
 * (same sub/aud/doc/version) are no-ops via the unique index, so a retried
 * POST is idempotent and still reports success.
 */
export async function recordLegalAcceptances(
  identity: VerifiedLegalIdentity,
  docs: readonly LegalDocId[],
  locale: LegalLocale,
  ipHash: string | null,
  versions: Record<LegalDocId, string> = CURRENT_LEGAL_VERSIONS,
): Promise<RecordedAcceptance[]> {
  const uniqueDocs = [...new Set(docs)];
  const recorded: RecordedAcceptance[] = [];

  if (durableStoreEnabled()) {
    const pool = getSharedPgPool();
    for (const doc of uniqueDocs) {
      const result = await pool.query(
        `INSERT INTO legal_acceptances (sub, aud, user_address, doc, version, locale, ip_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (sub, aud, doc, version) DO NOTHING
         RETURNING id`,
        [identity.sub, identity.aud, identity.userAddr, doc, versions[doc], locale, ipHash],
      );
      recorded.push({ doc, version: versions[doc], inserted: (result.rowCount ?? 0) > 0 });
    }
    return recorded;
  }

  const store = getMemoryStore();
  const key = memoryKey(identity.sub, identity.aud);
  const rows = store.get(key) ?? [];
  for (const doc of uniqueDocs) {
    const exists = rows.some((row) => row.doc === doc && row.version === versions[doc]);
    if (!exists) {
      rows.push({
        doc,
        version: versions[doc],
        locale,
        userAddress: identity.userAddr,
        ipHash,
        acceptedAt: Date.now(),
      });
    }
    recorded.push({ doc, version: versions[doc], inserted: !exists });
  }
  store.set(key, rows);
  return recorded;
}

/** Test helper — clears the dev/test in-memory store. */
export function __resetLegalAcceptanceMemoryStoreForTests(): void {
  getMemoryStore().clear();
}
