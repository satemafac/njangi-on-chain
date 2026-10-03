// join-request-auth.ts — Session gates for the /api/join-requests/* routes.
//
// src/middleware.ts skips /api, so each route authenticates itself. The
// caller is whoever the HttpOnly `session-id` cookie resolves to (the zkLogin
// session registry), never an address taken from the query or body:
// - a member's own request (check, create): the session must be `userAddress`;
// - a circle's join queue (pending list, status updates): the session must be
//   the circle's on-chain admin;
// - member display names (lookup-user): the session must be the circle's
//   admin or one of its members.
// Chain reads use the deployment's network, never a client-supplied one.

import type { NextApiRequest, NextApiResponse } from 'next';
import type { AccountData } from '../services/zkLoginService';
import { getCurrentNetwork } from '../services/network-config';
import { getZkLoginSessionAccount } from './zklogin-session-registry';
import { fetchCircleAuthority, suiAddressesEqual } from './circle-admin-verification';
import { isCircleMember } from './milestone-discovery';
import { verifyCircleAdminRequest } from '../middleware/admin-auth.middleware';

export interface JoinRequestAuthFailure {
  ok: false;
  status: number;
  message: string;
}

export type JoinRequestSessionAuth = { ok: true; account: AccountData } | JoinRequestAuthFailure;

export type JoinRequestCircleAuth = { ok: true; address: string } | JoinRequestAuthFailure;

const SIGN_IN_AGAIN: JoinRequestAuthFailure = {
  ok: false,
  status: 401,
  message: 'Please sign in again to continue.',
};

const ACCESS_UNVERIFIED: JoinRequestAuthFailure = {
  ok: false,
  status: 503,
  message: "We couldn't check your access to this circle. Please try again.",
};

// The session store itself could not be read (Postgres down, or no
// DATABASE_URL in production): not the same thing as "signed out".
const SIGN_IN_UNVERIFIED: JoinRequestAuthFailure = {
  ok: false,
  status: 503,
  message: "We couldn't check your sign-in. Please try again.",
};

function logSessionReadFailure(error: unknown): void {
  console.error('[join-request-auth] session read failed', {
    error: error instanceof Error ? error.message : String(error),
  });
}

/** The session's account, or null when signed out. Throws when the store can't be read. */
async function readSessionAccount(req: NextApiRequest): Promise<AccountData | null> {
  const account = await getZkLoginSessionAccount(req.cookies?.['session-id']);
  return account?.userAddr ? account : null;
}

/** Writes a refusal in the routes' `{ success, message }` shape. */
export function sendJoinRequestAuthFailure(
  res: NextApiResponse,
  failure: JoinRequestAuthFailure,
) {
  return res.status(failure.status).json({
    success: false,
    message: failure.message,
    ...(failure.status === 401 ? { requiresReauth: true } : {}),
  });
}

/** The signed-in caller must be `userAddress` itself. */
export async function requireSessionAddress(
  req: NextApiRequest,
  userAddress: string,
): Promise<JoinRequestSessionAuth> {
  let account: AccountData | null;
  try {
    account = await readSessionAccount(req);
  } catch (error) {
    logSessionReadFailure(error);
    return SIGN_IN_UNVERIFIED;
  }
  if (!account) {
    return SIGN_IN_AGAIN;
  }
  if (!suiAddressesEqual(account.userAddr, userAddress)) {
    return {
      ok: false,
      status: 403,
      message: 'You can only do this for the account you are signed in with.',
    };
  }
  return { ok: true, account };
}

/** The signed-in caller must be the circle's on-chain admin. */
export async function requireCircleAdmin(
  req: NextApiRequest,
  circleId: string,
): Promise<JoinRequestCircleAuth> {
  let verification: Awaited<ReturnType<typeof verifyCircleAdminRequest>>;
  try {
    // It answers chain-read failures itself (500); what escapes it is the
    // session-store read.
    verification = await verifyCircleAdminRequest(req, {
      circleId,
      network: getCurrentNetwork(),
    });
  } catch (error) {
    logSessionReadFailure(error);
    return SIGN_IN_UNVERIFIED;
  }
  if (!verification.ok) {
    return { ok: false, status: verification.status, message: verification.error };
  }
  return { ok: true, address: verification.admin.suiAddress };
}

/**
 * The signed-in caller must be the circle's admin or one of its members.
 * A chain read that fails is answered 503, never treated as "not a member".
 */
export async function requireCircleParticipant(
  req: NextApiRequest,
  circleId: string,
): Promise<JoinRequestCircleAuth> {
  let account: AccountData | null;
  try {
    account = await readSessionAccount(req);
  } catch (error) {
    logSessionReadFailure(error);
    return SIGN_IN_UNVERIFIED;
  }
  if (!account) {
    return SIGN_IN_AGAIN;
  }

  const network = getCurrentNetwork();
  let authority: Awaited<ReturnType<typeof fetchCircleAuthority>>;
  try {
    authority = await fetchCircleAuthority(circleId, network);
  } catch (error) {
    console.error('[join-request-auth] circle read failed', {
      circleId,
      error: error instanceof Error ? error.message : String(error),
    });
    return ACCESS_UNVERIFIED;
  }
  // Every circle has an admin; an object without one is not a circle.
  if (!authority?.admin) {
    return { ok: false, status: 404, message: 'Circle not found.' };
  }
  if (suiAddressesEqual(authority.admin, account.userAddr)) {
    return { ok: true, address: account.userAddr };
  }

  const member = await isCircleMember(authority.membersTableId, account.userAddr, network);
  if (member === true) {
    return { ok: true, address: account.userAddr };
  }
  if (member === false) {
    return {
      ok: false,
      status: 403,
      message: 'Only members of this circle can see its member names.',
    };
  }
  return ACCESS_UNVERIFIED;
}
