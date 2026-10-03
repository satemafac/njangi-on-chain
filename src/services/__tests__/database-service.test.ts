/**
 * The local SQLite join-request reads throw when the file can't be read, as
 * the Postgres reads do: `[]` and `false` keep meaning "no such request".
 * That includes production without DATABASE_URL, where the routes pick this
 * service and its guard refuses to open a per-instance file: the reads used
 * to swallow that refusal into an empty queue and "no request yet".
 * Writes still return null/false, and the routes answer 500 for those.
 */

const mockStatement = { all: jest.fn(), get: jest.fn(), run: jest.fn() };

jest.mock(
  'better-sqlite3',
  () =>
    class FakeDatabase {
      pragma(): void {
        return undefined;
      }
      exec(): void {
        return undefined;
      }
      prepare() {
        return mockStatement;
      }
    },
);

import databaseService from '../database-service';

const CIRCLE_ID = '0x' + 'c3'.repeat(32);
const MEMBER = '0x' + 'b2'.repeat(32);
const locked = () => new Error('SQLITE_BUSY: database is locked');

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

beforeEach(() => {
  mockStatement.all.mockReset();
  mockStatement.get.mockReset();
  mockStatement.run.mockReset();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  (process.env as Record<string, string>).NODE_ENV = ORIGINAL_NODE_ENV ?? 'test';
  if (ORIGINAL_DATABASE_URL === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
  }
});

describe('reads', () => {
  it('throws instead of answering an empty queue when the pending read fails', () => {
    mockStatement.all.mockImplementation(() => {
      throw locked();
    });

    expect(() => databaseService.getPendingRequestsByCircleId(CIRCLE_ID)).toThrow('SQLITE_BUSY');
  });

  it('maps pending rows when the read succeeds', () => {
    mockStatement.all.mockReturnValue([
      {
        id: 1,
        circleId: CIRCLE_ID,
        circleName: 'Susu',
        userAddress: MEMBER,
        userName: 'Aminata',
        requestDate: 1_700_000_000_000,
        status: 'pending',
      },
    ]);

    expect(databaseService.getPendingRequestsByCircleId(CIRCLE_ID)).toEqual([
      expect.objectContaining({ circle_id: CIRCLE_ID, user_address: MEMBER, user_name: 'Aminata' }),
    ]);
  });

  it('throws instead of answering "no request" when the check fails', () => {
    mockStatement.get.mockImplementation(() => {
      throw locked();
    });

    expect(() => databaseService.userHasPendingRequest(CIRCLE_ID, MEMBER)).toThrow('SQLITE_BUSY');
  });

  it('answers the check from the count when the read succeeds', () => {
    mockStatement.get.mockReturnValueOnce({ count: 0 }).mockReturnValueOnce({ count: 1 });

    expect(databaseService.userHasPendingRequest(CIRCLE_ID, MEMBER)).toBe(false);
    expect(databaseService.userHasPendingRequest(CIRCLE_ID, MEMBER)).toBe(true);
  });
});

describe('writes', () => {
  it('still report a failure as null / false (the routes answer 500)', () => {
    mockStatement.run.mockImplementation(() => {
      throw locked();
    });

    expect(
      databaseService.createJoinRequest({
        circleId: CIRCLE_ID,
        circleName: 'Susu',
        userAddress: MEMBER,
        userName: 'Aminata',
        requestDate: Date.now(),
        status: 'pending',
      }),
    ).toBeNull();
    expect(databaseService.updateJoinRequestStatus(CIRCLE_ID, MEMBER, 'approved')).toBe(false);
  });
});

describe('in production without DATABASE_URL', () => {
  it('throws from the reads instead of answering an empty queue or "no request"', () => {
    (process.env as Record<string, string>).NODE_ENV = 'production';
    delete process.env.DATABASE_URL;

    // A fresh instance: the shared one has already opened the fake file.
    let fresh: typeof databaseService | undefined;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      fresh = require('../database-service').default;
    });
    if (!fresh) throw new Error('failed to load database-service');
    const service = fresh;

    expect(() => service.getPendingRequestsByCircleId(CIRCLE_ID)).toThrow(
      'DATABASE_URL is required in production',
    );
    expect(() => service.userHasPendingRequest(CIRCLE_ID, MEMBER)).toThrow(
      'DATABASE_URL is required in production',
    );
    expect(mockStatement.all).not.toHaveBeenCalled();
    expect(mockStatement.get).not.toHaveBeenCalled();
  });
});
