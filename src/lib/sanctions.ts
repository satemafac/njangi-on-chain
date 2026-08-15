// sanctions.ts — OFAC SDN digital-currency address screening
// (docs/compliance-roadmap-cex-dex-non-kyc.md §A1; operating procedures in
// docs/sanctions-program.md).
//
// Server-only: pulls in the pg pool. Edge middleware must import
// src/lib/embargo.ts instead.
//
// The enforcement path depends ONLY on the authoritative source
// (treasury.gov). An optional public mirror can be configured as a
// read-only cross-check — it is never ingested; a large divergence just
// logs loudly so parser drift is noticed.
//
// Fail mode: the CALLER chooses, because the right answer differs by what
// is at stake (see ScreenOptions.failClosed).
//
//   NEW COMMITMENTS (create, join, escrow open, ramp session) pass
//   `failClosed: true`. If screening cannot run, the action is refused. A
//   new commitment can wait for the screen to come back; letting one
//   through unscreened cannot be undone.
//
//   EXISTING EXPOSURE (claim, refund, recovery) and LOGIN fail OPEN, as
//   before. Failing those closed during an outage would strand a member's
//   already-committed funds — a worse compliance outcome than a delayed
//   screen, and precisely the "kill switch that traps money" this codebase
//   avoids elsewhere. The 2026-07-21 Neon outage is the concrete case: a
//   fail-closed login would have locked every user out of their own funds
//   for twelve days.
//
// A positive hit is ALWAYS blocking, in both modes.
//
// Compensations for the remaining fail-open surface: every one logs
// loudly (Vercel log drain is the evidence trail), pass/fail-open
// decisions are recorded in sanctions_screen_log, and the weekly cron
// retro-sweeps recent rows against the fresh list so anything that slipped
// through an outage or a between-refresh listing is detected and handled
// per docs/incident-playbook.md.

import { createHash } from 'crypto';
import { getSharedPgPool, isPostgresConfigured } from './pg-pool';

export type ScreenContext =
  | 'circle_create'
  | 'circle_join'
  | 'whatsapp_link'
  | 'client_preflight'
  | 'retro_sweep'
  // Proof issuance — the one server-controlled step every user must pass.
  // Once transactions are signed in the browser there is no server choke
  // point left on the money paths, so refusing to mint zkProofs is the
  // enforcement of last resort: no proof, no signature, nothing on chain.
  | 'proof_issuance'
  | 'ramp_session';

export interface ScreenResult {
  blocked: boolean;
  listVersion: string | null;
  /**
   * Why the caller was blocked. 'hit' is a real SDN match; 'unavailable'
   * means screening could not be performed and the caller asked to fail
   * closed. Callers surface these differently — a match is final, an
   * outage is "try again shortly".
   */
  reason?: 'hit' | 'unavailable';
}

export interface ScreenOptions {
  /**
   * Block when screening CANNOT be performed (flag off, no Postgres, list
   * not loaded, query error) instead of allowing.
   *
   * Use for NEW COMMITMENTS — creating or joining a circle, opening an
   * escrow, starting a ramp session. Those can wait for the screen to come
   * back; letting one through unscreened cannot be undone.
   *
   * Do NOT use for claim, refund, recovery, or login. Those move funds that
   * are already committed, and failing them closed during an outage would
   * trap a member's money — a worse compliance outcome than a delayed
   * screen. That asymmetry is the whole design: block new exposure, never
   * strand existing exposure.
   */
  failClosed?: boolean;
}

const SDN_CSV_URL_DEFAULT = 'https://www.treasury.gov/ofac/downloads/sdn.csv';

// Matches OFAC remarks entries like:
//   Digital Currency Address - XBT 1AjZPMsnmpdK2Rv9KQNfMurTXinscVro9V
//   Digital Currency Address - ETH 0x7f367cc41522ce07553e823bf3be79a889debe1b
const DIGITAL_CURRENCY_ADDRESS_RE =
  /Digital Currency Address - ([A-Z0-9]{2,6})\s+([a-zA-Z0-9]{20,100})/g;

let warnedNotConfigured = false;

/**
 * Default-ON: screening runs unless the flag is explicitly the string
 * "false". A sanctions control must never be silently opt-in — an unset
 * var in production means ON. (The billing/compliance flags default OFF;
 * this one deliberately does not.)
 */
