// trusted-client-ip.ts — shared client-IP resolution for API routes that
// rate-limit or geo-key by caller.
//
// On Vercel/Heroku/Fly the TLS-terminating proxy is the socket peer, so
// `req.socket.remoteAddress` is a private/internal address that is IDENTICAL
// across all real clients — rate-limiting on it collapses every user into one
// bucket. We therefore prefer a PUBLIC forwarded client IP (x-forwarded-for
// and friends), falling back to the socket IP only when no usable forwarded
// value exists. Private/loopback candidates are always skipped so a spoofed
// private header can't poison the key.
//
// Extracted verbatim from the coinbase onramp session route so every ramp
// endpoint shares one implementation instead of drifting (the options route
// previously trusted ONLY the socket IP, which was broken behind the proxy).

import { isIP } from 'node:net';
import type { NextApiRequest } from 'next';

function normalizeIp(rawIp: string | undefined): string | null {
  if (!rawIp) {
    return null;
  }

  const trimmed = rawIp.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed === '::1') {
    return '127.0.0.1';
  }

  if (trimmed.startsWith('::ffff:')) {
    return trimmed.replace('::ffff:', '');
  }

  return trimmed;
}

function parseIpCandidate(rawValue: string): string | null {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    return null;
  }

  const bracketedIpv6 = trimmed.match(/^\[(.+)](?::\d+)?$/);
  if (bracketedIpv6?.[1]) {
    return normalizeIp(bracketedIpv6[1]);
  }

  const ipv4WithPort = trimmed.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
  if (ipv4WithPort?.[1]) {
    return normalizeIp(ipv4WithPort[1]);
  }

  return normalizeIp(trimmed);
}

function isPrivateIpv4(ip: string): boolean {
  const segments = ip.split('.').map((segment) => Number(segment));
  if (
    segments.length !== 4 ||
    segments.some((segment) => !Number.isInteger(segment) || segment < 0 || segment > 255)
  ) {
    return false;
  }

  const [first, second] = segments;
  if (first === 10 || first === 127 || first === 0) {
    return true;
  }
  if (first === 169 && second === 254) {
    return true;
  }
  if (first === 172 && second >= 16 && second <= 31) {
    return true;
  }
  if (first === 192 && second === 168) {
    return true;
  }
  if (first === 100 && second >= 64 && second <= 127) {
    return true;
  }

  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === '::1' || normalized === '::') {
    return true;
  }
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) {
    return true;
  }
  if (
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb')
  ) {
    return true;
  }

  return false;
}

function isPrivateIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) {
    return isPrivateIpv4(ip);
  }
  if (version === 6) {
    return isPrivateIpv6(ip);
  }
  return false;
}

/** Reads a header, collapsing the string[] form to its first value. */
export function getHeaderValue(req: NextApiRequest, headerName: string): string | undefined {
  const value = req.headers[headerName];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function readForwardedClientIp(req: NextApiRequest): string | null {
  const headerCandidates = [
    getHeaderValue(req, 'x-forwarded-for'),
    getHeaderValue(req, 'x-real-ip'),
    getHeaderValue(req, 'cf-connecting-ip'),
    getHeaderValue(req, 'fly-client-ip'),
    getHeaderValue(req, 'x-client-ip'),
  ];

  for (const candidate of headerCandidates) {
    if (!candidate) {
      continue;
    }

    const parts = candidate.split(',').map((part) => part.trim()).filter(Boolean);
    for (const part of parts) {
      const parsed = parseIpCandidate(part);
      if (parsed && isIP(parsed) !== 0 && !isPrivateIp(parsed)) {
        return parsed;
      }
    }
  }

  return null;
}

/**
 * Best-effort public client IP: a public socket IP if we have one, else the
 * first public forwarded IP, else the socket IP even if unclassifiable, else
 * null. Suitable for rate-limit keys and coarse geo — NOT an authentication
 * signal (forwarded headers are attacker-influenced; treat as a soft key).
 */
export function getTrustedClientIp(req: NextApiRequest): string | null {
  const socketIp = parseIpCandidate(req.socket?.remoteAddress ?? '');
  if (socketIp && isIP(socketIp) !== 0 && !isPrivateIp(socketIp)) {
    return socketIp;
  }

  // In proxy environments (Vercel/Heroku/Fly), the socket IP is often private.
  // Prefer a forwarded public client IP in that case.
  const forwardedIp = readForwardedClientIp(req);
  if (forwardedIp) {
    return forwardedIp;
  }

  return socketIp && isIP(socketIp) !== 0 ? socketIp : null;
}
