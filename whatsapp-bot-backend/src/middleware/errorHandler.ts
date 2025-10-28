/**
 * 🚨 Global Error Handler Middleware
 * 
 * Catches and formats all errors consistently
 */

import { Request, Response, NextFunction } from 'express';
import { appLogger } from '../utils/logger';
import { isAppError, toAppError } from '../utils/errors';

export interface AuthenticatedRequest extends Request {
  correlationId?: string;
  userId?: string;
}

/**
 * Express error handler middleware
 */
export const errorHandler = (
  err: any,
  _req: AuthenticatedRequest,
  res: Response,
  _next: NextFunction
): void => {
  const correlationId = _req.correlationId || 'unknown';
  const appError = isAppError(err) ? err : toAppError(err);

  // Log the error
  appLogger.error(`${appError.name}: ${appError.message}`, err, {
    correlationId,
    code: appError.code,
    statusCode: appError.statusCode,
  });

  // Send error response
  res.status(appError.statusCode).json(appError.toJSON(correlationId));
};

/**
 * Async error wrapper for route handlers
 */
export const asyncHandler = (fn: Function) => {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

/**
 * 404 handler
 */
export const notFoundHandler = (_req: Request, res: Response): void => {
  res.status(404).json({
    code: 'NOT_FOUND',
    message: 'Route not found',
    statusCode: 404,
  });
};
