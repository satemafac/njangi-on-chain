/**
 * 🔐 Admin Authentication Middleware
 * 
 * Verifies zkLogin admin authentication for protected routes
 * - Token validation
 * - Permission checking
 * - Request logging/auditing
 * - Graceful error handling
 */

import { NextApiRequest, NextApiResponse } from 'next';
import { createLogger, format, transports } from 'winston';

// Configure logger for admin actions
const adminLogger = createLogger({
  level: 'info',
  format: format.combine(
    format.timestamp(),
    format.json()
  ),
  transports: [
    new transports.File({ filename: 'admin-actions.log' }),
    new transports.Console()
  ],
});

// ============================================================
// Types
// ============================================================

export type AdminAction = 'link_circle' | 'unlink_circle' | 'approve_payout' | 'manage_settings' | 'view_logs';

export interface AdminPermission {
  action: AdminAction;
  circleId?: string;
  expiresAt?: Date;
}

export interface AuthenticatedRequest extends NextApiRequest {
  admin?: {
    suiAddress: string;
    sessionId: string;
    permissions: AdminPermission[];
    token: string;
  };
}

export interface MiddlewareOptions {
  requiredPermission?: AdminPermission['action'];
  circleIdParam?: string; // Query/body param for circle ID
  logging?: boolean;
}

// ============================================================
// Middleware Functions
// ============================================================

/**
 * Extract token from request (header, cookie, or body)
 */
function extractToken(req: NextApiRequest): string | null {
  // 1. Check Authorization header
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }

  // 2. Check Cookie
  const cookies = req.headers.cookie;
  if (cookies) {
    const match = cookies.match(/admin_session=([^;]+)/);
    if (match) {
      return match[1];
    }
  }

  // 3. Check request body
  if (req.body?.token) {
    return req.body.token;
  }

  if (req.body?.sessionId) {
    return req.body.sessionId;
  }

  return null;
}

/**
 * Verify admin authentication
 */
function verifyAdminToken(token: string): { suiAddress: string; sessionId: string; permissions: AdminPermission[] } | null {
  if (!token || typeof token !== 'string' || token.length === 0) {
    return null;
  }

  // Simple token validation - in production, verify JWT signature
  // This is a placeholder implementation
  try {
    return {
      suiAddress: '', // Extracted from token in production
      sessionId: token,
      permissions: [
        { action: 'link_circle' },
        { action: 'unlink_circle' }
      ]
    };
  } catch {
    return null;
  }
}

/**
 * Check if admin has specific permission
 */
function hasPermission(
  permissions: AdminPermission[],
  action: AdminPermission['action'],
  circleId?: string
): boolean {
  return permissions.some(perm => {
    if (perm.action !== action) return false;
    if (perm.expiresAt && perm.expiresAt < new Date()) return false;
    if (perm.circleId && perm.circleId !== circleId) return false;
    return true;
  });
}

/**
 * Main authentication middleware for API routes
 */
export function withAdminAuth(options: MiddlewareOptions = {}) {
  return (handler: (req: AuthenticatedRequest, res: NextApiResponse) => Promise<void> | void) => {
    return async (req: AuthenticatedRequest, res: NextApiResponse) => {
      try {
        const token = extractToken(req);

        if (!token) {
          adminLogger.warn('❌ Missing authentication token', {
            path: req.url,
            ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress
          });

          return res.status(401).json({
            success: false,
            error: 'Missing authentication token',
            requiresReauth: true
          });
        }

        const adminData = verifyAdminToken(token);

        if (!adminData) {
          adminLogger.warn('❌ Invalid or expired token', {
            path: req.url,
            ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress
          });

          return res.status(401).json({
            success: false,
            error: 'Invalid or expired token',
            requiresReauth: true
          });
        }

        if (options.requiredPermission) {
          let circleId: string | undefined;
          if (options.circleIdParam) {
            circleId = (req.query[options.circleIdParam] || req.body?.[options.circleIdParam]) as string;
          }

          const hasPermissionForAction = hasPermission(
            adminData.permissions,
            options.requiredPermission,
            circleId
          );

          if (!hasPermissionForAction) {
            adminLogger.warn('❌ Admin lacks required permission', {
              suiAddress: adminData.suiAddress,
              permission: options.requiredPermission,
              circleId,
              path: req.url
            });

            return res.status(403).json({
              success: false,
              error: `Missing required permission: ${options.requiredPermission}`
            });
          }
        }

        req.admin = {
          suiAddress: adminData.suiAddress,
          sessionId: adminData.sessionId,
          permissions: adminData.permissions,
          token: token as string
        };

        if (options.logging !== false) {
          adminLogger.info('✅ Admin authenticated', {
            suiAddress: adminData.suiAddress,
            path: req.url,
            method: req.method,
            permission: options.requiredPermission,
            ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress
          });
        }

        return handler(req, res);
      } catch (error) {
        adminLogger.error('❌ Middleware error', {
          error: error instanceof Error ? error.message : String(error),
          path: req.url
        });

        return res.status(500).json({
          success: false,
          error: 'Authentication middleware error'
        });
      }
    };
  };
}

