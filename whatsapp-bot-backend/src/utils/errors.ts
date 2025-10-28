/**
 * 🚨 Custom Error Classes
 * 
 * Standardized error types for different scenarios
 */

export enum ErrorCode {
  // Validation errors (400s)
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  INVALID_INPUT = 'INVALID_INPUT',
  MISSING_PARAMETER = 'MISSING_PARAMETER',

  // Authentication errors (401)
  UNAUTHORIZED = 'UNAUTHORIZED',
  INVALID_TOKEN = 'INVALID_TOKEN',
  SESSION_EXPIRED = 'SESSION_EXPIRED',

  // Authorization errors (403)
  FORBIDDEN = 'FORBIDDEN',
  INSUFFICIENT_PERMISSIONS = 'INSUFFICIENT_PERMISSIONS',

  // Not found errors (404)
  NOT_FOUND = 'NOT_FOUND',
  RESOURCE_NOT_FOUND = 'RESOURCE_NOT_FOUND',

  // Conflict errors (409)
  CONFLICT = 'CONFLICT',
  DUPLICATE_ENTRY = 'DUPLICATE_ENTRY',

  // Sui blockchain errors
  SUI_RPC_ERROR = 'SUI_RPC_ERROR',
  SUI_TRANSACTION_ERROR = 'SUI_TRANSACTION_ERROR',
  INSUFFICIENT_GAS = 'INSUFFICIENT_GAS',
  OBJECT_NOT_FOUND = 'OBJECT_NOT_FOUND',

  // WhatsApp API errors
  WHATSAPP_API_ERROR = 'WHATSAPP_API_ERROR',
  MESSAGE_SEND_FAILED = 'MESSAGE_SEND_FAILED',
  WEBHOOK_VERIFICATION_FAILED = 'WEBHOOK_VERIFICATION_FAILED',

  // zkLogin/OAuth errors
  ZKLOGIN_ERROR = 'ZKLOGIN_ERROR',
  OAUTH_ERROR = 'OAUTH_ERROR',
  PROOF_VERIFICATION_FAILED = 'PROOF_VERIFICATION_FAILED',

  // External service errors (5xx)
  EXTERNAL_SERVICE_ERROR = 'EXTERNAL_SERVICE_ERROR',
  SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE',

  // Internal errors (500)
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  DATABASE_ERROR = 'DATABASE_ERROR',
  UNKNOWN_ERROR = 'UNKNOWN_ERROR',
}

export interface ErrorDetails {
  code: ErrorCode;
  message: string;
  statusCode: number;
  details?: Record<string, any>;
  timestamp?: Date;
  correlationId?: string;
}

export class AppError extends Error {
  public readonly code: ErrorCode;
  public readonly statusCode: number;
  public readonly details?: Record<string, any>;
  public readonly timestamp: Date;

  constructor(
    code: ErrorCode,
    message: string,
    statusCode: number = 500,
    details?: Record<string, any>
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
    this.timestamp = new Date();

    // Maintain proper prototype chain
    Object.setPrototypeOf(this, AppError.prototype);
  }

  toJSON(correlationId?: string): ErrorDetails {
    return {
      code: this.code,
      message: this.message,
      statusCode: this.statusCode,
      details: this.details,
      timestamp: this.timestamp,
      correlationId,
    };
  }
}

// Validation Error
export class ValidationError extends AppError {
  constructor(message: string, details?: Record<string, any>) {
    super(ErrorCode.VALIDATION_ERROR, message, 400, details);
    this.name = 'ValidationError';
    Object.setPrototypeOf(this, ValidationError.prototype);
  }
}

// Missing Parameter Error
export class MissingParameterError extends AppError {
  constructor(paramName: string) {
    super(
      ErrorCode.MISSING_PARAMETER,
      `Missing required parameter: ${paramName}`,
      400,
      { paramName }
    );
    this.name = 'MissingParameterError';
    Object.setPrototypeOf(this, MissingParameterError.prototype);
  }
}

// Authentication Error
export class AuthenticationError extends AppError {
  constructor(message: string = 'Authentication failed', details?: Record<string, any>) {
    super(ErrorCode.UNAUTHORIZED, message, 401, details);
    this.name = 'AuthenticationError';
    Object.setPrototypeOf(this, AuthenticationError.prototype);
  }
}

// Authorization Error
export class AuthorizationError extends AppError {
  constructor(message: string = 'Insufficient permissions', details?: Record<string, any>) {
    super(ErrorCode.FORBIDDEN, message, 403, details);
    this.name = 'AuthorizationError';
    Object.setPrototypeOf(this, AuthorizationError.prototype);
  }
}

// Not Found Error
export class NotFoundError extends AppError {
  constructor(resource: string, id?: string) {
    const message = id ? `${resource} not found: ${id}` : `${resource} not found`;
    super(ErrorCode.NOT_FOUND, message, 404, { resource, id });
    this.name = 'NotFoundError';
    Object.setPrototypeOf(this, NotFoundError.prototype);
  }
}

// Sui Error
export class SuiError extends AppError {
  constructor(message: string, code: ErrorCode = ErrorCode.SUI_RPC_ERROR, details?: Record<string, any>) {
    super(code, message, 502, details);
    this.name = 'SuiError';
    Object.setPrototypeOf(this, SuiError.prototype);
  }
}

// WhatsApp API Error
export class WhatsAppError extends AppError {
  constructor(message: string, details?: Record<string, any>) {
    super(ErrorCode.WHATSAPP_API_ERROR, message, 502, details);
    this.name = 'WhatsAppError';
    Object.setPrototypeOf(this, WhatsAppError.prototype);
  }
}

// zkLogin Error
export class ZkLoginError extends AppError {
  constructor(message: string, code: ErrorCode = ErrorCode.ZKLOGIN_ERROR, details?: Record<string, any>) {
    super(code, message, 401, details);
    this.name = 'ZkLoginError';
    Object.setPrototypeOf(this, ZkLoginError.prototype);
  }
}

// External Service Error
export class ExternalServiceError extends AppError {
  constructor(service: string, message: string, details?: Record<string, any>) {
    super(
      ErrorCode.EXTERNAL_SERVICE_ERROR,
      `${service} error: ${message}`,
      502,
      { service, ...details }
    );
    this.name = 'ExternalServiceError';
    Object.setPrototypeOf(this, ExternalServiceError.prototype);
  }
}

// Internal Error
export class InternalError extends AppError {
  constructor(message: string = 'Internal server error', details?: Record<string, any>) {
    super(ErrorCode.INTERNAL_ERROR, message, 500, details);
    this.name = 'InternalError';
    Object.setPrototypeOf(this, InternalError.prototype);
  }
}

/**
 * Check if error is an AppError instance
 */
export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/**
 * Convert any error to AppError
 */
export function toAppError(error: unknown, defaultMessage: string = 'An error occurred'): AppError {
  if (isAppError(error)) {
    return error;
  }

  if (error instanceof Error) {
    return new InternalError(error.message, {
      originalError: error.name,
      stack: error.stack,
    });
  }

  return new InternalError(defaultMessage, {
    originalError: String(error),
  });
}
