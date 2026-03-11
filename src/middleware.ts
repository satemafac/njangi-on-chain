import { NextRequest, NextResponse } from 'next/server';
import { getCanonicalBaseOrigin, isHerokuHostname } from '@/lib/canonical-host';

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
  const requestHostname = request.nextUrl.hostname;

  if (
    process.env.NODE_ENV === 'production' &&
    canonicalOrigin &&
    request.nextUrl.origin !== canonicalOrigin &&
    isHerokuHostname(requestHostname)
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
