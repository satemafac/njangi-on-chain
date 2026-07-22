// cron-event-probe.ts — Sui-first "is there any work?" probe for the
// event-polling crons (cycle-finalized, whatsapp-circle-events).
//
// Why this exists: both crons used to open Postgres (fenced lease +
// cursor) on EVERY tick before checking whether any event needed
// processing. On Neon that meant the database could never autosuspend —
// an always-awake endpoint burns ~180 compute-hours/month, which
// exhausted the free-tier quota mid-month and took every DB-backed
// feature (including login) down with it on 2026-07-21.
//
// The probe asks Sui — a free RPC read that touches no Postgres —
// for the NEWEST event of the stream's type. Only when that event is
// recent (within the lookback horizon) does the cron proceed to the
// lease + cursor machinery. On a quiet network, ticks become DB-free
// no-ops and Neon sleeps.
//
// Correctness valves:
// - The lookback (default 25h) exceeds the nudge-worthiness window
//   (maxEventAgeMs, default 24h), so any event that could still produce
//   a notification always triggers a full pass.
// - Callers force a full pass on the first tick of each hour regardless
//   of the probe (see isHourlyFullPassTick), so cursors can never stall
//   behind the early-exit — old events are drained and cursor-advanced
//   within the hour even when nothing recent exists.
// - A probe FAILURE runs the full pass (fail toward correctness, not
//   toward compute savings).

import type { SuiClient } from '@mysten/sui/client';

export const DEFAULT_PROBE_LOOKBACK_MS = 25 * 60 * 60 * 1000;

export function probeLookbackMs(): number {
  const parsed = Number(process.env.CRON_EVENT_PROBE_LOOKBACK_MS ?? '');
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PROBE_LOOKBACK_MS;
}

/**
 * True on the first tick of each hour (cadence is 15-minute, so minute 0
 * is exactly one tick). Full passes on these ticks are unconditional.
 */
export function isHourlyFullPassTick(now: Date = new Date()): boolean {
  return now.getUTCMinutes() < 15;
}

export interface EventProbeResult {
  runFullPass: boolean;
  reason: 'forced_full_pass' | 'recent_event' | 'no_recent_events' | 'probe_failed';
  newestEventMs: number | null;
}

/**
 * Decides whether a polling cron should proceed to its Postgres-backed
 * full pass. Call BEFORE any lease/cursor access.
 */
export async function probeForRecentEvents(opts: {
  client: Pick<SuiClient, 'queryEvents'>;
  eventType: string;
  lookbackMs?: number;
  forceFullPass?: boolean;
  now?: number;
}): Promise<EventProbeResult> {
  const { client, eventType, forceFullPass = false } = opts;
  const lookbackMs = opts.lookbackMs ?? probeLookbackMs();
  const now = opts.now ?? Date.now();

  if (forceFullPass) {
    return { runFullPass: true, reason: 'forced_full_pass', newestEventMs: null };
  }

  try {
    const page = await client.queryEvents({
      query: { MoveEventType: eventType },
      limit: 1,
      order: 'descending',
    });
    const newest = page.data[0];
    const newestEventMs =
      newest && newest.timestampMs != null ? Number(newest.timestampMs) : null;
    if (newestEventMs != null && now - newestEventMs <= lookbackMs) {
      return { runFullPass: true, reason: 'recent_event', newestEventMs };
    }
    return { runFullPass: false, reason: 'no_recent_events', newestEventMs };
  } catch (err) {
    console.warn(
      `[cron-event-probe] probe failed for ${eventType} — running the full pass (fail toward correctness)`,
      err,
    );
    return { runFullPass: true, reason: 'probe_failed', newestEventMs: null };
  }
}
