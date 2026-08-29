// zklogin-session-registry.ts — Durable store for zkLogin sessions.
//
// `/api/zkLogin` keeps authenticated sessions (keyed by the HttpOnly
// `session-id` cookie) here. Other API routes — e.g. the WhatsApp
// admin link/unlink endpoints — resolve "who is the caller?" from the
// same store so they can bind requests to a server-verified address
// instead of trusting client-supplied identity.
//
// Vercel/serverless migration (June 2026): the original implementation was
// an in-memory Map, which breaks the moment two requests land on different
// lambda instances. When DATABASE_URL is configured the registry now
// persists sessions to the `zklogin_sessions` Postgres table. The session
// payload is encrypted at rest with AES-256-GCM using the 32-byte
// ZKLOGIN_SESSION_ENC_KEY environment variable (same key format as
// WALRUS_PII_MASTER_KEY; `npm run generate:secrets` fills it). Only
// non-secret lookup metadata (sub/aud/user_address/max_epoch/expiry) is
// stored in plaintext columns.
//
// The payload no longer contains an ephemeral private key — it did when this
// was written, and that was the original reason for the ciphertext. The
// encryption stays anyway, and it is worth being explicit about why rather
// than leaving a future reader to conclude it is vestigial: the payload still
// holds the user's SALT and zkProof material. Neither can produce a signature
// without the browser-held key, so leaking them is not fund loss — but the
// salt is address-derivation input and the proofs are identity-bound, and
// storing either in plaintext would be a privacy regression for no benefit.
//
// Without DATABASE_URL the registry falls back to the historic in-memory
// Map (dev / unit tests only — production fails fast instead). The Map is
// hung off `globalThis` because Next.js compiles each `pages/api`
// entrypoint into its own bundle: a plain module-scoped Map could be
// duplicated per bundle (and across dev HMR reloads), which would make
// sessions created by `/api/zkLogin` invisible to other routes.

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import type { SetupData, AccountData } from '../services/zkLoginService';
import { getSharedPgPool, isPostgresConfigured } from './pg-pool';

export type ZkLoginSessionRecord = SetupData & { account?: AccountData };

const GLOBAL_KEY = Symbol.for('njangi.zklogin.session-registry');

const AES_ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;

/**
 * Sessions are pinned to the cookie lifetime (`Max-Age=86400` set by
 * /api/zkLogin). Proof expiry (maxEpoch) is enforced separately by
 * `validateSession` in the API route.
 */
const SESSION_TTL_MS = Number(process.env.ZKLOGIN_SESSION_TTL_MS ?? String(24 * 60 * 60 * 1000));

interface SessionEnvelope {
  v: 1;
  iv: string; // base64
  ct: string; // base64 ciphertext
  tag: string; // base64 GCM auth tag
}

// ---------------------------------------------------------------------------
// In-memory fallback (dev / tests)
// ---------------------------------------------------------------------------

export function getZkLoginSessionStore(): Map<string, ZkLoginSessionRecord> {
  const globalStore = globalThis as { [key: symbol]: unknown };
  if (!(globalStore[GLOBAL_KEY] instanceof Map)) {
    globalStore[GLOBAL_KEY] = new Map<string, ZkLoginSessionRecord>();
  }
  return globalStore[GLOBAL_KEY] as Map<string, ZkLoginSessionRecord>;
}

function durableStoreEnabled(): boolean {
  if (isPostgresConfigured()) {
    return true;
  }
  if (process.env.NODE_ENV === 'production') {
    // Fail fast: in-memory sessions on a multi-instance/serverless
    // deployment manifest as random "please sign in again" loops and make
    // the server unable to verify admin calls. Never silently degrade.
    throw new Error(
      '[zklogin-session-registry] DATABASE_URL is required in production; ' +
        'refusing to keep zkLogin sessions in per-instance memory.',
    );
  }
  return false;
}

