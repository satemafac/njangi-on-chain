/**
 * Geo-aware ramp routing tests (2026-06 GTM audit: CEMAC money-in).
 *
 * The launch-blocking finding was that every live flow hardcoded Coinbase +
 * country="US" while the geo-aware picker was dead code. These tests pin
 * the routing contract: CEMAC → Transak first (XAF) with Coinbase omitted,
 * US → Coinbase first, everywhere else → MoonPay first with Coinbase last,
 * and disabled/secret-less providers filtered out.
 */

import {
  CEMAC_COUNTRIES,
  countryFromLocale,
  fiatCurrencyForProvider,
  isCemacCountry,
  isSanctionedCountry,
  normalizeCountryCode,
  orderedEnabledProviders,
  providerOrderForCountry,
  RAMP_ONLY_BLOCKED_COUNTRIES,
  readClientProviderFlags,
  readServerProviderAvailability,
  SANCTIONED_COUNTRIES,
  type RampProviderFlags,
} from '@/lib/ramp-geo';
import { EMBARGOED_COUNTRIES, EMBARGOED_UA_REGIONS } from '@/lib/embargo';

const ALL_ENABLED: RampProviderFlags = {
  coinbase: true,
  moonpay: true,
  transak: true,
};

describe('normalizeCountryCode', () => {
  it('upper-cases and trims valid alpha-2 codes', () => {
    expect(normalizeCountryCode(' cm ')).toBe('CM');
    expect(normalizeCountryCode('US')).toBe('US');
  });

  it('rejects malformed values', () => {
    expect(normalizeCountryCode('')).toBeNull();
    expect(normalizeCountryCode(null)).toBeNull();
    expect(normalizeCountryCode(undefined)).toBeNull();
    expect(normalizeCountryCode('USA')).toBeNull();
    expect(normalizeCountryCode('1A')).toBeNull();
    expect(normalizeCountryCode('<script>')).toBeNull();
  });
});

describe('providerOrderForCountry', () => {
  it.each([...CEMAC_COUNTRIES])(
    'orders Transak first and omits Coinbase for CEMAC country %s',
    (country) => {
      expect(providerOrderForCountry(country)).toEqual(['transak', 'moonpay']);
    },
  );

  it('accepts lower-case CEMAC codes', () => {
    expect(providerOrderForCountry('cm')).toEqual(['transak', 'moonpay']);
  });

  it('orders Coinbase first for the US', () => {
    expect(providerOrderForCountry('US')).toEqual([
      'coinbase',
      'moonpay',
      'transak',
    ]);
  });

  it('defaults to MoonPay first with Coinbase last for other countries', () => {
    expect(providerOrderForCountry('FR')).toEqual([
      'moonpay',
      'transak',
      'coinbase',
    ]);
    expect(providerOrderForCountry('NG')).toEqual([
      'moonpay',
      'transak',
      'coinbase',
    ]);
  });

  it('uses the default ordering when the country is unknown', () => {
    expect(providerOrderForCountry(null)).toEqual([
      'moonpay',
      'transak',
      'coinbase',
    ]);
    expect(providerOrderForCountry(undefined)).toEqual([
      'moonpay',
      'transak',
      'coinbase',
    ]);
    expect(providerOrderForCountry('ZZ')).toEqual([
      'moonpay',
      'transak',
      'coinbase',
    ]);
  });
});

describe('orderedEnabledProviders', () => {
  it('returns the full geo order when everything is enabled', () => {
    expect(orderedEnabledProviders('CM', ALL_ENABLED)).toEqual([
      'transak',
      'moonpay',
    ]);
    expect(orderedEnabledProviders('US', ALL_ENABLED)).toEqual([
      'coinbase',
      'moonpay',
      'transak',
    ]);
  });

  it('filters disabled providers while preserving order', () => {
    expect(
      orderedEnabledProviders('US', {
        coinbase: false,
        moonpay: true,
        transak: true,
      }),
    ).toEqual(['moonpay', 'transak']);

    expect(
      orderedEnabledProviders('CM', {
        coinbase: true,
        moonpay: false,
        transak: true,
      }),
    ).toEqual(['transak']);
  });

  it('returns an empty list when no provider is enabled', () => {
    expect(
      orderedEnabledProviders('CM', {
        coinbase: false,
        moonpay: false,
        transak: false,
      }),
    ).toEqual([]);
  });

  it('never surfaces Coinbase for a CEMAC user even when enabled', () => {
    expect(orderedEnabledProviders('GA', ALL_ENABLED)).not.toContain('coinbase');
  });
});

