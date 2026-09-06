/**
 * These flags gate money paths, so the two properties that matter are:
 * default-off (a typo must not enable a capability) and no false positives
 * from casing/whitespace.
 *
 * The action-set partitioning is asserted in the API guard tests — the
 * important invariant there is that the legacy kill switch blocks
 * CONTRIBUTIONS only, never payouts or recovery.
 */
import {
  isSwapsEnabled,
  isLegacyRailEnabled,
  isRampEnabled,
  isEscrowRoundGuardEnabled,
  isTimedEscrowEntriesEnabled,
  disabledResponse,
} from '@/config/feature-flags';

const KEYS = [
  'NEXT_PUBLIC_SWAPS_ENABLED',
  'NEXT_PUBLIC_LEGACY_RAIL_ENABLED',
  'NEXT_PUBLIC_COINBASE_ONRAMP_ENABLED',
  'NEXT_PUBLIC_MOONPAY_ENABLED',
  'NEXT_PUBLIC_TRANSAK_ENABLED',
] as const;

describe('capability flags', () => {
  const original: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of KEYS) {
      original[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
    }
  });

  it('defaults every capability to OFF when unset', () => {
    expect(isSwapsEnabled()).toBe(false);
    expect(isLegacyRailEnabled()).toBe(false);
    expect(isRampEnabled('coinbase')).toBe(false);
    expect(isRampEnabled('moonpay')).toBe(false);
    expect(isRampEnabled('transak')).toBe(false);
  });

  it('enables only on an explicit true', () => {
    process.env.NEXT_PUBLIC_SWAPS_ENABLED = 'true';
    expect(isSwapsEnabled()).toBe(true);

    // Anything else is off — a misspelled or partial value must not enable a
    // money path just because it looks affirmative.
    for (const v of ['false', '1', 'yes', 'TRUE ', 'enabled', '']) {
      process.env.NEXT_PUBLIC_SWAPS_ENABLED = v;
      expect(isSwapsEnabled()).toBe(v === 'TRUE ');
    }
  });

  it('tolerates casing and surrounding whitespace', () => {
    for (const v of ['TRUE', ' true ', 'True']) {
      process.env.NEXT_PUBLIC_LEGACY_RAIL_ENABLED = v;
      expect(isLegacyRailEnabled()).toBe(true);
    }
  });

  it('resolves each ramp independently', () => {
    process.env.NEXT_PUBLIC_MOONPAY_ENABLED = 'true';
    expect(isRampEnabled('moonpay')).toBe(true);
    expect(isRampEnabled('coinbase')).toBe(false);
    expect(isRampEnabled('transak')).toBe(false);
  });

  it('returns a machine-readable disabled body', () => {
    expect(disabledResponse('swaps', 'nope')).toEqual({
      error: 'CAPABILITY_DISABLED',
      capability: 'swaps',
      message: 'nope',
    });
  });
});

describe('escrow entry-point flags', () => {
  // These say which Move targets the client BUILDS. Default-off matters
  // more than usual: a target the published package does not carry aborts
  // every open with an unknown-function error.
  const KEYS = [
    'NEXT_PUBLIC_ESCROW_TIMED_ENTRIES_ENABLED',
    'NEXT_PUBLIC_ESCROW_ROUND_GUARD_ENABLED',
  ] as const;
  const original: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of KEYS) {
      original[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
    }
  });

  it('default both to OFF when unset', () => {
    expect(isTimedEscrowEntriesEnabled()).toBe(false);
    expect(isEscrowRoundGuardEnabled()).toBe(false);
  });

  it('enable the round guard only on an explicit true, independently of the timed entries', () => {
    process.env.NEXT_PUBLIC_ESCROW_ROUND_GUARD_ENABLED = 'true';
    expect(isEscrowRoundGuardEnabled()).toBe(true);
    expect(isTimedEscrowEntriesEnabled()).toBe(false);

    for (const v of ['false', '1', 'yes', 'enabled', '']) {
      process.env.NEXT_PUBLIC_ESCROW_ROUND_GUARD_ENABLED = v;
      expect(isEscrowRoundGuardEnabled()).toBe(false);
    }
  });
});
