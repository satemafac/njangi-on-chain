// ramp-geo.ts — Geo-aware fiat on-ramp routing (2026-06 GTM audit fix).
//
// The June 2026 readiness review found money-in was unusable in the launch
// geography: the geo-aware RampPicker was dead code and every live flow
// hardcoded Coinbase with country="US", so a Cameroon/CEMAC user could not
// fund a wallet in-app at all. This module is the single source of truth
// for:
//   (a) detecting the user's country,
//   (b) ordering ramp providers for that country, and
//   (c) choosing the fiat currency each provider checks out in.
//
// Country detection order (client side):
//   1. explicit user override persisted in localStorage,
//   2. server-detected `x-vercel-ip-country` via GET /api/onramp/geo,
//   3. the region subtag of navigator.language,
//   4. unknown → default provider ordering.
//
// Provider availability: the NEXT_PUBLIC_*_ENABLED flags are the client
// floor, but the /api/onramp/geo response is authoritative — it also checks
// the server-side secrets each provider needs (e.g. TRANSAK_API_SECRET), so
// a flag-enabled but secret-less provider never appears in the picker.

export type RampProviderId = 'coinbase' | 'moonpay' | 'transak';

export interface RampProviderFlags {
  coinbase: boolean;
  moonpay: boolean;
  transak: boolean;
}

export const RAMP_PROVIDER_LABELS: Record<RampProviderId, string> = {
  coinbase: 'Coinbase',
  moonpay: 'MoonPay',
  transak: 'Transak',
};

/**
 * CEMAC member states (XAF / Central African CFA franc zone) — the launch
 * geography. Coinbase Onramp does not serve these markets; Transak is the
 * XAF-capable primary and MoonPay the fallback.
 */
export const CEMAC_COUNTRIES: ReadonlySet<string> = new Set([
  'CM', // Cameroon
  'GA', // Gabon
  'TD', // Chad
  'CF', // Central African Republic
  'CG', // Republic of the Congo
  'GQ', // Equatorial Guinea
]);

/** Returns an upper-cased ISO 3166-1 alpha-2 code, or null when malformed. */
export function normalizeCountryCode(
  raw: string | null | undefined,
): string | null {
  if (!raw) return null;
  const candidate = raw.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(candidate) ? candidate : null;
}

export function isCemacCountry(country: string | null | undefined): boolean {
  const normalized = normalizeCountryCode(country);
  return normalized !== null && CEMAC_COUNTRIES.has(normalized);
}

/**
 * Comprehensively OFAC-sanctioned jurisdictions (US sanctions programs the
 * ramp partners themselves are bound by): Iran, North Korea, Cuba, Syria,
 * plus Russia/Belarus (broad 2022+ programs the ramps block anyway).
 * Crimea/Donetsk/Luhansk are region-level within UA and cannot be expressed
 * as ISO-3166 alpha-2 — the ramps' own KYC handles those; we block at the
 * country level only.
 *
 * As the ramp COORDINATOR (not the money handler) we should not route users
 * from these jurisdictions to on-ramps at all: `providerOrderForCountry`
 * returns [] and the server session endpoints reject with BLOCKED_REGION
 * before any provider widget is offered.
 */
export const SANCTIONED_COUNTRIES: ReadonlySet<string> = new Set([
  'IR', // Iran
  'KP', // North Korea
  'CU', // Cuba
  'SY', // Syria
  'RU', // Russia
  'BY', // Belarus
]);

export function isSanctionedCountry(country: string | null | undefined): boolean {
  const normalized = normalizeCountryCode(country);
  return normalized !== null && SANCTIONED_COUNTRIES.has(normalized);
}

/**
 * Ordered provider preference for a country (before enablement filtering):
 * - CEMAC (CM, GA, TD, CF, CG, GQ): [transak, moonpay] — Coinbase is
 *   unsupported there and is omitted entirely.
 * - US: [coinbase, moonpay, transak].
 * - Everywhere else / unknown: [moonpay, transak, coinbase] — Coinbase last
 *   because its session endpoint rejects non-US countries server-side.
 */
export function providerOrderForCountry(
  country: string | null | undefined,
): RampProviderId[] {
  const normalized = normalizeCountryCode(country);
  // Sanctioned jurisdictions get NO providers. RampPicker already renders
  // an empty-provider fallback state, so this degrades gracefully in the UI.
  if (normalized && SANCTIONED_COUNTRIES.has(normalized)) {
    return [];
  }
  if (normalized && CEMAC_COUNTRIES.has(normalized)) {
    return ['transak', 'moonpay'];
  }
  if (normalized === 'US') {
    return ['coinbase', 'moonpay', 'transak'];
  }
  return ['moonpay', 'transak', 'coinbase'];
}

/**
 * Client-visible enablement flags. NOTE: these must stay direct
 * `process.env.NEXT_PUBLIC_*` member accesses so Next.js can inline them
 * into the browser bundle. All default to disabled (fail closed).
 */
export function readClientProviderFlags(): RampProviderFlags {
  return {
    coinbase:
      (process.env.NEXT_PUBLIC_COINBASE_ONRAMP_ENABLED ?? 'false').toLowerCase() ===
      'true',
    moonpay:
      (process.env.NEXT_PUBLIC_MOONPAY_ENABLED ?? 'false').toLowerCase() ===
      'true',
    transak:
      (process.env.NEXT_PUBLIC_TRANSAK_ENABLED ?? 'false').toLowerCase() ===
      'true',
  };
}