describe('fiatCurrencyForProvider', () => {
  it('uses XAF for Transak and MoonPay in CEMAC', () => {
    expect(fiatCurrencyForProvider('transak', 'CM')).toBe('XAF');
    expect(fiatCurrencyForProvider('moonpay', 'TD')).toBe('XAF');
  });

  it('keeps Coinbase in USD everywhere', () => {
    expect(fiatCurrencyForProvider('coinbase', 'CM')).toBe('USD');
    expect(fiatCurrencyForProvider('coinbase', 'US')).toBe('USD');
  });

  it('falls back to USD outside CEMAC', () => {
    expect(fiatCurrencyForProvider('transak', 'US')).toBe('USD');
    expect(fiatCurrencyForProvider('moonpay', 'FR')).toBe('USD');
    expect(fiatCurrencyForProvider('transak', null)).toBe('USD');
  });
});

describe('isCemacCountry', () => {
  it('recognizes all six CEMAC members', () => {
    for (const country of CEMAC_COUNTRIES) {
      expect(isCemacCountry(country)).toBe(true);
    }
  });

  it('rejects non-members and malformed values', () => {
    expect(isCemacCountry('US')).toBe(false);
    expect(isCemacCountry('NG')).toBe(false);
    expect(isCemacCountry(null)).toBe(false);
    expect(isCemacCountry('cameroon')).toBe(false);
  });
});

describe('countryFromLocale', () => {
  it('extracts the region subtag', () => {
    expect(countryFromLocale('fr-CM')).toBe('CM');
    expect(countryFromLocale('en-US')).toBe('US');
    expect(countryFromLocale('en_US')).toBe('US');
    expect(countryFromLocale('zh-Hans-CN')).toBe('CN');
  });

  it('returns null for bare language codes and garbage', () => {
    expect(countryFromLocale('fr')).toBeNull();
    expect(countryFromLocale('')).toBeNull();
    expect(countryFromLocale(null)).toBeNull();
    expect(countryFromLocale(undefined)).toBeNull();
  });
});

describe('ramp blocked jurisdictions (derived from embargo.ts)', () => {
  it('contains every embargoed country from embargo.ts', () => {
    for (const country of EMBARGOED_COUNTRIES) {
      expect(SANCTIONED_COUNTRIES.has(country)).toBe(true);
    }
  });

  it('adds the ramp-only extras (RU, BY) without widening the app-wide block', () => {
    expect([...RAMP_ONLY_BLOCKED_COUNTRIES].sort()).toEqual(['BY', 'RU']);
    for (const country of RAMP_ONLY_BLOCKED_COUNTRIES) {
      expect(SANCTIONED_COUNTRIES.has(country)).toBe(true);
      // The main geo-block (middleware, API choke points) deliberately leaves
      // RU/BY open — widening it is an owner/counsel decision, not a ramp one.
      expect(EMBARGOED_COUNTRIES.has(country)).toBe(false);
    }
  });

  it('is exactly the union of the two sets', () => {
    expect(new Set(SANCTIONED_COUNTRIES)).toEqual(
      new Set([...EMBARGOED_COUNTRIES, ...RAMP_ONLY_BLOCKED_COUNTRIES]),
    );
  });

  it('matches blocked countries case-insensitively and rejects malformed values', () => {
    expect(isSanctionedCountry('IR')).toBe(true);
    expect(isSanctionedCountry(' ir ')).toBe(true);
    expect(isSanctionedCountry('ru')).toBe(true);
    expect(isSanctionedCountry('CM')).toBe(false);
    expect(isSanctionedCountry('US')).toBe(false);
    expect(isSanctionedCountry(null)).toBe(false);
    expect(isSanctionedCountry(undefined)).toBe(false);
    expect(isSanctionedCountry('IRN')).toBe(false);
  });

  it.each([...EMBARGOED_UA_REGIONS])(
    'blocks embargoed Ukrainian region %s from the region header',
    (region) => {
      expect(isSanctionedCountry('UA', region)).toBe(true);
      expect(isSanctionedCountry('ua', ` ${region} `)).toBe(true);
    },
  );

  it('leaves the rest of Ukraine open', () => {
    expect(isSanctionedCountry('UA', '30')).toBe(false);
    expect(isSanctionedCountry('UA', '')).toBe(false);
    expect(isSanctionedCountry('UA', null)).toBe(false);
    expect(isSanctionedCountry('UA')).toBe(false);
  });

  it('ignores the region outside Ukraine', () => {
    expect(isSanctionedCountry('FR', '43')).toBe(false);
    expect(isSanctionedCountry('CM', '09')).toBe(false);
  });

  it('offers no ramp provider in a blocked country', () => {
    for (const country of SANCTIONED_COUNTRIES) {
      expect(providerOrderForCountry(country)).toEqual([]);
    }
  });
});