export function isSanctionsScreeningEnabled(): boolean {
  return (process.env.SANCTIONS_SCREENING_ENABLED ?? 'true').toLowerCase() !== 'false';
}

/**
 * Normalizes an input address into the candidate forms we look up:
 * trimmed lowercase verbatim, plus — for 0x-hex inputs shorter than the
 * canonical 32-byte Sui form — the left-zero-padded 66-char form (the
 * join-request schema accepts unpadded addresses, and the stored side is
 * normalized lowercase verbatim from OFAC).
 */
export function normalizeScreeningAddress(raw: string): string[] {
  const base = (raw ?? '').trim().toLowerCase();
  if (!base) return [];
  const candidates = new Set([base]);
  const hexMatch = /^0x([0-9a-f]+)$/.exec(base);
  if (hexMatch && hexMatch[1].length < 64) {
    candidates.add(`0x${hexMatch[1].padStart(64, '0')}`);
  }
  return Array.from(candidates);
}

export class SanctionsBlockedError extends Error {
  readonly code = 'SANCTIONS_BLOCKED' as const;

  constructor() {
    super("This wallet can't use Njangi On-Chain.");
    this.name = 'SanctionsBlockedError';
  }
}

/**
 * Stable JSON body for the 403 response. Deliberately neutral copy —
 * no OFAC/sanctions wording user-side; the `code` and the
 * sanctions_screen_log rows carry the real reason for ops.
 */
export function sanctionsErrorBody(): {
  success: false;
  error: 'SANCTIONS_BLOCKED';
  code: 'SANCTIONS_BLOCKED';
  message: string;
} {
  return {
    success: false,
    error: 'SANCTIONS_BLOCKED',
    code: 'SANCTIONS_BLOCKED',
    message: "This wallet can't use Njangi On-Chain.",
  };
}

function logScreenRow(
  address: string,
  context: ScreenContext,
  result: 'pass' | 'blocked' | 'error_fail_open',
  listVersion: string | null,
): Promise<void> {
  return getSharedPgPool()
    .query(
      `INSERT INTO sanctions_screen_log (address, context, result, list_version)
       VALUES ($1, $2, $3, $4)`,
      [address, context, result, listVersion],
    )
    .then(() => undefined);
}

/**
 * Screens a wallet address against the cached OFAC digital-currency set.
 * One indexed lookup. Callers at the server choke points translate
 * `blocked: true` into a 403 `sanctionsErrorBody()` BEFORE any side
 * effect (DB write, Walrus upload, transaction build).
 */
