// zklogin-address-bindings.ts — durable identity→address history, and the
// drift detection built on it.
//
// WHY THIS EXISTS
//
// A zkLogin address is derived from (iss, aud, sub, salt). Three of those
// can change without the user doing anything:
//
//   salt — supplied by Enoki, and it changes when the API key is rotated,
//          even within the same application (see CLAUDE.md for the testnet
//          evidence: same Google account, same sub, same client id, same
//          app — only the live key moved, and the address moved with it).
//   aud  — the OAuth client id.
//   iss  — swapping the provider entry entirely.
//
// When any of them changes, the same human signs in and gets a DIFFERENT
// address. Their circles, deposits and funds stay at the old one, which no
// future login will ever reach. There is no error and no migration path.
//
// It was silent because the code deleted the evidence: every successful
// login calls cleanupUserSessions -> deleteZkLoginSessionsForUser, and
// zklogin_sessions carries a 24h TTL, so the previous address was gone
// before the next one was derived. Nothing retained a durable history.
//
// DETECTION KEY: (iss, sub) — NOT (sub, aud).
//
// This is the load-bearing design decision. A client-id change IS one of
// the three drift causes, so keying on aud would make that exact case look
// like a brand-new user and miss it entirely. (iss, sub) is the
// OIDC-canonical stable identity: "have we ever seen this human before,
// under any client id or salt?"
//
// Rows written before iss capture have iss = NULL and fall back to
// `provider` ('Google' | 'Facebook' | 'Apple'), which is a faithful proxy.
//
// The table is APPEND-ONLY, like legal_acceptances. On a drift event both
// rows survive, so the old address stays visible to support instead of
// being overwritten by the new one.

import { getSharedPgPool, isPostgresConfigured } from './pg-pool';

export interface AddressBindingIdentity {
  /** JWT `iss`. May be undefined on legacy callers; `provider` covers it. */
  iss?: string | null;
  sub: string;
  aud: string;
  provider?: string | null;
  userAddress: string;
}

export interface KnownBinding {
  iss: string | null;
  aud: string;
  provider: string | null;
  userAddress: string;
  firstSeenAt: string;
  lastSeenAt: string;
  loginCount: number;
}

export type DriftStatus = 'first_seen' | 'known' | 'drifted' | 'unavailable';

export interface DriftResult {
  status: DriftStatus;
  /** True only for `drifted`. Convenience for call sites. */
  drifted: boolean;
  /** The address this login produced. */
  currentAddress: string;
  /**
   * Previously-seen addresses for this identity, most recently seen first,
   * excluding `currentAddress`. Empty unless status === 'drifted'.
   */
  previousAddresses: string[];
}

/**
 * Recorded when detection cannot run (no Postgres, query error).
 *
 * Deliberately NOT a block. This guard protects against a configuration
 * mistake; refusing every login because the bindings table is unreachable
 * would convert a detection outage into a total outage, and — worse — would
 * stand between users and their funds, which is the one thing this feature
 * must never do. An unavailable check is logged and allowed through.
 */
const UNAVAILABLE: Omit<DriftResult, 'currentAddress'> = {
  status: 'unavailable',
  drifted: false,
  previousAddresses: [],
};

let setupPromise: Promise<void> | null = null;

/**
 * Lazy self-creation, mirroring zklogin-session-registry.ts and
 * stripe-service.ts. scripts/migrate-postgres.mjs creates this table too;
 * this is the race guard for a fresh deploy that takes traffic before the
 * migration has run.
 */
