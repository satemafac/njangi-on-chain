/**
 * rateLimitKey builds the `rate_limits.bucket` value. The bucket is stored
 * verbatim in Postgres and only replaced when hit again, so the key must
 * carry no raw IP / email / address, be stable for the same input (or the
 * limit does not limit), be salted so a copy of the table cannot be matched
 * against candidate IPs, and never throw when the salt is missing.
 */

import { createHash, createHmac } from 'node:crypto';
import {
  RATE_LIMIT_KEY_PATTERN,
  __resetRateLimitKeyForTests,
  rateLimitKey,
  resolveRateLimitKeySalt,
} from '../rate-limit-key';

const IP = '203.0.113.7';
const EMAIL = 'member@example.com';
const ADDRESS = '0xabc123def456';

const ENV_KEYS = ['RATE_LIMIT_KEY_SALT', 'LEGAL_ACCEPT_IP_SALT'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  __resetRateLimitKeyForTests();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('rateLimitKey', () => {
  it('emits <scope>:<64 hex> and never the raw subjects', () => {
    process.env.RATE_LIMIT_KEY_SALT = 'salt-a';
    const key = rateLimitKey('legal-deletion', IP, EMAIL);
    expect(key).toMatch(RATE_LIMIT_KEY_PATTERN);
    expect(key.startsWith('legal-deletion:')).toBe(true);
    expect(key).not.toContain(IP);
    expect(key).not.toContain(EMAIL);
    expect(key).not.toContain('203');
    expect(key).not.toContain('example');
  });

  it('is stable for the same scope and subjects', () => {
    process.env.RATE_LIMIT_KEY_SALT = 'salt-a';
    expect(rateLimitKey('join-request', IP, ADDRESS)).toBe(
      rateLimitKey('join-request', IP, ADDRESS),
    );
  });

  it('differs per subject, per scope and per salt', () => {
    process.env.RATE_LIMIT_KEY_SALT = 'salt-a';
    const base = rateLimitKey('record', IP);
    expect(rateLimitKey('record', '198.51.100.9')).not.toBe(base);
    expect(rateLimitKey('record', IP, ADDRESS)).not.toBe(base);
    // Same IP, another route: the hex differs too, so rows cannot be
    // correlated across routes from the table alone.
    expect(rateLimitKey('badges', IP).split(':')[1]).not.toBe(base.split(':')[1]);
    process.env.RATE_LIMIT_KEY_SALT = 'salt-b';
    expect(rateLimitKey('record', IP)).not.toBe(base);
  });

  it('does not collide when subject boundaries move', () => {
    process.env.RATE_LIMIT_KEY_SALT = 'salt-a';
    expect(rateLimitKey('s', 'ab', 'c')).not.toBe(rateLimitKey('s', 'a', 'bc'));
    expect(rateLimitKey('s', 'ab')).not.toBe(rateLimitKey('s', 'ab', ''));
  });

  it('is an HMAC-SHA256 keyed with RATE_LIMIT_KEY_SALT, not a plain digest', () => {
    process.env.RATE_LIMIT_KEY_SALT = 'salt-a';
    const key = rateLimitKey('record', IP);
    const material = ['record', IP].join('\u001f');
    expect(key).toBe(`record:${createHmac('sha256', 'salt-a').update(material).digest('hex')}`);
    expect(key).not.toBe(`record:${createHash('sha256').update(material).digest('hex')}`);
  });

  it('falls back to LEGAL_ACCEPT_IP_SALT when RATE_LIMIT_KEY_SALT is unset', () => {
    process.env.LEGAL_ACCEPT_IP_SALT = 'legal-salt';
    expect(resolveRateLimitKeySalt()).toBe('legal-salt');
    const viaFallback = rateLimitKey('record', IP);
    process.env.RATE_LIMIT_KEY_SALT = 'legal-salt';
    expect(rateLimitKey('record', IP)).toBe(viaFallback);
    process.env.RATE_LIMIT_KEY_SALT = 'dedicated';
    expect(resolveRateLimitKeySalt()).toBe('dedicated');
    expect(rateLimitKey('record', IP)).not.toBe(viaFallback);
  });

  it('with no salt at all: plain SHA-256, one warning per process, never a throw', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(resolveRateLimitKeySalt()).toBeNull();
    const first = rateLimitKey('record', IP);
    const second = rateLimitKey('badges', IP, EMAIL);
    expect(first).toMatch(RATE_LIMIT_KEY_PATTERN);
    expect(second).toMatch(RATE_LIMIT_KEY_PATTERN);
    expect(first).not.toContain(IP);
    expect(second).not.toContain(EMAIL);
    expect(first).toBe(
      `record:${createHash('sha256').update(['record', IP].join('\u001f')).digest('hex')}`,
    );
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain('RATE_LIMIT_KEY_SALT');
  });

  it('treats an empty-string salt as unset', () => {
    process.env.RATE_LIMIT_KEY_SALT = '';
    process.env.LEGAL_ACCEPT_IP_SALT = '';
    expect(resolveRateLimitKeySalt()).toBeNull();
  });

  it('hashes null/undefined subjects as empty instead of throwing', () => {
    process.env.RATE_LIMIT_KEY_SALT = 'salt-a';
    expect(() => rateLimitKey('mainnet-signup', IP, undefined)).not.toThrow();
    expect(rateLimitKey('mainnet-signup', IP, null)).toBe(rateLimitKey('mainnet-signup', IP, ''));
  });

  it('keeps colon-bearing scopes inside the pattern the purge relies on', () => {
    process.env.RATE_LIMIT_KEY_SALT = 'salt-a';
    const key = rateLimitKey('compliance:queue', 'shared-secret');
    expect(key).toMatch(RATE_LIMIT_KEY_PATTERN);
    expect(key.startsWith('compliance:queue:')).toBe(true);
    expect(key).not.toContain('shared-secret');
    // The old, raw shapes do not match: this is what the migration deletes.
    expect('legal-deletion:203.0.113.7:member@example.com').not.toMatch(RATE_LIMIT_KEY_PATTERN);
    expect('record:203.0.113.7').not.toMatch(RATE_LIMIT_KEY_PATTERN);
    expect(`compliance:queue:${'ab'.repeat(16)}`).not.toMatch(RATE_LIMIT_KEY_PATTERN);
  });
});
