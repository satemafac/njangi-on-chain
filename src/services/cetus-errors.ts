// cetus-errors.ts - Comprehensive error handling for Cetus DEX operations

export enum CetusErrorCode {
  // SDK and Network Errors
  SDK_INITIALIZATION_FAILED = 'SDK_INITIALIZATION_FAILED',
  NETWORK_ERROR = 'NETWORK_ERROR',
  RPC_ERROR = 'RPC_ERROR',
  TIMEOUT_ERROR = 'TIMEOUT_ERROR',
  
  // Pool Related Errors
  POOL_NOT_FOUND = 'POOL_NOT_FOUND',
  POOL_INACTIVE = 'POOL_INACTIVE',
  INSUFFICIENT_LIQUIDITY = 'INSUFFICIENT_LIQUIDITY',
  PRICE_IMPACT_TOO_HIGH = 'PRICE_IMPACT_TOO_HIGH',
  
  // Position Related Errors
  POSITION_NOT_FOUND = 'POSITION_NOT_FOUND',
  POSITION_OUT_OF_RANGE = 'POSITION_OUT_OF_RANGE',
  INSUFFICIENT_POSITION_BALANCE = 'INSUFFICIENT_POSITION_BALANCE',
  POSITION_ALREADY_CLOSED = 'POSITION_ALREADY_CLOSED',
  
  // Wallet and Balance Errors
  WALLET_NOT_CONNECTED = 'WALLET_NOT_CONNECTED',
  INSUFFICIENT_BALANCE = 'INSUFFICIENT_BALANCE',
  INVALID_WALLET_ADDRESS = 'INVALID_WALLET_ADDRESS',
  
  // Transaction Errors
  TRANSACTION_FAILED = 'TRANSACTION_FAILED',
  TRANSACTION_REJECTED = 'TRANSACTION_REJECTED',
  GAS_ESTIMATION_FAILED = 'GAS_ESTIMATION_FAILED',
  SLIPPAGE_EXCEEDED = 'SLIPPAGE_EXCEEDED',
  
  // Liquidity Provision Errors
  INVALID_AMOUNT = 'INVALID_AMOUNT',
  AMOUNT_TOO_SMALL = 'AMOUNT_TOO_SMALL',
  AMOUNT_TOO_LARGE = 'AMOUNT_TOO_LARGE',
  INVALID_TICK_RANGE = 'INVALID_TICK_RANGE',
  
  // Fee Collection Errors
  NO_FEES_TO_COLLECT = 'NO_FEES_TO_COLLECT',
  FEE_COLLECTION_FAILED = 'FEE_COLLECTION_FAILED',
  
  // General Errors
  UNKNOWN_ERROR = 'UNKNOWN_ERROR',
  INVALID_PARAMETERS = 'INVALID_PARAMETERS',
  RATE_LIMIT_EXCEEDED = 'RATE_LIMIT_EXCEEDED',
  SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE'
}

export interface CetusErrorDetails {
  code: CetusErrorCode;
  message: string;
  userMessage: string;
  suggestion?: string;
  recoverable: boolean;
  retryable: boolean;
  technicalDetails?: string;
  helpUrl?: string;
}

export class CetusError extends Error {
  public readonly code: CetusErrorCode;
  public readonly userMessage: string;
  public readonly suggestion?: string;
  public readonly recoverable: boolean;
  public readonly retryable: boolean;
  public readonly technicalDetails?: string;
  public readonly helpUrl?: string;
  public readonly timestamp: number;

  constructor(details: CetusErrorDetails, originalError?: Error) {
    super(details.message);
    this.name = 'CetusError';
    this.code = details.code;
    this.userMessage = details.userMessage;
    this.suggestion = details.suggestion;
    this.recoverable = details.recoverable;
    this.retryable = details.retryable;
    this.technicalDetails = details.technicalDetails || originalError?.message;
    this.helpUrl = details.helpUrl;
    this.timestamp = Date.now();

    // Maintain proper stack trace
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, CetusError);
    }
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      userMessage: this.userMessage,
      suggestion: this.suggestion,
      recoverable: this.recoverable,
      retryable: this.retryable,
      technicalDetails: this.technicalDetails,
      helpUrl: this.helpUrl,
      timestamp: this.timestamp,
      stack: this.stack
    };
  }
}

