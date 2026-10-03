/**
 * The Postgres join-request reads throw when the table can't be read, so a
 * route can answer "couldn't check" instead of an empty queue, "no request
 * yet" or "no name on file". `[]`, `false` and `null` keep meaning that the
 * table really holds no such row. Saving a request throws too: it used to
 * resolve null, and the create route then answered 200 `{ id: 0 }`.
 */

const mockQuery = jest.fn();

jest.mock('../../lib/pg-pool', () => ({
  getSharedPgPool: () => ({ query: mockQuery }),
}));

import joinRequestDatabase from '../join-request-database';

const CIRCLE_ID = '0x' + 'c3'.repeat(32);
const MEMBER = '0x' + 'b2'.repeat(32);
const outage = () => new Error('Connection terminated unexpectedly');

beforeEach(() => {
  mockQuery.mockReset();
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('pending queue read', () => {
  it('throws instead of answering an empty queue when the read fails', async () => {
    mockQuery.mockRejectedValue(outage());

    await expect(joinRequestDatabase.getPendingRequestsByCircleId(CIRCLE_ID)).rejects.toThrow(
      'Connection terminated unexpectedly',
    );
  });

  it('answers an empty queue only when no request is pending', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await expect(joinRequestDatabase.getPendingRequestsByCircleId(CIRCLE_ID)).resolves.toEqual([]);
  });
});

describe("a member's own check", () => {
  it('throws instead of answering "no request" when the read fails', async () => {
    mockQuery.mockRejectedValue(outage());

    await expect(joinRequestDatabase.checkPendingRequest(CIRCLE_ID, MEMBER)).rejects.toThrow(
      'Connection terminated unexpectedly',
    );
  });

  it('answers from the rows when the read succeeds', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ id: 7 }] });

    await expect(joinRequestDatabase.checkPendingRequest(CIRCLE_ID, MEMBER)).resolves.toBe(false);
    await expect(joinRequestDatabase.checkPendingRequest(CIRCLE_ID, MEMBER)).resolves.toBe(true);
  });
});

describe('member name lookup', () => {
  it('throws instead of answering "no name on file" when the read fails', async () => {
    mockQuery.mockRejectedValue(outage());

    await expect(joinRequestDatabase.getUserByAddress(CIRCLE_ID, MEMBER)).rejects.toThrow(
      'Connection terminated unexpectedly',
    );
  });

  it('answers null only for an address that never applied', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await expect(joinRequestDatabase.getUserByAddress(CIRCLE_ID, MEMBER)).resolves.toBeNull();
  });
});

describe('saving a request', () => {
  it('throws when the write fails, so nothing reports the request as sent', async () => {
    mockQuery.mockRejectedValue(outage());

    await expect(
      joinRequestDatabase.createJoinRequest(CIRCLE_ID, 'Susu', MEMBER, 'Aminata'),
    ).rejects.toThrow('Connection terminated unexpectedly');
  });

  it('throws when the write returns no row', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await expect(
      joinRequestDatabase.createJoinRequest(CIRCLE_ID, 'Susu', MEMBER, 'Aminata'),
    ).rejects.toThrow('returned no row');
  });

  it('returns the saved row', async () => {
    const row = { id: 7, circle_id: CIRCLE_ID, user_address: MEMBER, status: 'pending' };
    mockQuery.mockResolvedValue({ rows: [row] });

    await expect(
      joinRequestDatabase.createJoinRequest(CIRCLE_ID, 'Susu', MEMBER, 'Aminata'),
    ).resolves.toEqual(row);
  });
});

describe('status update', () => {
  it('still reports a failed write as false (the route answers 500)', async () => {
    mockQuery.mockRejectedValue(outage());

    await expect(
      joinRequestDatabase.updateJoinRequestStatus(CIRCLE_ID, MEMBER, 'approved'),
    ).resolves.toBe(false);
  });
});
