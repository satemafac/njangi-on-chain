// webhook-dedupe.ts — Shared idempotency guard for fiat-ramp webhooks.
//
// Providers (Coinbase, MoonPay, Transak) retry webhook delivery on non-2xx
// and on timeout, so every handler needs "have I seen this event?" before
// side effects (attestation enqueue, WhatsApp notification). The Coinbase
// handler used an in-memory Map for this, which on serverless deduplicates
// nothing across instances. When DATABASE_URL is configured the registry
// now records events in the `webhook_events` table; the unique
// (provider, event_id) constraint makes the check race-free across
// concurrent deliveries. Without DATABASE_URL (dev) a TTL'd in-memory map
// preserves the old behaviour.

import { getSharedPgPool, isPostgresConfigured } from './pg-pool';

const MEMORY_TTL_MS = 60 * 60 * 1000; // 1 hour, matches the old Coinbase cache
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // keep rows a week for audit/debug

const memoryCache = new Map<string, number>();

let setupPromise: Promise<void> | null = null;

function ensureTable(): Promise<void> {
  if (!setupPromise) {
    setupPromise = getSharedPgPool()
      .query(
        `CREATE TABLE IF NOT EXISTS webhook_events (
           id BIGSERIAL PRIMARY KEY,
           provider TEXT NOT NULL,
           event_id TEXT NOT NULL,
           received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           UNIQUE (provider, event_id)
         );
         CREATE INDEX IF NOT EXISTS webhook_events_received_idx
           ON webhook_events (received_at);`,
      )
      .then(() => undefined)
      .catch((err) => {
        setupPromise = null;
        throw err;
      });
  }
  return setupPromise;
}

function registerInMemory(provider: string, eventId: string): boolean {
  const key = `${provider}:${eventId}`;
  const now = Date.now();
  for (const [cachedKey, timestamp] of memoryCache.entries()) {
    if (now - timestamp >= MEMORY_TTL_MS) {
      memoryCache.delete(cachedKey);
    }
  }
  if (memoryCache.has(key)) {
    return true;
  }
  memoryCache.set(key, now);
  return false;
}

/**
 * Records a webhook event and reports whether it was already processed.
 * Returns `true` when the (provider, eventId) pair was seen before —
 * callers should skip side effects but still acknowledge the delivery.
 *
 * Fails open (treats the event as new) if Postgres errors: a missed dedupe
 * re-runs an idempotent-ish side effect, whereas failing closed would drop
 * real events.
 */
export async function registerWebhookEvent(
  provider: string,
  eventId: string,
): Promise<boolean> {
  if (!isPostgresConfigured()) {
    return registerInMemory(provider, eventId);
  }

  try {
    await ensureTable();
    const result = await getSharedPgPool().query(
      `WITH gc AS (
         DELETE FROM webhook_events
          WHERE received_at < NOW() - ($3 || ' milliseconds')::interval
       )
       INSERT INTO webhook_events (provider, event_id)
       VALUES ($1, $2)
       ON CONFLICT (provider, event_id) DO NOTHING
       RETURNING id`,
      [provider, eventId, String(RETENTION_MS)],
    );
    // No row returned → the unique constraint swallowed the insert →
    // this event was already recorded.
    return result.rows.length === 0;
  } catch (err) {
    console.warn(
      '[webhook-dedupe] Postgres dedupe failed; treating event as new:',
      err instanceof Error ? err.message : err,
    );
    return registerInMemory(provider, eventId);
  }
}

/**
 * Releases a previously registered event so the provider's retry can re-run
 * the side effect. Call this when the side effect failed AFTER
 * `registerWebhookEvent` claimed the delivery: the claim row was written
 * before the effect (required to suppress concurrent duplicate deliveries),
 * so on failure it must be rolled back — otherwise the durable row would
 * swallow the provider's retry and the work would be lost permanently.
 *
 * Best-effort: if the release itself fails, the retry is treated as a
 * duplicate (the pre-claim/rollback behaviour) and we only lose this one
 * recovery opportunity, so the error is logged rather than rethrown.
 */
export async function unregisterWebhookEvent(
  provider: string,
  eventId: string,
): Promise<void> {
  // The memory cache may hold the claim even in Postgres mode (fail-open
  // fallback inside registerWebhookEvent), so always clear it.
  memoryCache.delete(`${provider}:${eventId}`);

  if (!isPostgresConfigured()) {
    return;
  }

  try {
    await ensureTable();
    await getSharedPgPool().query(
      `DELETE FROM webhook_events WHERE provider = $1 AND event_id = $2`,
      [provider, eventId],
    );
  } catch (err) {
    console.warn(
      '[webhook-dedupe] failed to release event claim; provider retry will be treated as duplicate:',
      err instanceof Error ? err.message : err,
    );
  }
}

/** Test helper — clears in-memory state between cases. */
export function __resetWebhookDedupeForTests(): void {
  memoryCache.clear();
  setupPromise = null;
}
