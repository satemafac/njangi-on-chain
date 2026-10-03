import {
  JOIN_REQUESTS_LOAD_FAILED,
  joinRequestAccessMessage,
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
