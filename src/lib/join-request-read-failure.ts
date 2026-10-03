// join-request-read-failure.ts — How the /api/join-requests routes answer when
// the join-request store (Postgres, or SQLite locally) can't be read.
//
// A failed read is not an empty answer. Before this, a Postgres outage made the
// pending queue answer `[]` ("No pending requests" on the manage page and an
// empty Navbar bell), the member's own check answer `hasPendingRequest: false`
// (the join page offered "Send your request" to someone already waiting) and the
// name lookup answer `userName: null`. Each now answers 503 and the page says
// it couldn't check, with a retry.

import type { NextApiResponse } from 'next';

export const JOIN_REQUESTS_UNREADABLE =
  "We couldn't check join requests right now. Please try again.";

/** Logs a failed join-request read and answers 503 in the routes' `{ success, message }` shape. */
export function sendJoinRequestReadFailure(
  res: NextApiResponse,
  context: { route: string; circleId: string },
  error: unknown,
) {
  console.error('[join-requests] store read failed', {
    ...context,
    error: error instanceof Error ? error.message : String(error),
  });
  return res.status(503).json({ success: false, message: JOIN_REQUESTS_UNREADABLE });
}
