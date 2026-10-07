// sui-price-reading.ts — which SUI prices a circle may be pinned to.
//
// /api/sui-price (and price-service.ts, the client cache in front of it)
// never answers without a number: a live quote, a cached quote up to six
// hours old when every live source fails, and past that a hardcoded
// FALLBACK_PRICE. Any of them is fine for a dashboard's "≈ $" label. Only
// the first two are fine for a new circle: create-circle.tsx converts the
// organizer's amount to SUI once, and package v11 pins that SUI amount for
// the life of the circle, so a circle priced on the hardcoded number has
// shares set at a price nobody ever quoted. The API says which kind of
// number it sent (`source`, `stale`, `fallback`, `fetchedAt`); this module
// turns that into the one question the create form asks.

/** The server's own window for serving a cached quote (SERVER_STALE_TTL_MS). */
export const SUI_PRICE_MAX_STALE_MS = 6 * 60 * 60 * 1000;

/** The `data` of a /api/sui-price answer, or the client cache's copy of it. */
export interface SuiPriceReading {
  price: number | null;
  /** 'CoinGecko', 'Binance (stale-cache)', 'fallback', 'client-fallback', ... */
  source: string;
  /** Not a live quote: a cached one (`fallback` false) or the hardcoded number. */
  stale: boolean;
  /** The hardcoded FALLBACK_PRICE, server- or client-side. Never pin it. */
  fallback: boolean;
  /** When a live source last quoted this price (epoch ms); null for the fallback. */
  fetchedAt: number | null;
}

/**
 * How long ago a live source quoted the price, or null when nobody did
 * (the fallback) or the reading does not say.
 */
export function suiPriceAgeMs(
  reading: SuiPriceReading | null | undefined,
  now: number = Date.now(),
): number | null {
  if (!reading || reading.fallback) return null;
  if (typeof reading.fetchedAt !== 'number' || !Number.isFinite(reading.fetchedAt)) return null;
  return Math.max(0, now - reading.fetchedAt);
}

/**
 * True for a price a circle may be pinned to: a live quote, or a cached one
 * at most SUI_PRICE_MAX_STALE_MS old. Never the hardcoded fallback, never a
 * stale quote of unknown age.
 */
export function isUsableSuiPrice(
  reading: SuiPriceReading | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!reading || reading.fallback) return false;
  const { price } = reading;
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) return false;
  if (!reading.stale) return true;
  const age = suiPriceAgeMs(reading, now);
  return age !== null && age <= SUI_PRICE_MAX_STALE_MS;
}

/** "<1 min", "12 min", "2 h": the same abbreviations in English and French. */
export function formatSuiPriceAge(ageMs: number): string {
  const minutes = Math.floor(Math.max(0, ageMs) / 60_000);
  if (minutes < 1) return '<1 min';
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h`;
}