// ---------------------------------------------------------------------------
// Encryption at rest
// ---------------------------------------------------------------------------

function loadSessionKey(): Buffer {
  const raw = process.env.ZKLOGIN_SESSION_ENC_KEY;
  if (!raw) {
    throw new Error(
      'ZKLOGIN_SESSION_ENC_KEY is not set. Generate 32 random bytes (hex or base64) — ' +
        '`npm run generate:secrets` does this — before persisting zkLogin sessions.',
    );
  }

  let key: Buffer;
  if (/^[0-9a-fA-F]+$/.test(raw) && raw.length === KEY_BYTES * 2) {
    key = Buffer.from(raw, 'hex');
  } else {
    key = Buffer.from(raw, 'base64');
  }

  if (key.length !== KEY_BYTES) {
    throw new Error(
      `ZKLOGIN_SESSION_ENC_KEY must decode to exactly ${KEY_BYTES} bytes (got ${key.length}).`,
    );
  }
  return key;
}

export function encryptSessionRecord(record: ZkLoginSessionRecord): SessionEnvelope {
  const key = loadSessionKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(AES_ALGO, key, iv);
  const plaintext = Buffer.from(JSON.stringify(record), 'utf8');
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    iv: iv.toString('base64'),
    ct: ct.toString('base64'),
    tag: tag.toString('base64'),
  };
}

