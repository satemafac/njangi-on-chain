// A new SUI circle pins the SUI amount the create form priced, for life.
// /api/sui-price never answers without a number — when every live source
// fails it sends a hardcoded 3.71 — so the form must tell a quote from the
// fallback. These helpers are that distinction.

import {
  formatSuiPriceAge,
  isUsableSuiPrice,
  SUI_PRICE_MAX_STALE_MS,
  suiPriceAgeMs,
  type SuiPriceReading,
} from '../sui-price-reading';

const NOW = 1_760_000_000_000;
const HOUR = 60 * 60 * 1000;

const live: SuiPriceReading = {
  price: 1.37,
  source: 'CoinGecko',
  stale: false,
  fallback: false,
  fetchedAt: NOW,
};

describe('isUsableSuiPrice', () => {
  it('accepts a live quote and a fresh server-cached one', () => {
    expect(isUsableSuiPrice(live, NOW)).toBe(true);
    expect(
      isUsableSuiPrice(
        { ...live, source: 'CoinGecko (server-cache)', fetchedAt: NOW - 4 * 60 * 1000 },
        NOW,
      ),
    ).toBe(true);
  });

  it('refuses the hardcoded fallback, server- or client-side, whatever it says about staleness', () => {
    expect(
      isUsableSuiPrice({ price: 3.71, source: 'fallback', stale: true, fallback: true, fetchedAt: null }, NOW),
    ).toBe(false);
    expect(
      isUsableSuiPrice(
        { price: 3.71, source: 'client-fallback', stale: false, fallback: true, fetchedAt: NOW },
        NOW,
      ),
    ).toBe(false);
  });

  it('accepts a stale quote inside the six-hour window and refuses an older one', () => {
    const stale = { ...live, source: 'Binance (stale-cache)', stale: true };
    expect(isUsableSuiPrice({ ...stale, fetchedAt: NOW - 5 * HOUR }, NOW)).toBe(true);
    expect(isUsableSuiPrice({ ...stale, fetchedAt: NOW - SUI_PRICE_MAX_STALE_MS }, NOW)).toBe(true);
    expect(isUsableSuiPrice({ ...stale, fetchedAt: NOW - SUI_PRICE_MAX_STALE_MS - 1 }, NOW)).toBe(false);
  });

  it('refuses a stale quote of unknown age (a cache entry from before fetchedAt existed)', () => {
    expect(isUsableSuiPrice({ ...live, stale: true, fetchedAt: null }, NOW)).toBe(false);
  });

  it('refuses no reading and a reading without a positive number', () => {
    expect(isUsableSuiPrice(null, NOW)).toBe(false);
    expect(isUsableSuiPrice(undefined, NOW)).toBe(false);
    expect(isUsableSuiPrice({ ...live, price: null }, NOW)).toBe(false);
    expect(isUsableSuiPrice({ ...live, price: 0 }, NOW)).toBe(false);
    expect(isUsableSuiPrice({ ...live, price: Number.NaN }, NOW)).toBe(false);
  });
});

describe('suiPriceAgeMs', () => {
  it('measures from the live quote, never below zero', () => {
    expect(suiPriceAgeMs({ ...live, fetchedAt: NOW - 90_000 }, NOW)).toBe(90_000);
    expect(suiPriceAgeMs({ ...live, fetchedAt: NOW + 5_000 }, NOW)).toBe(0);
  });

  it('has no age for the fallback or an undated reading', () => {
    expect(
      suiPriceAgeMs({ price: 3.71, source: 'fallback', stale: true, fallback: true, fetchedAt: null }, NOW),
    ).toBeNull();
    expect(suiPriceAgeMs({ ...live, fetchedAt: null }, NOW)).toBeNull();
    expect(suiPriceAgeMs(null, NOW)).toBeNull();
  });
});

describe('formatSuiPriceAge', () => {
  it('prints minutes under an hour and whole hours after', () => {
    expect(formatSuiPriceAge(0)).toBe('<1 min');
    expect(formatSuiPriceAge(59_000)).toBe('<1 min');
    expect(formatSuiPriceAge(12 * 60_000 + 30_000)).toBe('12 min');
    expect(formatSuiPriceAge(HOUR)).toBe('1 h');
    expect(formatSuiPriceAge(5 * HOUR + 59 * 60_000)).toBe('5 h');
  });
});