function ensureTable(): Promise<void> {
  if (!setupPromise) {
    setupPromise = getSharedPgPool()
      .query(
        `CREATE TABLE IF NOT EXISTS zklogin_address_bindings (
           id            BIGSERIAL PRIMARY KEY,
           iss           TEXT,
           sub           TEXT NOT NULL,
           aud           TEXT NOT NULL,
           provider      TEXT,
           user_address  TEXT NOT NULL,
           first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           login_count   BIGINT NOT NULL DEFAULT 1
         );
         CREATE UNIQUE INDEX IF NOT EXISTS zklogin_address_bindings_unique
           ON zklogin_address_bindings (sub, aud, user_address);
         CREATE INDEX IF NOT EXISTS zklogin_address_bindings_identity
           ON zklogin_address_bindings (sub, iss);
         CREATE INDEX IF NOT EXISTS zklogin_address_bindings_provider_identity
           ON zklogin_address_bindings (sub, provider);`,
      )
      .then(() => undefined)
      .catch((err) => {
        // Allow a retry on the next call instead of caching the failure.
        setupPromise = null;
        throw err;
      });
  }
  return setupPromise;
}

/** Addresses are compared case-insensitively and trimmed, never re-derived. */
export function normalizeAddress(raw: string): string {
  return (raw ?? '').trim().toLowerCase();
}

/**
 * Every binding this human has ever had, newest activity first.
 *
 * Three match branches, and all three are load-bearing:
 *
 *   1. (iss, sub)            — the canonical case, once iss is captured.
 *   2. (provider, sub)       — rows written before iss capture, where the
 *                              provider was known.
 *   3. sub alone, when the row has NEITHER iss NOR provider — i.e. rows
 *      created by the migration backfill, which reads legal_acceptances /
 *      subscriptions. Neither table stores a provider, so without this
 *      branch every backfilled row would be invisible (`NULL = 'Google'`
 *      is NULL, never true) and the backfill would protect nobody.
 *
 * Branch 3 could in principle match two different humans who were issued
 * the same `sub` string by different providers. That is vanishingly
 * unlikely, and the asymmetry favours it: a false positive shows a warning
 * while fund access stays open, whereas a false negative is silent fund
 * loss. Err toward detecting.
 *
 * `aud` is deliberately NOT part of any branch — see the file header.
 */
export async function listKnownBindings(
  identity: Pick<AddressBindingIdentity, 'iss' | 'sub' | 'provider'>,
): Promise<KnownBinding[]> {
  await ensureTable();
  const { rows } = await getSharedPgPool().query(
    `SELECT iss, aud, provider, user_address, first_seen_at, last_seen_at, login_count
       FROM zklogin_address_bindings
      WHERE sub = $1
        AND (
          ($2::text IS NOT NULL AND iss = $2::text)
          OR ($3::text IS NOT NULL AND iss IS NULL AND provider = $3::text)
          OR (iss IS NULL AND provider IS NULL)
        )
      ORDER BY last_seen_at DESC`,
    [identity.sub, identity.iss ?? null, identity.provider ?? null],
  );

  return rows.map((row) => ({
    iss: row.iss ?? null,
    aud: row.aud,
    provider: row.provider ?? null,
    userAddress: row.user_address,
    firstSeenAt: new Date(row.first_seen_at).toISOString(),
    lastSeenAt: new Date(row.last_seen_at).toISOString(),
    loginCount: Number(row.login_count ?? 0),
  }));
}

/**
 * Appends the binding, or bumps last_seen_at/login_count if we already had
 * this exact (sub, aud, address). Never updates the address of an existing
 * row — a new address is a new row, which is what preserves the history.
 *
 * Also backfills `iss` on a row that predates iss capture, so a legacy row
 * upgrades itself the first time its owner signs in.
 */
export async function recordBinding(identity: AddressBindingIdentity): Promise<void> {
  await ensureTable();
  await getSharedPgPool().query(
    `INSERT INTO zklogin_address_bindings (iss, sub, aud, provider, user_address)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (sub, aud, user_address) DO UPDATE
       SET last_seen_at = NOW(),
           login_count  = zklogin_address_bindings.login_count + 1,
           iss          = COALESCE(zklogin_address_bindings.iss, EXCLUDED.iss),
           provider     = COALESCE(zklogin_address_bindings.provider, EXCLUDED.provider)`,
    [
      identity.iss ?? null,
      identity.sub,
      identity.aud,
      identity.provider ?? null,
      normalizeAddress(identity.userAddress),
    ],
  );
}