/**
 * Audit logging middleware
 */
export function withAdminAuditLog(action: string) {
  return (handler: (req: AuthenticatedRequest, res: NextApiResponse) => Promise<void> | void) => {
    return async (req: AuthenticatedRequest, res: NextApiResponse) => {
      const startTime = Date.now();
      
      try {
        const result = handler(req, res);
        
        const duration = Date.now() - startTime;
        adminLogger.info('✅ Admin action completed', {
          action,
          suiAddress: req.admin?.suiAddress,
          circleId: req.query.id || req.body?.circleId,
          status: res.statusCode,
          duration,
          ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
          method: req.method,
          path: req.url
        });

        return result;
      } catch (error) {
        const duration = Date.now() - startTime;
        adminLogger.error('❌ Admin action failed', {
          action,
          suiAddress: req.admin?.suiAddress,
          circleId: req.query.id || req.body?.circleId,
          error: error instanceof Error ? error.message : String(error),
          duration,
          ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
          method: req.method,
          path: req.url
        });

        throw error;
      }
    };
  };
}

/**
 * Rate limiting middleware for admin actions
 */
export function withAdminRateLimit(maxRequests: number = 100, windowMs: number = 60000) {
  const requestMap = new Map<string, number[]>();

  return (handler: (req: AuthenticatedRequest, res: NextApiResponse) => Promise<void> | void) => {
    return async (req: AuthenticatedRequest, res: NextApiResponse) => {
      if (!req.admin) {
        return handler(req, res);
      }

      const key = req.admin.suiAddress;
      const now = Date.now();
      const windowStart = now - windowMs;

      let requests = requestMap.get(key) || [];
      requests = requests.filter(time => time > windowStart);

      if (requests.length >= maxRequests) {
        adminLogger.warn('⚠️ Admin rate limit exceeded', {
          suiAddress: req.admin.suiAddress,
          requests: requests.length,
          limit: maxRequests,
          window: windowMs
        });

        return res.status(429).json({
          success: false,
          error: 'Rate limit exceeded',
          retryAfter: Math.ceil((requests[0] + windowMs - now) / 1000)
        });
      }

      requests.push(now);
      requestMap.set(key, requests);

      return handler(req, res);
    };
  };
}

/**
 * Combine multiple middlewares
 */
type Middleware = (
  handler: (req: AuthenticatedRequest, res: NextApiResponse) => Promise<void> | void,
) => (req: AuthenticatedRequest, res: NextApiResponse) => Promise<void> | void;

export function withAdminMiddleware(
  handler: (req: AuthenticatedRequest, res: NextApiResponse) => Promise<void> | void,
  ...middlewares: Middleware[]
) {
  return middlewares.reduce<ReturnType<Middleware>>(
    (h, middleware) => middleware(h),
    handler,
  );
}

export function requireAdminAuth(req: AuthenticatedRequest) {
  if (!req.admin) {
    return {
      valid: false,
      error: 'Admin authentication required'
    };
  }

  return {
    valid: true,
    suiAddress: req.admin.suiAddress,
    sessionId: req.admin.sessionId,
    permissions: req.admin.permissions
  };
}

export function checkAdminPermission(
  req: AuthenticatedRequest,
  action: AdminPermission['action'],
  circleId?: string
): boolean {
  if (!req.admin) return false;
  return hasPermission(req.admin.permissions, action, circleId);
}

export function logAdminAction(
  action: string,
  suiAddress: string,
  details: Record<string, unknown> = {}
): void {
  adminLogger.info(`✅ ${action}`, {
    suiAddress,
    ...details,
    timestamp: new Date().toISOString()
  });
}
