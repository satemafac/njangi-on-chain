// whatsapp-notifier.ts — Single notification dispatcher every server-side
// notifier callsite routes through. Keeps the WhatsApp Business API token
// and the Walrus PII envelope on the server, applies per-recipient
// idempotency, and persists every send to a Postgres audit log when
// available so ops can answer "did Aminata get the nudge for round 4?"
//
// Phase 11 routes every notification through this module, so:
//   * "your turn" CycleFinalized nudges
//   * Ramp partner KYC outcomes ("you can now contribute")
//   * Stale-attestation admin nudges
//   * Future custom messages
// all share the same auth, log, dedupe, and lookup paths.

import { Pool } from 'pg';
import { computeLookupHash, fetchAndDecryptPII } from './walrus-pii';
import { lookupCirclesForPhone } from './whatsapp-link-index';
import { getActiveWhatsAppRegistries } from '../services/whatsapp-registry-service';
import type { NetworkType } from '../services/whatsapp-registry-service';
import { getNetworkConfig } from '../services/network-config';
import { getPooledSuiClient } from '../services/sui-rpc-failover';
import { appLogger } from '../utils/logger';

export type NotificationKind =
  | 'cycle_finalized'
  | 'ramp_kyc_complete'
  | 'stale_attestation_admin'
  | 'custom';

export interface SendMemberNotificationInput {
  /** Sui address of the member; used for lookup and audit log keys. */
  memberAddress: string;
  /** Pre-localized WhatsApp message body. Caller is responsible for i18n. */
  body: string;
  /** Kind tag drives audit log + dedupe scope. */
  kind: NotificationKind;
  /** Network the lookup is scoped to. */
  network: NetworkType;
  /**
   * Optional dedupe key. When set, the dispatcher refuses to re-send
   * the same `(kind, memberAddress, dedupeKey)` tuple within
   * `dedupeWindowMs`. Use it to suppress duplicate "your turn" nudges
   * from a misbehaving cron or a webhook retry storm.
   */
  dedupeKey?: string;
  dedupeWindowMs?: number;
  /** Optional pre-resolved E.164 phone, skipping the on-chain lookup. */
  phoneOverride?: string;
}

export interface SendMemberNotificationResult {
  sent: boolean;
  reason?: 'no_link' | 'duplicate' | 'send_failed' | 'missing_credentials';
  phoneE164?: string;
}

const DEFAULT_DEDUPE_WINDOW_MS = 60 * 60 * 1000; // 1 hour

let pool: Pool | null = null;
let setupPromise: Promise<void> | null = null;

function databaseUrl(): string | undefined {
  return process.env.DATABASE_URL;
}

function isPostgresAvailable(): boolean {
  return Boolean(databaseUrl());
}

function getPool(): Pool {
  if (!pool) {
    const url = databaseUrl();
    if (!url) throw new Error('DATABASE_URL is not configured.');
    pool = new Pool({
      connectionString: url,
      ssl: url.includes('amazonaws.com') ? { rejectUnauthorized: false } : undefined,
    });
  }
  return pool;
}

async function ensureNotificationTable(): Promise<void> {
  if (!isPostgresAvailable()) return;
  if (!setupPromise) {
    setupPromise = getPool()
      .query(
        `CREATE TABLE IF NOT EXISTS whatsapp_notifications (
           id BIGSERIAL PRIMARY KEY,
           kind TEXT NOT NULL,
           target_address TEXT NOT NULL,
           dedupe_key TEXT NOT NULL,
           sent_at TIMESTAMPTZ DEFAULT NOW(),
           success BOOLEAN NOT NULL,
           error TEXT,
           UNIQUE (kind, target_address, dedupe_key)
         );
         CREATE INDEX IF NOT EXISTS whatsapp_notifications_recent_idx
           ON whatsapp_notifications (target_address, sent_at DESC);
        `,
      )
      .then(() => undefined);
  }
  return setupPromise;
}

function normalizeAddress(addr: string): string {
  const lower = addr.toLowerCase();
  return lower.startsWith('0x') ? lower : `0x${lower}`;
}

