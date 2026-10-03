// join-request-access-copy.ts — What the pages say when they can't read or
// write join requests. The /api/join-requests queue routes answer only the
// circle's admin, with a live server session, and every route answers 503
// when the join-request store can't be read. None of these failures may be
// shown as "no requests".

export const JOIN_REQUESTS_LOAD_FAILED = "Couldn't load join requests. Please try again.";

/**
 * Message for a refused or failed join-request call. A 401 means the server
 * session has lapsed, even when this tab still shows the account as signed in.
 */
export function joinRequestAccessMessage(
  status: number,
  fallback: string = JOIN_REQUESTS_LOAD_FAILED,
): string {
  if (status === 401) {
    return 'Your sign-in has expired. Sign in again to manage join requests.';
  }
  if (status === 403) {
    return "Only this circle's admin can manage its join requests.";
  }
  return fallback;
}

// --- Join page: has this member already asked? -----------------------------

export const JOIN_REQUEST_CHECK_FAILED =
  "We couldn't check whether you've already asked to join. Please try again.";

export type JoinRequestCheck =
  | { ok: true; hasPendingRequest: boolean }
  | { ok: false; message: string };

/**
 * Reads the answer to GET /api/join-requests/check. Only a 2xx carrying a
 * boolean `hasPendingRequest` is an answer. Anything else is "couldn't check",
 * and the join page must not offer "Send your request" on it: the member's
 * request may already be with the admin.
 */
export function readJoinRequestCheck(status: number, body: unknown): JoinRequestCheck {
  const answer = (body ?? {}) as { success?: unknown; data?: { hasPendingRequest?: unknown } | null };
  const hasPendingRequest = answer.data?.hasPendingRequest;
  if (status >= 200 && status < 300 && answer.success === true && typeof hasPendingRequest === 'boolean') {
    return { ok: true, hasPendingRequest };
  }
  if (status === 401) {
    return { ok: false, message: 'Your sign-in has expired. Sign in again to check your request.' };
  }
  return { ok: false, message: JOIN_REQUEST_CHECK_FAILED };
}

// --- Navbar bell: join requests across the admin's circles -----------------

export type JoinRequestQueueFailure = 'signed-out' | 'not-yours' | 'unreadable';

/**
 * How the bell treats a refused or failed queue read: a 401 is a lapsed
 * sign-in; a 403 or 404 is a settled answer (no longer this circle's admin, or
 * the circle is gone) and is skipped quietly; anything else is a queue the
 * bell couldn't read.
 */
export function classifyJoinRequestQueueFailure(status: number): JoinRequestQueueFailure {
  if (status === 401) {
    return 'signed-out';
  }
  if (status === 403 || status === 404) {
    return 'not-yours';
  }
  return 'unreadable';
}

/**
 * What the bell says after a poll, or null when every queue was read. A queue
 * it couldn't read is reported, never dropped: an empty bell during an outage
 * would tell the admin that nobody has asked to join.
 */
export function joinRequestBellNotice(poll: {
  requestsFound: number;
  unreadableCircles: number;
  signInExpired: boolean;
}): string | null {
  if (poll.signInExpired && poll.requestsFound === 0) {
    return 'Your sign-in has expired. Sign in again to see join requests.';
  }
  if (poll.unreadableCircles === 0) {
    return null;
  }
  if (poll.requestsFound === 0) {
    return JOIN_REQUESTS_LOAD_FAILED;
  }
  return poll.unreadableCircles === 1
    ? "Couldn't load join requests for one of your circles."
    : `Couldn't load join requests for ${poll.unreadableCircles} of your circles.`;
}
