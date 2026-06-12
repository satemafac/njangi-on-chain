/**
 * 🔐 Admin Authentication Middleware
 *
 * Server-side authorization for circle-admin API routes. The previous
 * implementation was a placeholder that accepted any non-empty token and
 * was never wired to a route; it has been replaced with real verification:
 *
 * 1. Resolve the caller from the HttpOnly `session-id` cookie issued by
 *    `/api/zkLogin` (shared in-memory store — see
 *    `src/lib/zklogin-session-registry.ts`). No session → 401.
 * 2. Fetch the circle object on chain and confirm the session address
 *    equals the circle's `admin` field (same source of truth as
 *    `/api/circles/[id]/verify-admin.ts`). Mismatch → 403.
 *
 * Authorization runs BEFORE any handler side effect (Walrus upload,
 * Postgres index write, notification) — wrap handlers with
 * `withCircleAdminAuth` or call `verifyCircleAdminRequest` first thing.
 */

import { NextApiRequest, NextApiResponse } from 'next';
import { createLogger, format, transports } from 'winston';
import { getZkLoginSessionAccount } from '../lib/zklogin-session-registry';
import {
  fetchCircleAdminAddress,
  suiAddressesEqual,
} from '../lib/circle-admin-verification';
import type { NetworkType } from '../services/whatsapp-registry-service';

// Configure logger for admin actions
const adminLogger = createLogger({
  level: 'info',
  format: format.combine(
    format.timestamp(),
    format.json()
  ),
  transports: [
    new transports.File({ filename: 'admin-actions.log' }),
    new transports.Console()
  ],
});

// ============================================================
// Types
// ============================================================

export interface VerifiedCircleAdmin {
  /** Session-verified caller address, confirmed equal to the on-chain admin. */
  suiAddress: string;
  sessionId: string;
  circleId: string;
  network: NetworkType;
}

export type CircleAdminVerification =
  | { ok: true; admin: VerifiedCircleAdmin }
  | { ok: false; status: number; error: string };

export interface AuthenticatedRequest extends NextApiRequest {
  admin?: VerifiedCircleAdmin;
}

export interface CircleAdminVerifyOptions {
  /** Override the circleId instead of reading it from query/body. */
  circleId?: string;
  /** Override the network instead of reading it from query/body. */
  network?: NetworkType;
}

/** Injectable for tests; production callers use the on-chain default. */
export interface CircleAdminVerifyDeps {
  fetchAdminAddress?: typeof fetchCircleAdminAddress;
}

// ============================================================
// Verification
// ============================================================

function resolveNetwork(raw: unknown): NetworkType {
  return raw === 'mainnet' || raw === 'testnet' ? raw : 'testnet';
}

function firstString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

/**
 * Core primitive shared by the admin link/unlink routes (and the GET
 * `includeRecipient` PII path): binds the caller to a server-verified
 * zkLogin session and confirms that address is the on-chain circle admin.
 * Performs no side effects and writes nothing to the response.
 */
