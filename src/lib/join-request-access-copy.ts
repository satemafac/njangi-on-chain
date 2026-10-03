// join-request-access-copy.ts — What the manage page says when it can't
// read or write a circle's join requests. The /api/join-requests queue
// routes answer only the circle's admin, with a live server session.

export const JOIN_REQUESTS_LOAD_FAILED = "Couldn't load join requests. Refresh to try again.";

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