/**
 * The detection call. Records the binding as a side effect, so a caller
 * only needs this one function on the login path.
 *
 * MUST be called BEFORE cleanupUserSessions() in the callback handler —
 * that wipes prior session rows, and while this table is the durable
 * record, ordering it first keeps the two consistent if cleanup ever grows
 * to touch bindings.
 */
export async function checkAddressDrift(
  identity: AddressBindingIdentity,
): Promise<DriftResult> {
  const currentAddress = normalizeAddress(identity.userAddress);

  if (!isPostgresConfigured()) {
    // Dev without a database. Detection is impossible; say so rather than
    // reporting a clean result we did not actually verify.
    return { ...UNAVAILABLE, currentAddress };
  }

  try {
    const known = await listKnownBindings(identity);
    await recordBinding({ ...identity, userAddress: currentAddress });

    if (known.length === 0) {
      return {
        status: 'first_seen',
        drifted: false,
        currentAddress,
        previousAddresses: [],
      };
    }

    const previousAddresses = known
      .map((b) => b.userAddress)
      .filter((addr) => addr !== currentAddress);

    if (previousAddresses.length === 0) {
      return {
        status: 'known',
        drifted: false,
        currentAddress,
        previousAddresses: [],
      };
    }

    return {
      status: 'drifted',
      drifted: true,
      currentAddress,
      previousAddresses,
    };
  } catch (err) {
    console.error(
      '[address-drift] detection failed; allowing login unchecked. ' +
        'This is fail-open by design — see the header comment.',
      err,
    );
    return { ...UNAVAILABLE, currentAddress };
  }
}

/**
 * Read-only status for the authenticated session, used by the client gate
 * and by any commitment surface that needs to refuse.
 *
 * Does NOT write a binding — this is called on ordinary page loads, and
 * bumping login_count on every poll would corrupt the signal.
 */
export async function getDriftStatusForIdentity(
  identity: Pick<AddressBindingIdentity, 'iss' | 'sub' | 'provider' | 'userAddress'>,
): Promise<DriftResult> {
  const currentAddress = normalizeAddress(identity.userAddress);

  if (!isPostgresConfigured()) {
    return { ...UNAVAILABLE, currentAddress };
  }

  try {
    const known = await listKnownBindings(identity);
    if (known.length === 0) {
      return { status: 'first_seen', drifted: false, currentAddress, previousAddresses: [] };
    }

    const previousAddresses = known
      .map((b) => b.userAddress)
      .filter((addr) => addr !== currentAddress);

    return previousAddresses.length === 0
      ? { status: 'known', drifted: false, currentAddress, previousAddresses: [] }
      : { status: 'drifted', drifted: true, currentAddress, previousAddresses };
  } catch (err) {
    console.error('[address-drift] status lookup failed', err);
    return { ...UNAVAILABLE, currentAddress };
  }
}

// ---------------------------------------------------------------------------
// Operator alerting
//
// One user drifting is strange. Several drifting in an hour is a
// CONFIGURATION INCIDENT that will affect every user who signs in after it,
// so this needs to be loud and immediate rather than a metric someone reads
// on Monday. Response procedure: docs/incident-playbook.md.
// ---------------------------------------------------------------------------

/**
 * Fires on every drift event. Swallows its own errors unconditionally —
 * alerting must never be able to fail a login.
 */
