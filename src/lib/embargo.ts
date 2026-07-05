// embargo.ts — Embargoed-jurisdiction constants and matchers for the OFAC
// program (docs/compliance-roadmap-cex-dex-non-kyc.md §A1, program details
// in docs/sanctions-program.md).
//
// This module is imported by src/middleware.ts, which Next.js compiles
// into the EDGE bundle: keep it dependency-free. In particular it must
// never import src/lib/sanctions.ts (which pulls in the pg pool) — that
// would break the edge build. Middleware and API routes both consume
// these helpers so the page-level and API-level blocks can never drift.

/**
 * Comprehensively embargoed jurisdictions (US OFAC): Iran, North Korea,
 * Syria, Cuba. Russia/Belarus are sectoral programs, not comprehensive
 * embargoes — they are deliberately NOT blocked here.
 */
export const EMBARGOED_COUNTRIES = new Set(['IR', 'KP', 'SY', 'CU']);

/**
 * Ukrainian ISO-3166-2 region codes under comprehensive embargo:
 * Crimea (43), Sevastopol (40), Donetsk (14), Luhansk (09). Vercel sends
 * the subdivision in `x-vercel-ip-country-region`.
 */
export const EMBARGOED_UA_REGIONS = new Set(['43', '40', '14', '09']);

export function isEmbargoedLocation(
  country: string | null | undefined,
  region: string | null | undefined,
): boolean {
  const c = (country ?? '').trim().toUpperCase();
  if (!c) return false;
  if (EMBARGOED_COUNTRIES.has(c)) return true;
  if (c === 'UA') {
    const r = (region ?? '').trim().toUpperCase();
    return EMBARGOED_UA_REGIONS.has(r);
  }
  return false;
}

/**
 * Geo-block kill switch. Default-ON: the block runs unless the flag is
 * explicitly the string "false" (a sanctions control must never be
 * silently opt-in — an unset var in production means ON).
 */
export function isGeoBlockEnabled(): boolean {
  return (process.env.SANCTIONS_GEO_BLOCK_ENABLED ?? 'true').toLowerCase() !== 'false';
}

/**
 * Header-based check for Node API routes and edge middleware alike.
 * Accepts a minimal header-getter so both `NextRequest` (edge) and
 * `NextApiRequest` (node) can use it without type gymnastics.
 */
export function isEmbargoedHeaders(getHeader: (name: string) => string | null | undefined): boolean {
  if (!isGeoBlockEnabled()) return false;
  return isEmbargoedLocation(
    getHeader('x-vercel-ip-country'),
    getHeader('x-vercel-ip-country-region'),
  );
}

/** Stable 403 body for embargoed-region refusals on API routes. */
export function embargoErrorBody(): {
  success: false;
  error: 'EMBARGOED_REGION';
  code: 'EMBARGOED_REGION';
  message: string;
} {
  return {
    success: false,
    error: 'EMBARGOED_REGION',
    code: 'EMBARGOED_REGION',
    message: "Njangi On-Chain isn't available in your region.",
  };
}