export async function screenAddress(
  address: string,
  context: ScreenContext,
  options: ScreenOptions = {},
): Promise<ScreenResult> {
  const failClosed = options.failClosed === true;
  // One place decides what "screening could not run" means, so the four
  // unavailability branches below can never drift apart.
  // `loud` marks the cases that belong in the evidence trail: an outage or a
  // missing list is an incident. A deliberately-off flag or a malformed
  // address is not, and logging those on every call would bury the real ones.
  const unavailable = (why: string, loud = true): ScreenResult => {
    if (failClosed) {
      console.error(`[sanctions] FAIL-CLOSED at ${context}: ${why}`);
      return { blocked: true, listVersion: null, reason: 'unavailable' };
    }
    if (loud) {
      console.error(`[sanctions] FAIL-OPEN at ${context}: ${why}`);
    }
    return { blocked: false, listVersion: null };
  };

  if (!isSanctionsScreeningEnabled()) {
    return unavailable('screening disabled by flag', false);
  }
  if (!isPostgresConfigured()) {
    if (!warnedNotConfigured) {
      warnedNotConfigured = true;
      console.warn(
        '[sanctions] Postgres not configured — screening skipped (local dev only; production must set DATABASE_URL)',
      );
    }
    return unavailable('Postgres not configured', false);
  }

  const candidates = normalizeScreeningAddress(address);
  if (candidates.length === 0) {
    // An unparseable address is not a pass. Under failClosed this is a
    // malformed request, not a screened one.
    return unavailable('address could not be normalized', false);
  }
  const normalized = candidates[0];

  try {
    const hit = await getSharedPgPool().query<{ list_version: string }>(
      `SELECT list_version FROM sanctioned_addresses WHERE address = ANY($1) LIMIT 1`,
      [candidates],
    );

    if ((hit.rowCount ?? 0) > 0) {
      const listVersion = hit.rows[0].list_version;
      // Blocking is never contingent on the audit write succeeding.
      try {
        await logScreenRow(normalized, context, 'blocked', listVersion);
      } catch (logErr) {
        console.error('[sanctions] failed to record BLOCKED screen', logErr);
      }
      console.error(
        `[sanctions] BLOCKED address at ${context} (list ${listVersion}) — see docs/incident-playbook.md`,
      );
      return { blocked: true, listVersion, reason: 'hit' };
    }

    const meta = await getSharedPgPool().query<{ list_version: string }>(
      `SELECT list_version FROM sanctions_list_meta WHERE id = 1`,
    );
    const listVersion = meta.rows[0]?.list_version ?? null;
    if (!listVersion) {
      // An empty list matches nothing, so "no hit" here means "not screened".
      void logScreenRow(normalized, context, 'error_fail_open', null).catch(() => {});
      return unavailable(
        'list not loaded yet — run the bootstrap step in docs/sanctions-program.md',
      );
    }
    // Pass rows feed the weekly retro-sweep; never fail the user action
    // over an audit write.
    void logScreenRow(normalized, context, 'pass', listVersion).catch((logErr) =>
      console.error('[sanctions] failed to record pass screen', logErr),
    );
    return { blocked: false, listVersion };
  } catch (err) {
    // Logged here rather than in `unavailable` so the error object rides
    // along with the message.
    console.error(
      `[sanctions] ${failClosed ? 'FAIL-CLOSED' : 'FAIL-OPEN'} at ${context}: screening query failed`,
      err,
    );
    void logScreenRow(normalized, context, 'error_fail_open', null).catch(() => {});
    return unavailable('screening query failed', false);
  }
}

/** Convenience: throws SanctionsBlockedError when the screen hits. */
export async function assertNotSanctioned(
  address: string,
  context: ScreenContext,
): Promise<void> {
  const { blocked } = await screenAddress(address, context);
  if (blocked) {
    throw new SanctionsBlockedError();
  }
}

// ---------------------------------------------------------------------------
// Weekly refresh (cron) — fetch, parse, upsert + prune, cross-check
// ---------------------------------------------------------------------------

export interface ParsedSdnEntry {
  ticker: string;
  address: string;
}

/** Exposed for tests: extracts every digital-currency entry from raw CSV text. */
export function parseDigitalCurrencyAddresses(csvText: string): ParsedSdnEntry[] {
  const out: ParsedSdnEntry[] = [];
  const seen = new Set<string>();
  for (const match of csvText.matchAll(DIGITAL_CURRENCY_ADDRESS_RE)) {
    const ticker = match[1];
    const address = match[2];
    const key = address.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ticker, address });
  }
  return out;
}

function minAddressFloor(): number {
  const parsed = Number(process.env.SANCTIONS_MIN_ADDRESS_FLOOR ?? '100');
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 100;
}

export interface RefreshResult {
  listVersion: string;
  count: number;
  skipped: boolean;
}

/**
 * Fetches the authoritative SDN CSV and replaces the cached address set:
 * batched upsert (preserves first_seen) + prune of delisted rows + meta
 * upsert, all in one transaction so readers never observe an empty
 * table. Guards: content-hash short-circuit (idempotent re-runs) and a
 * floor guard — a truncated download must never wipe the list.
 */
