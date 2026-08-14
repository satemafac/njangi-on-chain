import {
  ZERO_SUI_OBJECT_ID,
  isResolvedSuiObjectId,
  normalizeRequiredObjectId,
} from '@/lib/sui-object-id';

const REAL_WALLET_ID = '0x9e97c1bc9633149799b8b6a854a33c11f8367eba1d475cd4c9031e836ad8e1d3';

describe('isResolvedSuiObjectId', () => {
  it('accepts a real object id', () => {
    expect(isResolvedSuiObjectId(REAL_WALLET_ID)).toBe(true);
  });

  it('accepts a short-form id that still points somewhere', () => {
    expect(isResolvedSuiObjectId('0x6')).toBe(true);
  });

  // The regression this guard exists for: an in-flight circle read leaves
  // walletId empty, which normalizes into the all-zero object id and reaches
  // the RPC as `The following input objects are invalid`.
  it.each([
    ['an empty string', ''],
    ['whitespace', '   '],
    ['the short zero id', '0x0'],
    ['the padded zero id', ZERO_SUI_OBJECT_ID],
  ])('rejects %s', (_label, value) => {
    expect(isResolvedSuiObjectId(value)).toBe(false);
  });

  it('rejects non-hex and over-long values that normalize silently', () => {
    expect(isResolvedSuiObjectId('garbage')).toBe(false);
    expect(isResolvedSuiObjectId(`0x${'a'.repeat(66)}`)).toBe(false);
  });

  it('rejects non-string values', () => {
    expect(isResolvedSuiObjectId(undefined)).toBe(false);
    expect(isResolvedSuiObjectId(null)).toBe(false);
    expect(isResolvedSuiObjectId(0)).toBe(false);
  });
});

describe('normalizeRequiredObjectId', () => {
  it('returns the padded id for a valid input', () => {
    expect(normalizeRequiredObjectId(REAL_WALLET_ID, 'Custody wallet ID')).toBe(REAL_WALLET_ID);
    expect(normalizeRequiredObjectId('0x6', 'Clock ID')).toBe(
      '0x0000000000000000000000000000000000000000000000000000000000000006',
    );
  });

  it('reports a missing id as required', () => {
    expect(() => normalizeRequiredObjectId('', 'Custody wallet ID')).toThrow(
      'Custody wallet ID is required.',
    );
  });

  it('distinguishes an unloaded zero id from a malformed one', () => {
    expect(() => normalizeRequiredObjectId('0x0', 'Custody wallet ID')).toThrow(
      /Custody wallet ID has not loaded yet/,
    );
    expect(() => normalizeRequiredObjectId('not-an-id', 'Custody wallet ID')).toThrow(
      'Custody wallet ID is invalid.',
    );
  });
});