// Error definitions with user-friendly messages and recovery suggestions
export const CETUS_ERROR_DEFINITIONS: Record<CetusErrorCode, Omit<CetusErrorDetails, 'code'>> = {
  [CetusErrorCode.SDK_INITIALIZATION_FAILED]: {
    message: 'Failed to initialize Cetus SDK',
    userMessage: 'Unable to connect to Cetus DEX',
    suggestion: 'Please check your internet connection and try again. If the problem persists, contact support.',
    recoverable: true,
    retryable: true,
    helpUrl: 'https://docs.cetus.zone/troubleshooting'
  },

  [CetusErrorCode.NETWORK_ERROR]: {
    message: 'Network request failed',
    userMessage: 'Connection to Cetus DEX failed',
    suggestion: 'Please check your internet connection and try again.',
    recoverable: true,
    retryable: true
  },

  [CetusErrorCode.RPC_ERROR]: {
    message: 'RPC call failed',
    userMessage: 'Blockchain network error',
    suggestion: 'The SUI network may be experiencing issues. Please try again in a few moments.',
    recoverable: true,
    retryable: true
  },

  [CetusErrorCode.TIMEOUT_ERROR]: {
    message: 'Request timed out',
    userMessage: 'Request took too long to complete',
    suggestion: 'The network is slow. Please try again.',
    recoverable: true,
    retryable: true
  },

  [CetusErrorCode.POOL_NOT_FOUND]: {
    message: 'Specified pool does not exist',
    userMessage: 'Trading pool not available',
    suggestion: 'The requested trading pool may not exist or may have been removed.',
    recoverable: false,
    retryable: false
  },

  [CetusErrorCode.POOL_INACTIVE]: {
    message: 'Pool is not active',
    userMessage: 'Trading pool is currently inactive',
    suggestion: 'This trading pool is temporarily unavailable. Please try a different pool or check back later.',
    recoverable: false,
    retryable: true
  },

  [CetusErrorCode.INSUFFICIENT_LIQUIDITY]: {
    message: 'Insufficient liquidity in pool',
    userMessage: 'Not enough liquidity for this trade',
    suggestion: 'Try a smaller amount or check back when more liquidity is available.',
    recoverable: true,
    retryable: false
  },

  [CetusErrorCode.PRICE_IMPACT_TOO_HIGH]: {
    message: 'Price impact exceeds acceptable threshold',
    userMessage: 'This trade would significantly affect the price',
    suggestion: 'Try a smaller amount or adjust your slippage tolerance.',
    recoverable: true,
    retryable: false
  },

  [CetusErrorCode.POSITION_NOT_FOUND]: {
    message: 'Liquidity position not found',
    userMessage: 'Your liquidity position could not be found',
    suggestion: 'The position may have been closed or the ID is incorrect.',
    recoverable: false,
    retryable: false
  },

  [CetusErrorCode.POSITION_OUT_OF_RANGE]: {
    message: 'Position is out of active range',
    userMessage: 'Your liquidity position is out of the active price range',
    suggestion: 'Consider adjusting your position range or closing and reopening it.',
    recoverable: true,
    retryable: false
  },

  [CetusErrorCode.INSUFFICIENT_POSITION_BALANCE]: {
    message: 'Insufficient position balance',
    userMessage: 'Not enough liquidity in your position',
    suggestion: 'You cannot withdraw more than your current position balance.',
    recoverable: false,
    retryable: false
  },

  [CetusErrorCode.POSITION_ALREADY_CLOSED]: {
    message: 'Position has already been closed',
    userMessage: 'This liquidity position is already closed',
    suggestion: 'The position has been closed. You cannot perform operations on closed positions.',
    recoverable: false,
    retryable: false
  },

  [CetusErrorCode.WALLET_NOT_CONNECTED]: {
    message: 'Wallet not connected',
    userMessage: 'Please connect your wallet',
    suggestion: 'Connect your wallet to continue with Cetus operations.',
    recoverable: true,
    retryable: false
  },

  [CetusErrorCode.INSUFFICIENT_BALANCE]: {
    message: 'Insufficient wallet balance',
    userMessage: 'Not enough tokens in your wallet',
    suggestion: 'Add more tokens to your wallet or try a smaller amount.',
    recoverable: true,
    retryable: false
  },

  [CetusErrorCode.INVALID_WALLET_ADDRESS]: {
    message: 'Invalid wallet address format',
    userMessage: 'Wallet address is invalid',
    suggestion: 'Please check that the wallet address is correct.',
    recoverable: false,
    retryable: false
  },

  [CetusErrorCode.TRANSACTION_FAILED]: {
    message: 'Transaction execution failed',
    userMessage: 'Transaction failed to complete',
    suggestion: 'The transaction was rejected by the network. Please try again with sufficient gas.',
    recoverable: true,
    retryable: true
  },

  [CetusErrorCode.TRANSACTION_REJECTED]: {
    message: 'Transaction was rejected by user',
    userMessage: 'Transaction was cancelled',
    suggestion: 'You cancelled the transaction. You can try again when ready.',
    recoverable: true,
    retryable: true
  },

  [CetusErrorCode.GAS_ESTIMATION_FAILED]: {
    message: 'Failed to estimate gas costs',
    userMessage: 'Unable to calculate transaction costs',
    suggestion: 'There may be an issue with the transaction. Please try again.',
    recoverable: true,
    retryable: true
  },

  [CetusErrorCode.SLIPPAGE_EXCEEDED]: {
    message: 'Transaction slippage exceeded tolerance',
    userMessage: 'Price moved too much during transaction',
    suggestion: 'Increase your slippage tolerance or try again with current prices.',
    recoverable: true,
    retryable: true
  },

  [CetusErrorCode.INVALID_AMOUNT]: {
    message: 'Invalid amount specified',
    userMessage: 'Invalid amount entered',
    suggestion: 'Please enter a valid positive number.',
    recoverable: true,
    retryable: false
  },

  [CetusErrorCode.AMOUNT_TOO_SMALL]: {
    message: 'Amount is below minimum threshold',
    userMessage: 'Amount is too small',
    suggestion: 'Enter a larger amount to meet the minimum requirements.',
    recoverable: true,
    retryable: false
  },

  [CetusErrorCode.AMOUNT_TOO_LARGE]: {
    message: 'Amount exceeds maximum threshold',
    userMessage: 'Amount is too large',
    suggestion: 'Enter a smaller amount within the allowed limits.',
    recoverable: true,
    retryable: false
  },

  [CetusErrorCode.INVALID_TICK_RANGE]: {
    message: 'Invalid price range specified',
    userMessage: 'Invalid price range for liquidity position',
    suggestion: 'Please select a valid price range for your liquidity position.',
    recoverable: true,
    retryable: false
  },

  [CetusErrorCode.NO_FEES_TO_COLLECT]: {
    message: 'No fees available for collection',
    userMessage: 'No fees to collect',
    suggestion: 'Your position has not earned any fees yet. Check back later.',
    recoverable: false,
    retryable: false
  },

  [CetusErrorCode.FEE_COLLECTION_FAILED]: {
    message: 'Failed to collect fees',
    userMessage: 'Unable to collect fees',
    suggestion: 'Fee collection failed. Please try again.',
    recoverable: true,
    retryable: true
  },

  [CetusErrorCode.RATE_LIMIT_EXCEEDED]: {
    message: 'API rate limit exceeded',
    userMessage: 'Too many requests',
    suggestion: 'Please wait a moment before trying again.',
    recoverable: true,
    retryable: true
  },

  [CetusErrorCode.SERVICE_UNAVAILABLE]: {
    message: 'Cetus service is temporarily unavailable',
    userMessage: 'Service temporarily unavailable',
    suggestion: 'Cetus DEX is undergoing maintenance. Please try again later.',
    recoverable: true,
    retryable: true
  },

  [CetusErrorCode.INVALID_PARAMETERS]: {
    message: 'Invalid parameters provided',
    userMessage: 'Invalid input parameters',
    suggestion: 'Please check your input values and try again.',
    recoverable: true,
    retryable: false
  },

  [CetusErrorCode.UNKNOWN_ERROR]: {
    message: 'An unknown error occurred',
    userMessage: 'Something went wrong',
    suggestion: 'An unexpected error occurred. Please try again or contact support.',
    recoverable: true,
    retryable: true
  }
};