export async function refreshSanctionsList(): Promise<RefreshResult> {
  const sourceUrl = process.env.SANCTIONS_SDN_CSV_URL || SDN_CSV_URL_DEFAULT;
  const response = await fetch(sourceUrl);
  if (!response.ok) {
    throw new Error(`SDN fetch failed: HTTP ${response.status} from ${sourceUrl}`);
  }
  const csvText = await response.text();
  const hash = createHash('sha256').update(csvText).digest('hex').slice(0, 12);
  const listVersion = `${new Date().toISOString().slice(0, 10)}:${hash}`;

  const pool = getSharedPgPool();
  const currentMeta = await pool.query<{ list_version: string; address_count: number }>(
    `SELECT list_version, address_count FROM sanctions_list_meta WHERE id = 1`,
  );
  const current = currentMeta.rows[0] ?? null;
  if (current && current.list_version.endsWith(`:${hash}`)) {
    return { listVersion: current.list_version, count: current.address_count, skipped: true };
  }

  const entries = parseDigitalCurrencyAddresses(csvText);
  const floor = minAddressFloor();
  if (entries.length < floor || (current && entries.length < current.address_count * 0.5)) {
    throw new Error(
      `[sanctions] refresh ABORTED: parsed ${entries.length} addresses ` +
        `(floor ${floor}, previous ${current?.address_count ?? 'n/a'}) — keeping last-good list`,
    );
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const batchSize = 500;
    for (let i = 0; i < entries.length; i += batchSize) {
      const batch = entries.slice(i, i + batchSize);
      const values: string[] = [];
      const params: string[] = [];
      batch.forEach((entry, idx) => {
        const base = idx * 4;
        values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`);
        params.push(entry.address.toLowerCase(), entry.address, entry.ticker, listVersion);
      });
      await client.query(
        `INSERT INTO sanctioned_addresses (address, address_original, ticker, list_version)
         VALUES ${values.join(', ')}
         ON CONFLICT (address) DO UPDATE
           SET list_version = EXCLUDED.list_version,
               ticker = EXCLUDED.ticker,
               last_seen = NOW()`,
        params,
      );
    }
    await client.query(`DELETE FROM sanctioned_addresses WHERE list_version <> $1`, [
      listVersion,
    ]);
    await client.query(
      `INSERT INTO sanctions_list_meta (id, list_version, source_url, address_count, refreshed_at)
       VALUES (1, $1, $2, $3, NOW())
       ON CONFLICT (id) DO UPDATE
         SET list_version = EXCLUDED.list_version,
             source_url = EXCLUDED.source_url,
             address_count = EXCLUDED.address_count,
             refreshed_at = NOW()`,
      [listVersion, sourceUrl, entries.length],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  await crossCheckMirror(entries.length);

  return { listVersion, count: entries.length, skipped: false };
}

/**
 * Read-only comparison against an optional public mirror. NEVER ingested
 * — a >10% divergence only logs, so parser drift (e.g. OFAC changing the
 * remarks format) gets noticed at the next refresh.
 */
async function crossCheckMirror(ourCount: number): Promise<void> {
  const mirrorUrl = process.env.SANCTIONS_MIRROR_CROSSCHECK_URL;
  if (!mirrorUrl) return;
  try {
    const response = await fetch(mirrorUrl);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    const mirrorCount = text.split('\n').filter((line) => line.trim().length > 0).length;
    if (mirrorCount > 0 && Math.abs(mirrorCount - ourCount) / mirrorCount > 0.1) {
      console.error(
        `[sanctions] CROSS-CHECK DIVERGENCE: parsed ${ourCount} vs mirror ${mirrorCount} — inspect the SDN parser`,
      );
    }
  } catch (err) {
    console.warn('[sanctions] mirror cross-check unavailable (non-blocking)', err);
  }
}

/**
 * Detect-and-respond compensation for fail-open screening: joins recent
 * pass/fail-open screen-log rows against the (fresh) sanctioned set. Any
 * hit means an address slipped through an outage window or was listed
 * after we screened it — escalate per docs/incident-playbook.md.
 */
export async function retroSweepRecentScreens(days = 30): Promise<{ hits: number }> {
  const pool = getSharedPgPool();
  const result = await pool.query<{ address: string }>(
    `SELECT DISTINCT l.address
       FROM sanctions_screen_log l
       JOIN sanctioned_addresses s ON s.address = l.address
      WHERE l.created_at > NOW() - ($1 || ' days')::interval
        AND l.result IN ('pass', 'error_fail_open')`,
    [String(days)],
  );
  for (const row of result.rows) {
    console.error(
      `[sanctions] RETRO-SWEEP HIT: previously passed address is now on the SDN list — follow docs/incident-playbook.md`,
    );
    await logScreenRow(row.address, 'retro_sweep', 'blocked', null).catch(() => {});
  }
  return { hits: result.rowCount ?? 0 };
}
