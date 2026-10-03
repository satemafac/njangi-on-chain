/**
 * The shared pool must survive a dropped connection. pg reports one as an
 * 'error' event, and an EventEmitter 'error' with no listener throws — in a
 * serverless function that is an uncaught exception that kills the instance
 * (Sentry JAVASCRIPT-NEXTJS-8).
 */

import { EventEmitter } from 'events';

jest.mock('pg', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter: Emitter } = require('events');
  class FakePool extends Emitter {
    query = jest.fn();
    end = jest.fn();
  }
  return { Pool: FakePool };
});

import { __resetSharedPgPoolForTests, getSharedPgPool } from '../pg-pool';

const dropped = () => new Error('Connection terminated unexpectedly');

describe('getSharedPgPool', () => {
  const originalUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/njangi';
    __resetSharedPgPoolForTests();
  });

  afterAll(() => {
    process.env.DATABASE_URL = originalUrl;
    __resetSharedPgPoolForTests();
  });

  it('survives an idle connection being dropped by the server', () => {
    const pool = getSharedPgPool() as unknown as EventEmitter;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(() => pool.emit('error', dropped())).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Connection terminated unexpectedly'));

    warn.mockRestore();
  });

  it('gives every client it connects an error listener', () => {
    const pool = getSharedPgPool() as unknown as EventEmitter;
    const client = new EventEmitter();

    pool.emit('connect', client);

    expect(() => client.emit('error', dropped())).not.toThrow();
  });

  it('reuses one pool per process', () => {
    expect(getSharedPgPool()).toBe(getSharedPgPool());
  });
});