export function decryptSessionRecord(envelope: SessionEnvelope): ZkLoginSessionRecord {
  if (envelope.v !== 1) {
    throw new Error(`Unsupported session envelope version: ${envelope.v}`);
  }
  const key = loadSessionKey();
  const iv = Buffer.from(envelope.iv, 'base64');
  const ct = Buffer.from(envelope.ct, 'base64');
  const tag = Buffer.from(envelope.tag, 'base64');
  const decipher = createDecipheriv(AES_ALGO, key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  return JSON.parse(plaintext) as ZkLoginSessionRecord;
}

// ---------------------------------------------------------------------------
// Postgres backing
// ---------------------------------------------------------------------------

let setupPromise: Promise<void> | null = null;

function ensureTable(): Promise<void> {
  if (!setupPromise) {
    setupPromise = getSharedPgPool()
      .query(
        `CREATE TABLE IF NOT EXISTS zklogin_sessions (
           id TEXT PRIMARY KEY,
           session_ciphertext TEXT NOT NULL,
           sub TEXT,
           aud TEXT,
           user_address TEXT,
           max_epoch BIGINT,
           created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           expires_at TIMESTAMPTZ NOT NULL
         );
         CREATE INDEX IF NOT EXISTS zklogin_sessions_user_idx
           ON zklogin_sessions (user_address);
         CREATE INDEX IF NOT EXISTS zklogin_sessions_expires_idx
           ON zklogin_sessions (expires_at);`,
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

// ---------------------------------------------------------------------------
// Public async API — every consumer goes through these.
// ---------------------------------------------------------------------------

/** Fetches a session, expiring stale rows as a side effect (TTL on read). */
export async function getZkLoginSession(
  sessionId: string,
): Promise<ZkLoginSessionRecord | null> {
  if (!durableStoreEnabled()) {
    return getZkLoginSessionStore().get(sessionId) ?? null;
  }
  await ensureTable();
  const result = await getSharedPgPool().query<{ session_ciphertext: string }>(
    `WITH gc AS (
       DELETE FROM zklogin_sessions WHERE expires_at <= NOW()
     )
     SELECT session_ciphertext FROM zklogin_sessions
      WHERE id = $1 AND expires_at > NOW()`,
    [sessionId],
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return decryptSessionRecord(JSON.parse(row.session_ciphertext) as SessionEnvelope);
}

/** Inserts or replaces a session, refreshing its TTL. */
export async function setZkLoginSession(
  sessionId: string,
  record: ZkLoginSessionRecord,
): Promise<void> {
  if (!durableStoreEnabled()) {
    getZkLoginSessionStore().set(sessionId, record);
    return;
  }
  await ensureTable();
  const envelope = JSON.stringify(encryptSessionRecord(record));
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  await getSharedPgPool().query(
    `INSERT INTO zklogin_sessions
       (id, session_ciphertext, sub, aud, user_address, max_epoch, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO UPDATE SET
       session_ciphertext = EXCLUDED.session_ciphertext,
       sub = EXCLUDED.sub,
       aud = EXCLUDED.aud,
       user_address = EXCLUDED.user_address,
       max_epoch = EXCLUDED.max_epoch,
       expires_at = EXCLUDED.expires_at`,
    [
      sessionId,
      envelope,
      record.account?.sub ?? null,
      record.account?.aud ?? null,
      record.account?.userAddr ?? null,
      Number.isFinite(record.maxEpoch) ? Math.floor(record.maxEpoch) : null,
      expiresAt,
    ],
  );
}

export async function deleteZkLoginSession(sessionId: string): Promise<void> {
  if (!durableStoreEnabled()) {
    getZkLoginSessionStore().delete(sessionId);
    return;
  }
  await ensureTable();
  await getSharedPgPool().query('DELETE FROM zklogin_sessions WHERE id = $1', [sessionId]);
}

/** Cheap existence probe (no decrypt) used for request logging. */
export async function hasZkLoginSession(sessionId: string): Promise<boolean> {
  if (!durableStoreEnabled()) {
    return getZkLoginSessionStore().has(sessionId);
  }
  await ensureTable();
  const result = await getSharedPgPool().query(
    'SELECT 1 FROM zklogin_sessions WHERE id = $1 AND expires_at > NOW()',
    [sessionId],
  );
  return result.rows.length > 0;
}

export async function countZkLoginSessions(): Promise<number> {
  if (!durableStoreEnabled()) {
    return getZkLoginSessionStore().size;
  }
  await ensureTable();
  const result = await getSharedPgPool().query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM zklogin_sessions WHERE expires_at > NOW()',
  );
  return Number(result.rows[0]?.count ?? 0);
}

/**
 * Removes every other session bound to `userAddr` (single active session
 * per user — mirrors the old `cleanupUserSessions` in /api/zkLogin).
 */
export async function deleteZkLoginSessionsForUser(
  userAddr: string,
  exceptSessionId: string,
): Promise<void> {
  if (!durableStoreEnabled()) {
    const store = getZkLoginSessionStore();
    for (const [sessionId, record] of store.entries()) {
      if (sessionId !== exceptSessionId && record.account?.userAddr === userAddr) {
        store.delete(sessionId);
      }
    }
    return;
  }
  await ensureTable();
  await getSharedPgPool().query(
    'DELETE FROM zklogin_sessions WHERE user_address = $1 AND id <> $2',
    [userAddr, exceptSessionId],
  );
}

/**
 * Returns the authenticated account bound to a session id, or `null` when
 * the session is missing or has not completed the OAuth callback (i.e. it
 * has no account / zk proof material yet). Callers treat `null` as
 * "re-authenticate".
 */
export async function getZkLoginSessionAccount(
  sessionId: string | undefined,
): Promise<AccountData | null> {
  if (!sessionId) {
    return null;
  }
  const record = await getZkLoginSession(sessionId);
  const account = record?.account;
  if (!account?.userAddr) {
    return null;
  }
  // Mirror the proof-material checks /api/zkLogin applies before signing:
  // a session without complete proof points never finished authentication.
  if (
    !account.zkProofs?.proofPoints?.a?.length ||
    !account.zkProofs?.proofPoints?.b?.length ||
    !account.zkProofs?.proofPoints?.c?.length
  ) {
    return null;
  }
  return account;
}

/** Test helper — resets the lazy table-creation latch. */
export function __resetZkLoginSessionRegistryForTests(): void {
  setupPromise = null;
  getZkLoginSessionStore().clear();
}