// Factory function to create CetusError instances
export function createCetusError(
  code: CetusErrorCode,
  technicalDetails?: string,
  originalError?: Error
): CetusError {
  const definition = CETUS_ERROR_DEFINITIONS[code];
  
  return new CetusError({
    code,
    ...definition,
    technicalDetails: technicalDetails || originalError?.message
  }, originalError);
}

// Error categorization helper
export function parseError(error: unknown): CetusError {
  if (error instanceof CetusError) {
    return error;
  }

  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    
    // Network and connectivity errors
    if (message.includes('network') || message.includes('fetch')) {
      return createCetusError(CetusErrorCode.NETWORK_ERROR, error.message, error);
    }
    
    if (message.includes('timeout')) {
      return createCetusError(CetusErrorCode.TIMEOUT_ERROR, error.message, error);
    }
    
    // Pool related errors
    if (message.includes('pool not found') || message.includes('pool does not exist')) {
      return createCetusError(CetusErrorCode.POOL_NOT_FOUND, error.message, error);
    }
    
    if (message.includes('insufficient liquidity')) {
      return createCetusError(CetusErrorCode.INSUFFICIENT_LIQUIDITY, error.message, error);
    }
    
    // Balance errors
    if (message.includes('insufficient balance') || message.includes('insufficient funds')) {
      return createCetusError(CetusErrorCode.INSUFFICIENT_BALANCE, error.message, error);
    }
    
    // Transaction errors
    if (message.includes('transaction failed') || message.includes('execution failed')) {
      return createCetusError(CetusErrorCode.TRANSACTION_FAILED, error.message, error);
    }
    
    if (message.includes('user rejected') || message.includes('user denied')) {
      return createCetusError(CetusErrorCode.TRANSACTION_REJECTED, error.message, error);
    }
    
    if (message.includes('slippage')) {
      return createCetusError(CetusErrorCode.SLIPPAGE_EXCEEDED, error.message, error);
    }
    
    // Position errors
    if (message.includes('position not found')) {
      return createCetusError(CetusErrorCode.POSITION_NOT_FOUND, error.message, error);
    }
  }

  // Default to unknown error
  return createCetusError(
    CetusErrorCode.UNKNOWN_ERROR, 
    typeof error === 'string' ? error : 'Unknown error occurred'
  );
}

