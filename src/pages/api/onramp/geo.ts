/**
 * GET /api/onramp/geo
 *
 * Tiny server-side geo + provider-availability probe for the ramp picker
 * (2026-06 GTM audit: money-in must work in the CEMAC launch geography).
 *
 * - Country comes from the `x-vercel-ip-country` header Vercel sets at the
 *   edge. Off Vercel (local dev, Heroku without a geo proxy) the header is
 *   absent and the client falls back to navigator.language / its stored
 *   override.
 * - `providers` is the authoritative availability map: the public
 *   NEXT_PUBLIC_*_ENABLED flag AND the server-side secrets each provider
 *   needs. A flag-enabled but secret-less provider reports false here so it
 *   never appears in the picker. No secrets are echoed — booleans only.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import {
  normalizeCountryCode,
  readServerProviderAvailability,
} from '../../../lib/ramp-geo';

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const rawCountry = req.headers['x-vercel-ip-country'];
  const country = normalizeCountryCode(
    Array.isArray(rawCountry) ? rawCountry[0] : rawCountry ?? null,
  );

  // Per-user geo — never let a shared cache serve another user's country.
  res.setHeader('Cache-Control', 'private, no-store');

  return res.status(200).json({
    country,
    source: country ? 'header' : 'unknown',
    providers: readServerProviderAvailability(),
  });
}
