import { timingSafeEqualStrings } from '../timing-safe';

describe('timingSafeEqualStrings', () => {
  it('returns true for identical strings', () => {
    expect(timingSafeEqualStrings('super-secret-token', 'super-secret-token')).toBe(true);
  });

  it('returns false for different strings of equal length', () => {
    expect(timingSafeEqualStrings('super-secret-token', 'super-secret-tokeX')).toBe(false);
  });

  it('returns false for strings of different lengths (no throw)', () => {
    expect(timingSafeEqualStrings('short', 'a-much-longer-candidate-secret')).toBe(false);
    expect(timingSafeEqualStrings('', 'non-empty')).toBe(false);
  });

  it('returns true for empty vs empty', () => {
    expect(timingSafeEqualStrings('', '')).toBe(true);
  });

  it('returns false when either side is not a string', () => {
    expect(timingSafeEqualStrings(undefined, 'secret')).toBe(false);
    expect(timingSafeEqualStrings('secret', undefined)).toBe(false);
    expect(timingSafeEqualStrings(null, null)).toBe(false);
    expect(timingSafeEqualStrings(['secret'], 'secret')).toBe(false);
  });
});