export async function alertDrift(
  identity: Pick<AddressBindingIdentity, 'iss' | 'sub' | 'provider'>,
  result: DriftResult,
): Promise<void> {
  try {
    // `sub` is a stable user identifier; log a short digest rather than the
    // raw value so ops dashboards do not become an identity index.
    const subDigest = identity.sub ? `${identity.sub.slice(0, 6)}…` : 'unknown';

    console.error(
      '[address-drift] DRIFT DETECTED — a returning identity resolved to a new address. ' +
        'If this is happening to more than one user, an address-affecting env var or the ' +
        'Enoki key almost certainly changed; see docs/incident-playbook.md.',
      {
        provider: identity.provider ?? 'unknown',
        iss: identity.iss ?? null,
        subDigest,
        currentAddress: result.currentAddress,
        previousAddresses: result.previousAddresses,
      },
    );

    const Sentry = await import('@sentry/nextjs');
    Sentry.captureMessage('zkLogin address drift detected', {
      level: 'error',
      tags: {
        feature: 'address-drift',
        provider: identity.provider ?? 'unknown',
      },
      extra: {
        subDigest,
        iss: identity.iss ?? null,
        currentAddress: result.currentAddress,
        previousAddresses: result.previousAddresses,
        previousCount: result.previousAddresses.length,
      },
    });
  } catch (err) {
    console.error('[address-drift] alerting failed (login unaffected)', err);
  }
}

/**
 * How many identities have drifted recently — the "is this an incident or a
 * one-off?" question. Counts identities holding more than one distinct
 * address where the newest binding appeared inside the window.
 *
 * Derived from the bindings table rather than a separate event log, so
 * there is one source of truth and nothing to keep in sync.
 */
export async function countRecentDriftEvents(windowMs = 3_600_000): Promise<number> {
  if (!isPostgresConfigured()) return 0;
  try {
    await ensureTable();
    const { rows } = await getSharedPgPool().query(
      `SELECT COUNT(*)::int AS drifted
         FROM (
           SELECT sub, COALESCE(iss, provider) AS identity
             FROM zklogin_address_bindings
            GROUP BY sub, COALESCE(iss, provider)
           HAVING COUNT(DISTINCT user_address) > 1
              AND MAX(first_seen_at) > NOW() - ($1::bigint * INTERVAL '1 millisecond')
         ) AS drifted_identities`,
      [Math.max(0, Math.floor(windowMs))],
    );
    return Number(rows[0]?.drifted ?? 0);
  } catch (err) {
    console.error('[address-drift] recent-drift count failed', err);
    return 0;
  }
}

/**
 * Thrown by commitment surfaces (circle create/join, contribute, ramp
 * session, WhatsApp link) when the signed-in identity has drifted.
 *
 * NOT thrown on login, claim, refund, recovery or withdrawal. That split —
 * fail-closed on new commitments, fail-open on fund access — is copied
 * deliberately from src/lib/sanctions.ts, and the reasoning transfers
 * exactly: block new exposure, never strand existing exposure. A
 * configuration mistake must not become a lockout from one's own money.
 */
export class AddressDriftBlockedError extends Error {
  readonly code = 'ADDRESS_DRIFT_BLOCKED' as const;

  constructor(readonly previousAddresses: string[] = []) {
    super('This sign-in produced a different account than last time.');
    this.name = 'AddressDriftBlockedError';
  }
}

/** Stable 409 body. Neutral, non-blaming copy; ops detail lives in logs. */
export function addressDriftErrorBody(previousAddresses: string[] = []): {
  success: false;
  error: 'ADDRESS_DRIFT_BLOCKED';
  message: string;
  previousAddresses: string[];
} {
  return {
    success: false,
    error: 'ADDRESS_DRIFT_BLOCKED',
    message:
      'Signing in produced a different account than last time, so joining or ' +
      'contributing is paused while we sort this out. You can still collect a ' +
      'payout, request a refund, and take part in a recovery vote.',
    previousAddresses,
  };
}

/**
 * Refuses a new commitment when the identity has drifted.
 *
 * Fails OPEN when detection is unavailable, matching checkAddressDrift.
 */
export async function assertNoAddressDrift(
  identity: Pick<AddressBindingIdentity, 'iss' | 'sub' | 'provider' | 'userAddress'>,
): Promise<void> {
  const result = await getDriftStatusForIdentity(identity);
  if (result.drifted) {
    throw new AddressDriftBlockedError(result.previousAddresses);
  }
}
