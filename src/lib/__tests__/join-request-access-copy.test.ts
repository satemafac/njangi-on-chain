import {
  JOIN_REQUESTS_LOAD_FAILED,
  JOIN_REQUEST_CHECK_FAILED,
  classifyJoinRequestQueueFailure,
  joinRequestAccessMessage,
  joinRequestBellNotice,
  readJoinRequestCheck,
} from '../join-request-access-copy';

describe('joinRequestAccessMessage', () => {
  it('asks for a fresh sign-in on 401', () => {
    expect(joinRequestAccessMessage(401)).toMatch(/sign in again/i);
  });

  it("explains a 403 as the admin's queue", () => {
    expect(joinRequestAccessMessage(403)).toMatch(/only this circle's admin/i);
  });

  it('falls back for every other failure', () => {
    expect(joinRequestAccessMessage(500)).toBe(JOIN_REQUESTS_LOAD_FAILED);
    expect(joinRequestAccessMessage(503, 'custom')).toBe('custom');
  });
});

describe('readJoinRequestCheck (join page)', () => {
  it('reads a real answer either way', () => {
    expect(readJoinRequestCheck(200, { success: true, data: { hasPendingRequest: true } })).toEqual({
      ok: true,
      hasPendingRequest: true,
    });
    expect(readJoinRequestCheck(200, { success: true, data: { hasPendingRequest: false } })).toEqual({
      ok: true,
      hasPendingRequest: false,
    });
  });

  it('reads a 503 from an unreadable store as "couldn\'t check", not "no request"', () => {
    expect(
      readJoinRequestCheck(503, { success: false, message: "We couldn't check join requests right now." }),
    ).toEqual({ ok: false, message: JOIN_REQUEST_CHECK_FAILED });
  });

  it('asks for a fresh sign-in on 401', () => {
    const check = readJoinRequestCheck(401, { success: false, requiresReauth: true });
    expect(check.ok).toBe(false);
    expect(!check.ok && check.message).toMatch(/sign in again/i);
  });

  it('never reads a malformed or missing answer as "no request"', () => {
    const bodies: unknown[] = [
      null,
      'Internal Server Error',
      {},
      { success: true },
      { success: true, data: null },
      { success: true, data: {} },
      { success: true, data: { hasPendingRequest: 'false' } },
      { success: false, data: { hasPendingRequest: false } },
    ];
    for (const body of bodies) {
      expect(readJoinRequestCheck(200, body)).toEqual({ ok: false, message: JOIN_REQUEST_CHECK_FAILED });
    }
  });
});

describe('classifyJoinRequestQueueFailure (Navbar bell)', () => {
  it('reads a 401 as a lapsed sign-in', () => {
    expect(classifyJoinRequestQueueFailure(401)).toBe('signed-out');
  });

  it('skips a 403 or 404 quietly', () => {
    expect(classifyJoinRequestQueueFailure(403)).toBe('not-yours');
    expect(classifyJoinRequestQueueFailure(404)).toBe('not-yours');
  });

  it('counts every other failure as a queue it could not read', () => {
    for (const status of [429, 500, 502, 503, 504]) {
      expect(classifyJoinRequestQueueFailure(status)).toBe('unreadable');
    }
  });
});

describe('joinRequestBellNotice (Navbar bell)', () => {
  it('says nothing when every queue was read, whatever it held', () => {
    expect(joinRequestBellNotice({ requestsFound: 0, unreadableCircles: 0, signInExpired: false })).toBeNull();
    expect(joinRequestBellNotice({ requestsFound: 2, unreadableCircles: 0, signInExpired: false })).toBeNull();
  });

  it('reports a poll that read nothing instead of "No pending join requests"', () => {
    expect(joinRequestBellNotice({ requestsFound: 0, unreadableCircles: 2, signInExpired: false })).toBe(
      JOIN_REQUESTS_LOAD_FAILED,
    );
  });

  it('says the list is partial when some circles could not be read', () => {
    expect(joinRequestBellNotice({ requestsFound: 3, unreadableCircles: 1, signInExpired: false })).toBe(
      "Couldn't load join requests for one of your circles.",
    );
    expect(joinRequestBellNotice({ requestsFound: 3, unreadableCircles: 2, signInExpired: false })).toBe(
      "Couldn't load join requests for 2 of your circles.",
    );
  });

  it('asks for a fresh sign-in when the session lapsed and nothing was read', () => {
    expect(
      joinRequestBellNotice({ requestsFound: 0, unreadableCircles: 1, signInExpired: true }),
    ).toMatch(/sign in again/i);
  });
});