describe('provider flags from env', () => {
  const FLAG_KEYS = [
    'NEXT_PUBLIC_COINBASE_ONRAMP_ENABLED',
    'NEXT_PUBLIC_MOONPAY_ENABLED',
    'NEXT_PUBLIC_TRANSAK_ENABLED',
    'NEXT_PUBLIC_MOONPAY_API_KEY',
    'MOONPAY_SECRET_KEY',
    'NEXT_PUBLIC_TRANSAK_API_KEY',
    'TRANSAK_API_SECRET',
    'CDP_API_KEY_ID',
    'CDP_API_KEY_SECRET',
  ] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of FLAG_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of FLAG_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('defaults every provider to disabled (fail closed)', () => {
    expect(readClientProviderFlags()).toEqual({
      coinbase: false,
      moonpay: false,
      transak: false,
    });
  });

  it('reads the public flags', () => {
    process.env.NEXT_PUBLIC_TRANSAK_ENABLED = 'true';
    process.env.NEXT_PUBLIC_MOONPAY_ENABLED = 'TRUE';
    expect(readClientProviderFlags()).toEqual({
      coinbase: false,
      moonpay: true,
      transak: true,
    });
  });

  it('server availability requires the provider secrets, not just the flag', () => {
    process.env.NEXT_PUBLIC_TRANSAK_ENABLED = 'true';
    process.env.NEXT_PUBLIC_MOONPAY_ENABLED = 'true';
    process.env.NEXT_PUBLIC_COINBASE_ONRAMP_ENABLED = 'true';

    // Flags on, secrets missing → everything unavailable.
    expect(readServerProviderAvailability()).toEqual({
      coinbase: false,
      moonpay: false,
      transak: false,
    });

    process.env.NEXT_PUBLIC_TRANSAK_API_KEY = 'pk_transak';
    process.env.TRANSAK_API_SECRET = 'transak-secret';
    process.env.NEXT_PUBLIC_MOONPAY_API_KEY = 'pk_moonpay';
    process.env.MOONPAY_SECRET_KEY = 'sk_moonpay';
    expect(readServerProviderAvailability()).toEqual({
      coinbase: false, // CDP keys still missing
      moonpay: true,
      transak: true,
    });

    process.env.CDP_API_KEY_ID = 'cdp-id';
    process.env.CDP_API_KEY_SECRET = 'cdp-secret';
    expect(readServerProviderAvailability()).toEqual({
      coinbase: true,
      moonpay: true,
      transak: true,
    });
  });

  it('server availability stays false when the public flag is off despite secrets', () => {
    process.env.TRANSAK_API_SECRET = 'transak-secret';
    process.env.NEXT_PUBLIC_TRANSAK_API_KEY = 'pk_transak';
    expect(readServerProviderAvailability().transak).toBe(false);
  });
});