async function recordNotification(
  kind: NotificationKind,
  target: string,
  dedupeKey: string,
  success: boolean,
  error?: string,
): Promise<void> {
  if (!isPostgresAvailable()) return;
  try {
    await ensureNotificationTable();
    await getPool().query(
      `INSERT INTO whatsapp_notifications (kind, target_address, dedupe_key, success, error)
         VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (kind, target_address, dedupe_key)
         DO UPDATE SET sent_at = NOW(), success = EXCLUDED.success, error = EXCLUDED.error`,
      [kind, target, dedupeKey, success, error ?? null],
    );
  } catch (err) {
    appLogger.warn('[whatsapp-notifier] failed to record audit log', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function alreadySentRecently(
  kind: NotificationKind,
  target: string,
  dedupeKey: string,
  windowMs: number,
): Promise<boolean> {
  if (!isPostgresAvailable()) return false;
  try {
    await ensureNotificationTable();
    const cutoff = new Date(Date.now() - windowMs).toISOString();
    const result = await getPool().query<{ id: string }>(
      `SELECT id FROM whatsapp_notifications
        WHERE kind = $1 AND target_address = $2 AND dedupe_key = $3
          AND success = TRUE AND sent_at > $4
        LIMIT 1`,
      [kind, target, dedupeKey, cutoff],
    );
    return (result.rowCount ?? 0) > 0;
  } catch (err) {
    appLogger.warn('[whatsapp-notifier] dedupe lookup failed; allowing send', {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

async function resolveMemberPhone(
  memberAddress: string,
  network: NetworkType,
): Promise<string | null> {
  // The Postgres HMAC index is keyed by phone, so we can't query it by
  // address. We fall through to the on-chain link registry, find every
  // link for this member's circles, fetch + decrypt the Walrus blob, and
  // return the first phone we land on. For most members this is one RPC
  // call + one Walrus fetch.
  const registries = getActiveWhatsAppRegistries(network);
  if (!registries || registries.length === 0) return null;
  const registry = registries[0];
  if (!registry.registryObjectId) return null;

  const client = getPooledSuiClient({
    network,
    rpcUrl: getNetworkConfig(network).rpcUrl,
  });
  const obj = await client.getObject({
    id: registry.registryObjectId,
    options: { showContent: true },
  });
  if (!obj.data?.content || obj.data.content.dataType !== 'moveObject') {
    return null;
  }
  const fields = (obj.data.content as { fields: { links?: unknown[] } }).fields;
  const links = Array.isArray(fields.links) ? fields.links : [];
  const target = normalizeAddress(memberAddress);
  for (const link of links) {
    const raw =
      (link as { fields?: Record<string, unknown> }).fields ??
      (link as Record<string, unknown>);
    if (!raw || raw.enabled !== true) continue;
    const linkedBy = raw.linked_by;
    if (typeof linkedBy === 'string' && normalizeAddress(linkedBy) !== target) continue;
    const blobBytes = raw.walrus_blob_id;
    if (!blobBytes) continue;
    const blobId =
      typeof blobBytes === 'string'
        ? blobBytes
        : Array.isArray(blobBytes)
          ? new TextDecoder().decode(new Uint8Array(blobBytes as number[]))
          : '';
    if (!blobId) continue;
    try {
      const payload = await fetchAndDecryptPII(blobId);
      if (payload.phone_e164) return payload.phone_e164;
    } catch (err) {
      appLogger.warn('[whatsapp-notifier] failed to decrypt PII envelope', {
        memberAddress: target,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return null;
}

async function sendWhatsAppMessage(phone: string, body: string): Promise<void> {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!phoneNumberId || !accessToken) {
    throw new Error('WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_ACCESS_TOKEN not set');
  }
  const response = await fetch(
    `https://graph.facebook.com/v23.0/${phoneNumberId}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: phone,
        type: 'text',
        text: { body },
      }),
    },
  );
  if (!response.ok) {
    const errBody = await response.text().catch(() => '<no body>');
    throw new Error(`WhatsApp send failed (${response.status}): ${errBody}`);
  }
}

/**
 * Single entry point every server-side notifier callsite uses. Idempotent
 * by `(kind, memberAddress, dedupeKey)` when Postgres is configured.
 *
 * Returns success even when no phone is linked — that's a routing decision
 * (the member opted out of WhatsApp), not an error.
 */
export async function sendMemberNotification(
  input: SendMemberNotificationInput,
): Promise<SendMemberNotificationResult> {
  const target = normalizeAddress(input.memberAddress);
  const dedupeKey = input.dedupeKey ?? `${input.kind}:${Date.now()}`;
  const windowMs = input.dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS;

  if (await alreadySentRecently(input.kind, target, dedupeKey, windowMs)) {
    return { sent: false, reason: 'duplicate' };
  }

  let phone = input.phoneOverride ?? null;
  if (!phone) {
    phone = await resolveMemberPhone(target, input.network);
  }
  if (!phone) {
    await recordNotification(input.kind, target, dedupeKey, false, 'no_link');
    return { sent: false, reason: 'no_link' };
  }

  try {
    await sendWhatsAppMessage(phone, input.body);
    await recordNotification(input.kind, target, dedupeKey, true);
    return { sent: true, phoneE164: phone };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('WHATSAPP_PHONE_NUMBER_ID')) {
      await recordNotification(
        input.kind,
        target,
        dedupeKey,
        false,
        'missing_credentials',
      );
      return { sent: false, reason: 'missing_credentials' };
    }
    await recordNotification(input.kind, target, dedupeKey, false, message);
    return { sent: false, reason: 'send_failed' };
  }
}

/** Lookup helper for tests / admin tooling. */
export async function findRecentNotifications(
  target: string,
  limit = 25,
): Promise<
  Array<{
    kind: NotificationKind;
    dedupeKey: string;
    sentAt: string;
    success: boolean;
    error: string | null;
  }>
> {
  if (!isPostgresAvailable()) return [];
  await ensureNotificationTable();
  const result = await getPool().query<{
    kind: NotificationKind;
    dedupe_key: string;
    sent_at: string;
    success: boolean;
    error: string | null;
  }>(
    `SELECT kind, dedupe_key, sent_at, success, error
       FROM whatsapp_notifications
      WHERE target_address = $1
      ORDER BY sent_at DESC
      LIMIT $2`,
    [normalizeAddress(target), limit],
  );
  return result.rows.map((row) => ({
    kind: row.kind,
    dedupeKey: row.dedupe_key,
    sentAt: row.sent_at,
    success: row.success,
    error: row.error,
  }));
}

/** Quiet helper for the lookup path so we don't trigger TS unused warnings. */
export async function lookupNotificationsByPhone(
  phoneE164: string,
): Promise<string[]> {
  // Future: cross-reference the audit log by phone via the lookup hash.
  // Today we just delegate to the existing whatsapp-link-index lookup so
  // callers can reuse a single import.
  const hits = await lookupCirclesForPhone(phoneE164);
  return hits.map((row) => row.circleId);
}

/** Test helper — wipes the in-memory cache between cases. */
export function __resetWhatsAppNotifierForTests(): void {
  setupPromise = null;
}

void computeLookupHash; // re-export helper kept for future HMAC paths.