// Error logging utility
export class CetusErrorLogger {
  private static logs: CetusError[] = [];
  private static maxLogs = 100;

  static log(error: CetusError): void {
    this.logs.unshift(error);
    
    // Keep only the most recent logs
    if (this.logs.length > this.maxLogs) {
      this.logs = this.logs.slice(0, this.maxLogs);
    }

    // Log to console in development
    if (process.env.NODE_ENV === 'development') {
      console.group(`🔴 CetusError [${error.code}]`);
      console.log('User Message:', error.userMessage);
      console.log('Technical Message:', error.message);
      if (error.suggestion) {
        console.log('Suggestion:', error.suggestion);
      }
      if (error.technicalDetails) {
        console.log('Technical Details:', error.technicalDetails);
      }
      console.log('Recoverable:', error.recoverable);
      console.log('Retryable:', error.retryable);
      console.log('Timestamp:', new Date(error.timestamp).toISOString());
      console.groupEnd();
    }
  }

  static getLogs(): CetusError[] {
    return [...this.logs];
  }

  static clearLogs(): void {
    this.logs = [];
  }

  static getErrorStats(): { code: CetusErrorCode; count: number }[] {
    const stats = new Map<CetusErrorCode, number>();
    
    this.logs.forEach(error => {
      stats.set(error.code, (stats.get(error.code) || 0) + 1);
    });
    
    return Array.from(stats.entries()).map(([code, count]) => ({ code, count }));
  }
}

// Recovery mechanism utilities
export class CetusRecoveryManager {
  private static retryDelays = [1000, 2000, 4000, 8000]; // Exponential backoff

  static async withRetry<T>(
    operation: () => Promise<T>,
    maxRetries: number = 3,
    shouldRetry?: (error: CetusError) => boolean
  ): Promise<T> {
    let lastError: CetusError;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = parseError(error);
        CetusErrorLogger.log(lastError);

        // Don't retry if this is the last attempt
        if (attempt === maxRetries) {
          break;
        }

        // Don't retry if error is not retryable
        if (!lastError.retryable) {
          break;
        }

        // Custom retry logic
        if (shouldRetry && !shouldRetry(lastError)) {
          break;
        }

        // Wait before retrying
        const delay = this.retryDelays[Math.min(attempt, this.retryDelays.length - 1)];
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    throw lastError!;
  }

  static async safeExecute<T>(
    operation: () => Promise<T>,
    fallback?: () => Promise<T> | T
  ): Promise<T | null> {
    try {
      return await operation();
    } catch (error) {
      const cetusError = parseError(error);
      CetusErrorLogger.log(cetusError);

      if (fallback && cetusError.recoverable) {
        try {
          return await fallback();
        } catch (fallbackError) {
          CetusErrorLogger.log(parseError(fallbackError));
          return null;
        }
      }

      return null;
    }
  }
} 