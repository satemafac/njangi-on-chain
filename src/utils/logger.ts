/**
 * Simple logger utility for browser/frontend environments
 */

export const appLogger = {
  info: (msg: string, data?: unknown) => {
    console.log(`[INFO] ${msg}`, data);
  },
  warn: (msg: string, data?: unknown) => {
    console.warn(`[WARN] ${msg}`, data);
  },
  error: (msg: string, data?: unknown) => {
    console.error(`[ERROR] ${msg}`, data);
  },
  debug: (msg: string, data?: unknown) => {
    if (process.env.NODE_ENV === 'development') {
      console.debug(`[DEBUG] ${msg}`, data);
    }
  },
};
