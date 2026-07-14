import { NextRequest, NextResponse } from 'next/server';
import { getCanonicalBaseOrigin, preferCanonicalOrigin } from '@/lib/canonical-host';
import { isEmbargoedHeaders } from '@/lib/embargo';

// App-route prefixes blocked for embargoed jurisdictions
// (docs/sanctions-program.md). Marketing/legal/learn pages stay visible —
// the block covers the routes where circles are created, joined, funded,
// and managed. /restricted itself must never appear here (redirect loop).
const GEO_BLOCKED_PREFIXES = [
  '/dashboard',
  '/create-circle',
  '/circle',
  '/pool',
  '/auth',
  '/admin',
  '/automation',
];

function addSecurityHeaders(response: NextResponse): NextResponse {
  response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('X-XSS-Protection', '1; mode=block');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  return response;
}

export function middleware(request: NextRequest) {
  const canonicalOrigin = getCanonicalBaseOrigin();
  const preferredOrigin = preferCanonicalOrigin(request.nextUrl.origin);

  if (
    process.env.NODE_ENV === 'production' &&
    canonicalOrigin &&
    preferredOrigin === canonicalOrigin &&
    request.nextUrl.origin !== canonicalOrigin
  ) {
    const redirectUrl = new URL(request.nextUrl.pathname + request.nextUrl.search, canonicalOrigin);
    return addSecurityHeaders(NextResponse.redirect(redirectUrl, 308));
  }

  // Force HTTPS in production
  if (process.env.NODE_ENV === 'production') {
    const protocol = request.headers.get('x-forwarded-proto');
    const host = request.headers.get('host');

    // If request is HTTP, redirect to HTTPS
    if (protocol === 'http') {
      const httpsUrl = `https://${host}${request.nextUrl.pathname}${request.nextUrl.search}`;
      return addSecurityHeaders(NextResponse.redirect(httpsUrl, 301));
    }
  }

  // Embargoed-jurisdiction block (docs/sanctions-program.md). Reads the
  // Vercel geo headers (Next 15: headers only — request.geo is gone). The
  // console line is the evidence trail; edge middleware cannot reach
  // Postgres, and the API choke points log there instead.
  const { pathname } = request.nextUrl;
  if (
    GEO_BLOCKED_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)) &&
    isEmbargoedHeaders((name) => request.headers.get(name))
  ) {
    console.log(
      `[geo-block] country=${request.headers.get('x-vercel-ip-country') ?? '?'} region=${request.headers.get('x-vercel-ip-country-region') ?? '?'} path=${pathname}`,
    );
    return addSecurityHeaders(
      NextResponse.redirect(new URL('/restricted', request.nextUrl.origin), 302),
    );
  }

  // Create response
  return addSecurityHeaders(NextResponse.next());
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - api (API routes)
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     */
    '/((?!api|_next/static|_next/image|favicon.ico).*)',
  ],
}; 