export async function verifyCircleAdminRequest(
  req: NextApiRequest,
  options: CircleAdminVerifyOptions = {},
  deps: CircleAdminVerifyDeps = {},
): Promise<CircleAdminVerification> {
  // Query and body are independent in a pages API request, so a caller could
  // authorize against one circle/network while the handler operates on
  // another. Reject any divergence outright, and prefer the body value (the
  // operation target for state-changing POSTs) over the query. Handlers must
  // then operate on the verified `req.admin.circleId` / `req.admin.network`,
  // never re-read the raw body.
  const queryCircleId = firstString(req.query?.circleId);
  const bodyCircleId = firstString(req.body?.circleId);
  if (queryCircleId && bodyCircleId && queryCircleId !== bodyCircleId) {
    return {
      ok: false,
      status: 400,
      error: 'circleId mismatch between query string and request body.',
    };
  }
  const circleId = options.circleId ?? bodyCircleId ?? queryCircleId;
  if (!circleId) {
    return { ok: false, status: 400, error: 'Missing circleId' };
  }

  const queryNetwork = firstString(req.query?.network);
  const bodyNetwork = firstString(req.body?.network);
  if (queryNetwork && bodyNetwork && queryNetwork !== bodyNetwork) {
    return {
      ok: false,
      status: 400,
      error: 'network mismatch between query string and request body.',
    };
  }
  const network = resolveNetwork(options.network ?? bodyNetwork ?? queryNetwork);

  // 1. Server-verified identity: the HttpOnly session cookie set during the
  //    /api/zkLogin OAuth flow. Client-supplied adminAddress/account fields
  //    are never trusted for authorization.
  const sessionId = req.cookies?.['session-id'];
  const sessionAccount = getZkLoginSessionAccount(sessionId);
  if (!sessionId || !sessionAccount) {
    return {
      ok: false,
      status: 401,
      error: 'Authentication required: no valid zkLogin session. Please sign in again.',
    };
  }

  // If the body carries signing material or an address claim, it must match
  // the authenticated session — same check /api/zkLogin applies before
  // signing transactions.
  const bodyAccountAddr = req.body?.account?.userAddr;
  if (
    typeof bodyAccountAddr === 'string' &&
    bodyAccountAddr.length > 0 &&
    !suiAddressesEqual(bodyAccountAddr, sessionAccount.userAddr)
  ) {
    return {
      ok: false,
      status: 401,
      error: 'Session mismatch: account does not match the authenticated session.',
    };
  }
  const claimedAdminAddr = req.body?.adminAddress;
  if (
    typeof claimedAdminAddr === 'string' &&
    claimedAdminAddr.length > 0 &&
    !suiAddressesEqual(claimedAdminAddr, sessionAccount.userAddr)
  ) {
    return {
      ok: false,
      status: 403,
      error: 'adminAddress does not match the authenticated session.',
    };
  }

  // 2. On-chain authority: the circle object's admin field. RPC failures
  //    fail closed.
  const fetchAdmin = deps.fetchAdminAddress ?? fetchCircleAdminAddress;
  let onChainAdmin: string | null;
  try {
    onChainAdmin = await fetchAdmin(circleId, network);
  } catch (error) {
    adminLogger.error('❌ On-chain admin lookup failed', {
      circleId,
      network,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      ok: false,
      status: 500,
      error: 'Failed to verify circle admin on-chain',
    };
  }

  if (!onChainAdmin) {
    return { ok: false, status: 404, error: 'Circle not found' };
  }

  if (!suiAddressesEqual(onChainAdmin, sessionAccount.userAddr)) {
    return {
      ok: false,
      status: 403,
      error: 'Only the circle admin can perform this action.',
    };
  }

  return {
    ok: true,
    admin: {
      suiAddress: sessionAccount.userAddr,
      sessionId,
      circleId,
      network,
    },
  };
}

/**
 * Route wrapper: rejects the request before the handler runs unless the
 * caller's zkLogin session resolves to the on-chain circle admin. On
 * success the verified identity is attached as `req.admin`.
 */
export function withCircleAdminAuth(
  handler: (req: AuthenticatedRequest, res: NextApiResponse) => Promise<unknown> | unknown,
  options: CircleAdminVerifyOptions = {},
  deps: CircleAdminVerifyDeps = {},
) {
  return async (req: AuthenticatedRequest, res: NextApiResponse) => {
    const verification = await verifyCircleAdminRequest(req, options, deps);

    if (!verification.ok) {
      adminLogger.warn('❌ Circle admin authorization failed', {
        path: req.url,
        method: req.method,
        status: verification.status,
        reason: verification.error,
        ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress,
      });
      return res.status(verification.status).json({
        success: false,
        error: verification.error,
        requiresReauth: verification.status === 401,
      });
    }

    adminLogger.info('✅ Circle admin authenticated', {
      suiAddress: verification.admin.suiAddress,
      circleId: verification.admin.circleId,
      path: req.url,
      method: req.method,
    });

    req.admin = verification.admin;
    return handler(req, res);
  };
}

export function logAdminAction(
  action: string,
  suiAddress: string,
  details: Record<string, unknown> = {}
): void {
  adminLogger.info(`✅ ${action}`, {
    suiAddress,
    ...details,
    timestamp: new Date().toISOString()
  });
}
