/**
 * 📝 Request Logging Middleware
 * 
 * Logs all incoming requests with correlation IDs and timing
 */

import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { appLogger } from '../utils/logger';

export interface AuthenticatedRequest extends Request {
  correlationId?: string;
  userId?: string;
  requestStartTime?: number;
}

/**
 * Attach correlation ID and log request
 */
export const requestLoggerMiddleware = (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void => {
  // Generate or get correlation ID
  const correlationId = req.headers['x-correlation-id'] as string || uuidv4();
  req.correlationId = correlationId;
  req.requestStartTime = Date.now();

  // Log incoming request
  appLogger.logApiRequest(req.method, req.path, correlationId, req.userId);

  // Capture response
  const originalSend = res.send;

  res.send = function (data: any) {
    const duration = Date.now() - req.requestStartTime!;

    // Log outgoing response
    appLogger.logApiResponse(req.method, req.path, res.statusCode, duration, correlationId);

    // Send response
    return originalSend.call(this, data);
  };

  next();
};

/**
 * Middleware to extract user ID from headers or token
 */
export const userIdMiddleware = (
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction
): void => {
  // Try to extract from header first
  if (req.headers['x-user-id']) {
    req.userId = req.headers['x-user-id'] as string;
  }

  // Try to extract from authorization token
  if (!req.userId && req.headers.authorization) {
    try {
      // In production, decode JWT here
      // For now, just log it
      appLogger.debug('Authorization token present', { correlationId: req.correlationId });
    } catch (err) {
      appLogger.warn('Failed to parse authorization token', {
        correlationId: req.correlationId,
      });
    }
  }

  next();
};