/**
 * Server-side provider availability: the public flag AND the secrets the
 * provider needs to actually complete a session + verified webhook flow.
 * Only meaningful on the server (secrets are never shipped to the browser);
 * exposed to clients via GET /api/onramp/geo.
 */
export function readServerProviderAvailability(
  env: NodeJS.ProcessEnv = process.env,
): RampProviderFlags {
  const flags = readClientProviderFlags();
  return {
    coinbase:
      flags.coinbase &&
      Boolean(env.CDP_API_KEY_ID) &&
      Boolean(env.CDP_API_KEY_SECRET),
    moonpay:
      flags.moonpay &&
      Boolean(env.NEXT_PUBLIC_MOONPAY_API_KEY) &&
      Boolean(env.MOONPAY_SECRET_KEY),
    transak:
      flags.transak &&
      Boolean(env.NEXT_PUBLIC_TRANSAK_API_KEY) &&
      Boolean(env.TRANSAK_API_SECRET),
  };
}

/** Geo-ordered providers with disabled providers filtered out. */
export function orderedEnabledProviders(
  country: string | null | undefined,
  flags: RampProviderFlags,
): RampProviderId[] {
  return providerOrderForCountry(country).filter((provider) => flags[provider]);
}

/**
 * Fiat currency (upper-case ISO 4217) each provider should check out in for
 * a country. Transak and MoonPay both support XAF for the CEMAC zone;
 * Coinbase is USD-only. Callers must NOT forward a USD-denominated amount
 * when the returned currency is not USD — let the provider widget price the
 * purchase in the local currency instead.
 */
export function fiatCurrencyForProvider(
  provider: RampProviderId,
  country: string | null | undefined,
): string {
  if (isCemacCountry(country) && (provider === 'transak' || provider === 'moonpay')) {
    return 'XAF';
  }
  return 'USD';
}

/**
 * Extracts the ISO region subtag from a BCP-47 locale string, e.g.
 * "fr-CM" → "CM", "en-US" → "US", "zh-Hans-CN" → "CN", "fr" → null.
 */
export function countryFromLocale(
  locale: string | null | undefined,
): string | null {
  if (!locale) return null;
  const subtags = locale.trim().split(/[-_]/);
  // Skip subtags[0] (the language); a bare "fr" implies no country.
  for (let i = 1; i < subtags.length; i += 1) {
    const normalized = normalizeCountryCode(subtags[i]);
    if (normalized) return normalized;
  }
  return null;
}

/** Client-only: region subtag of navigator.language, or null. */
export function countryFromNavigatorLanguage(): string | null {
  if (typeof navigator === 'undefined') return null;
  return countryFromLocale(navigator.language);
}

const COUNTRY_OVERRIDE_STORAGE_KEY = 'njangi.onramp.countryOverride';

/**
 * Sentinel override meaning "outside any specially-routed region" — ZZ is
 * the ISO 3166 user-assigned "unknown" code, and maps to the default
 * provider ordering.
 */
export const COUNTRY_OVERRIDE_OTHER = 'ZZ';

/** Explicit user region override persisted in localStorage (client only). */
export function getStoredCountryOverride(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return normalizeCountryCode(
      window.localStorage.getItem(COUNTRY_OVERRIDE_STORAGE_KEY),
    );
  } catch {
    return null;
  }
}

/** Persists (or clears, with null) the user's region override. */
export function setStoredCountryOverride(country: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    const normalized = normalizeCountryCode(country);
    if (normalized) {
      window.localStorage.setItem(COUNTRY_OVERRIDE_STORAGE_KEY, normalized);
    } else {
      window.localStorage.removeItem(COUNTRY_OVERRIDE_STORAGE_KEY);
    }
  } catch {
    // Storage unavailable (private mode) — override is best-effort.
  }
}

export interface RampGeoResponse {
  country: string | null;
  source: 'header' | 'unknown';
  providers: RampProviderFlags;
}

/**
 * Fetches the server-detected country + authoritative provider availability
 * from GET /api/onramp/geo. Returns null on any failure so callers can fall
 * back to client-side detection and the public flags.
 */
export async function fetchRampGeo(
  fetchImpl?: typeof fetch,
): Promise<RampGeoResponse | null> {
  const doFetch =
    fetchImpl ?? (typeof fetch !== 'undefined' ? fetch : undefined);
  if (!doFetch) return null;
  try {
    const response = await doFetch('/api/onramp/geo', {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as Partial<RampGeoResponse> | null;
    if (!payload || typeof payload !== 'object') return null;
    const providers = payload.providers;
    return {
      country: normalizeCountryCode(
        typeof payload.country === 'string' ? payload.country : null,
      ),
      source: payload.source === 'header' ? 'header' : 'unknown',
      providers:
        providers && typeof providers === 'object'
          ? {
              coinbase: providers.coinbase === true,
              moonpay: providers.moonpay === true,
              transak: providers.transak === true,
            }
          : readClientProviderFlags(),
    };
  } catch {
    return null;
  }
}
