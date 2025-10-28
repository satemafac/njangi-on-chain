/**
 * 📊 Winston Logger Configuration
 * 
 * Centralized logging with:
 * - Console output (colored)
 * - File output (JSON format)
 * - Structured logging
 * - Correlation IDs
 */

import winston from 'winston';
import path from 'path';
import { getConfig } from '../config';

const config = getConfig();

// ============================================================
// Custom Format
// ============================================================

const customFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.metadata(),
  winston.format.printf(({ level, message, timestamp, correlationId, metadata }) => {
    const baseInfo = `${timestamp} [${level.toUpperCase()}]`;
    const corrId = correlationId ? ` [${correlationId}]` : '';
    const meta = metadata && Object.keys(metadata).length > 0 ? ` ${JSON.stringify(metadata)}` : '';
    return `${baseInfo}${corrId}: ${message}${meta}`;
  })
);

const jsonFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json(),
  winston.format.metadata()
);

// ============================================================
// Create Logger
// ============================================================

const logger = winston.createLogger({
  level: config.app.logLevel,
  format: jsonFormat,
  defaultMeta: {
    service: 'whatsapp-bot-backend',
    environment: config.app.nodeEnv,
  },
  transports: [
    // Console Transport
    new winston.transports.Console({
      format: customFormat,
    }),

    // File Transport - All Logs
    new winston.transports.File({
      filename: config.app.logFile,
      format: jsonFormat,
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    }),

    // File Transport - Errors Only
    new winston.transports.File({
      filename: path.join(path.dirname(config.app.logFile), 'error.log'),
      level: 'error',
      format: jsonFormat,
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    }),
  ],
  exceptionHandlers: [
    new winston.transports.File({
      filename: path.join(path.dirname(config.app.logFile), 'exceptions.log'),
    }),
  ],
  rejectionHandlers: [
    new winston.transports.File({
      filename: path.join(path.dirname(config.app.logFile), 'rejections.log'),
    }),
  ],
});

// ============================================================
// Logger Methods
// ============================================================

export interface LogContext {
  correlationId?: string;
  userId?: string;
  action?: string;
  [key: string]: any;
}

export const appLogger = {
  debug: (message: string, context?: LogContext) => {
    logger.debug(message, { correlationId: context?.correlationId, ...context });
  },

  info: (message: string, context?: LogContext) => {
    logger.info(message, { correlationId: context?.correlationId, ...context });
  },

  warn: (message: string, context?: LogContext) => {
    logger.warn(message, { correlationId: context?.correlationId, ...context });
  },

  error: (message: string, error?: Error | any, context?: LogContext) => {
    const errorDetails = {
      correlationId: context?.correlationId,
      errorName: error?.name,
      errorMessage: error?.message,
      errorCode: error?.code,
      stack: error?.stack,
      ...context,
    };
    logger.error(message, errorDetails);
  },

  // Structured logging for specific events
  logApiRequest: (
    method: string,
    path: string,
    correlationId: string,
    userId?: string
  ) => {
    logger.info('API Request', {
      correlationId,
      method,
      path,
      userId,
      type: 'api_request',
    });
  },

  logApiResponse: (
    method: string,
    path: string,
    statusCode: number,
    duration: number,
    correlationId: string
  ) => {
    logger.info('API Response', {
      correlationId,
      method,
      path,
      statusCode,
      duration,
      type: 'api_response',
    });
  },

  logBlockchainCall: (
    operation: string,
    packageId: string,
    duration: number,
    correlationId: string,
    success: boolean = true
  ) => {
    const level = success ? 'info' : 'warn';
    logger[level as 'info' | 'warn']('Blockchain Call', {
      correlationId,
      operation,
      packageId,
      duration,
      success,
      type: 'blockchain_call',
    });
  },

  logWhatsAppMessage: (
    direction: 'inbound' | 'outbound',
    phoneNumber: string,
    messageType: string,
    correlationId: string,
    success: boolean = true
  ) => {
    const level = success ? 'info' : 'warn';
    logger[level as 'info' | 'warn']('WhatsApp Message', {
      correlationId,
      direction,
      phoneNumber,
      messageType,
      success,
      type: 'whatsapp_message',
    });
  },

  logAuthAttempt: (
    provider: string,
    phoneNumber: string,
    correlationId: string,
    success: boolean = true
  ) => {
    const level = success ? 'info' : 'warn';
    logger[level as 'info' | 'warn']('Auth Attempt', {
      correlationId,
      provider,
      phoneNumber,
      success,
      type: 'auth_attempt',
    });
  },

  logEvent: (
    eventType: string,
    data: Record<string, any>,
    correlationId: string
  ) => {
    logger.info(`Event: ${eventType}`, {
      correlationId,
      ...data,
      type: 'event',
    });
  },
};

export default logger;
