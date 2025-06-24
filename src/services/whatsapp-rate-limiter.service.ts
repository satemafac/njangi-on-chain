import { createLogger, format, transports } from 'winston';

// Create logger instance
const logger = createLogger({
  level: 'info',
  format: format.combine(
    format.timestamp(),
    format.errors({ stack: true }),
    format.printf(({ timestamp, level, message, stack }) => {
      return `${timestamp} [${level.toUpperCase()}] WhatsApp Rate Limiter: ${message}${stack ? `\n${stack}` : ''}`;
    })
  ),
  transports: [
    new transports.Console(),
    new transports.File({ filename: '.taskmaster/logs/whatsapp-rate-limiter.log' })
  ]
});

// Rate limit configuration
export interface RateLimitConfig {
  windowMs: number; // Time window in milliseconds
  maxRequests: number; // Maximum requests per window
  blockDurationMs: number; // How long to block after limit exceeded
  skipSuccessfulRequests?: boolean; // Don't count successful requests
  skipFailedRequests?: boolean; // Don't count failed requests
}

// Rate limit entry
interface RateLimitEntry {
  count: number;
  firstRequest: number;
  blockedUntil?: number;
  lastRequest: number;
}

// Rate limit result
export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetTime: number;
  blockedUntil?: number;
  message?: string;
}

// Rate limit types for different operations
export type RateLimitType = 
  | 'message' 
  | 'auth' 
  | 'create_circle' 
  | 'join_circle' 
  | 'contribute' 
  | 'command' 
  | 'status_check'
  | 'bulk_operation';

/**
 * 🛡️ WhatsApp Rate Limiter Service
 * 
 * Provides comprehensive rate limiting for WhatsApp operations to prevent abuse and ensure fair usage.
 * Features:
 * - Per-phone number rate limiting
 * - Multiple rate limit types with different configurations
 * - In-memory storage with TTL
 * - Automatic cleanup of expired entries
 * - Configurable blocking and recovery
 * - Detailed statistics and monitoring
 */
export class WhatsAppRateLimiterService {
  private static instance: WhatsAppRateLimiterService;
  
  // In-memory storage: phone -> limitType -> entry
  private rateLimits: Map<string, Map<RateLimitType, RateLimitEntry>> = new Map();
  
  // Configuration for different types of operations
  private readonly limitConfigs: Record<RateLimitType, RateLimitConfig> = {
    // General message rate limiting
    message: {
      windowMs: 60 * 1000, // 1 minute
      maxRequests: 20, // 20 messages per minute
      blockDurationMs: 5 * 60 * 1000 // 5 minute block
    },
    
    // Authentication attempts
    auth: {
      windowMs: 15 * 60 * 1000, // 15 minutes
      maxRequests: 5, // 5 auth attempts per 15 minutes
      blockDurationMs: 30 * 60 * 1000 // 30 minute block
    },
    
    // Circle creation (expensive operation)
    create_circle: {
      windowMs: 60 * 60 * 1000, // 1 hour
      maxRequests: 3, // 3 circles per hour
      blockDurationMs: 2 * 60 * 60 * 1000 // 2 hour block
    },
    
    // Circle joining
    join_circle: {
      windowMs: 10 * 60 * 1000, // 10 minutes
      maxRequests: 5, // 5 join attempts per 10 minutes
      blockDurationMs: 30 * 60 * 1000 // 30 minute block
    },
    
    // Contributions (financial operations)
    contribute: {
      windowMs: 5 * 60 * 1000, // 5 minutes
      maxRequests: 10, // 10 contributions per 5 minutes
      blockDurationMs: 15 * 60 * 1000 // 15 minute block
    },
    
    // General commands
    command: {
      windowMs: 60 * 1000, // 1 minute
      maxRequests: 30, // 30 commands per minute
      blockDurationMs: 2 * 60 * 1000 // 2 minute block
    },
    
    // Status checks (lightweight)
    status_check: {
      windowMs: 60 * 1000, // 1 minute
      maxRequests: 60, // 60 status checks per minute
      blockDurationMs: 60 * 1000 // 1 minute block
    },
    
    // Bulk operations (admin features)
    bulk_operation: {
      windowMs: 60 * 60 * 1000, // 1 hour
      maxRequests: 1, // 1 bulk operation per hour
      blockDurationMs: 4 * 60 * 60 * 1000 // 4 hour block
    }
  };

  // Configuration
  private readonly CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes

  private constructor() {
    this.initializeService();
  }

  public static getInstance(): WhatsAppRateLimiterService {
    if (!WhatsAppRateLimiterService.instance) {
      WhatsAppRateLimiterService.instance = new WhatsAppRateLimiterService();
    }
    return WhatsAppRateLimiterService.instance;
  }

  private initializeService(): void {
    // Cleanup expired entries periodically
    setInterval(() => {
      this.cleanupExpiredEntries();
    }, this.CLEANUP_INTERVAL);

    logger.info('WhatsApp Rate Limiter Service initialized');
  }

  /**
   * 🔍 CHECK: Check if request is allowed
   */
  public checkRateLimit(phoneNumber: string, limitType: RateLimitType): RateLimitResult {
    const config = this.limitConfigs[limitType];
    const now = Date.now();
    
    // Get or create phone number entry
    if (!this.rateLimits.has(phoneNumber)) {
      this.rateLimits.set(phoneNumber, new Map());
    }
    
    const phoneEntry = this.rateLimits.get(phoneNumber)!;
    let limitEntry = phoneEntry.get(limitType);
    
    // Check if currently blocked
    if (limitEntry?.blockedUntil && limitEntry.blockedUntil > now) {
      return {
        allowed: false,
        remaining: 0,
        resetTime: limitEntry.blockedUntil,
        blockedUntil: limitEntry.blockedUntil,
        message: `Blocked due to rate limit. Try again in ${Math.ceil((limitEntry.blockedUntil - now) / 1000)} seconds.`
      };
    }

    // Initialize or reset if window expired
    if (!limitEntry || (now - limitEntry.firstRequest) > config.windowMs) {
      limitEntry = {
        count: 0,
        firstRequest: now,
        lastRequest: now
      };
      phoneEntry.set(limitType, limitEntry);
    }

    // Check if limit exceeded
    if (limitEntry.count >= config.maxRequests) {
      // Block the user
      limitEntry.blockedUntil = now + config.blockDurationMs;
      
      logger.warn(`Rate limit exceeded: ${phoneNumber} for ${limitType}. Blocked until ${new Date(limitEntry.blockedUntil).toISOString()}`);
      
      return {
        allowed: false,
        remaining: 0,
        resetTime: limitEntry.blockedUntil,
        blockedUntil: limitEntry.blockedUntil,
        message: `Rate limit exceeded. Blocked for ${config.blockDurationMs / 1000 / 60} minutes.`
      };
    }

    // Allow request
    const remaining = config.maxRequests - limitEntry.count - 1;
    const resetTime = limitEntry.firstRequest + config.windowMs;
    
    return {
      allowed: true,
      remaining,
      resetTime,
      message: `Request allowed. ${remaining} remaining.`
    };
  }

  /**
   * 📊 RECORD: Record a request (call after successful operation)
   */
  public recordRequest(
    phoneNumber: string, 
    limitType: RateLimitType,
    success: boolean = true
  ): void {
    const config = this.limitConfigs[limitType];
    
    // Skip recording based on configuration
    if ((success && config.skipSuccessfulRequests) || 
        (!success && config.skipFailedRequests)) {
      return;
    }

    const phoneEntry = this.rateLimits.get(phoneNumber);
    if (!phoneEntry) return;
    
    const limitEntry = phoneEntry.get(limitType);
    if (!limitEntry) return;

    limitEntry.count++;
    limitEntry.lastRequest = Date.now();
    
    logger.debug(`Recorded ${limitType} request for ${phoneNumber}: ${limitEntry.count}/${config.maxRequests}`);
  }

  /**
   * ⚡ EXECUTE: Check rate limit and execute operation if allowed
   */
  public async executeWithRateLimit<T>(
    phoneNumber: string,
    limitType: RateLimitType,
    operation: () => Promise<T>
  ): Promise<{ success: boolean; result?: T; rateLimitResult: RateLimitResult }> {
    const rateLimitResult = this.checkRateLimit(phoneNumber, limitType);
    
    if (!rateLimitResult.allowed) {
      return {
        success: false,
        rateLimitResult
      };
    }

    try {
      const result = await operation();
      this.recordRequest(phoneNumber, limitType, true);
      
      return {
        success: true,
        result,
        rateLimitResult
      };
    } catch (error) {
      this.recordRequest(phoneNumber, limitType, false);
      throw error;
    }
  }

  /**
   * 🔓 UNBLOCK: Manually unblock a user (admin function)
   */
  public unblockUser(phoneNumber: string, limitType?: RateLimitType): boolean {
    const phoneEntry = this.rateLimits.get(phoneNumber);
    if (!phoneEntry) {
      return false;
    }

    if (limitType) {
      // Unblock specific limit type
      const limitEntry = phoneEntry.get(limitType);
      if (limitEntry?.blockedUntil) {
        delete limitEntry.blockedUntil;
        logger.info(`Manually unblocked ${phoneNumber} for ${limitType}`);
        return true;
      }
    } else {
      // Unblock all limit types
      let unblocked = false;
      for (const [, entry] of phoneEntry.entries()) {
        if (entry.blockedUntil) {
          delete entry.blockedUntil;
          unblocked = true;
        }
      }
      if (unblocked) {
        logger.info(`Manually unblocked ${phoneNumber} for all operations`);
      }
      return unblocked;
    }

    return false;
  }

  /**
   * 🔄 RESET: Reset rate limits for a user
   */
  public resetUserLimits(phoneNumber: string, limitType?: RateLimitType): boolean {
    const phoneEntry = this.rateLimits.get(phoneNumber);
    if (!phoneEntry) {
      return false;
    }

    if (limitType) {
      // Reset specific limit type
      phoneEntry.delete(limitType);
      logger.info(`Reset rate limits for ${phoneNumber}: ${limitType}`);
    } else {
      // Reset all limits
      this.rateLimits.delete(phoneNumber);
      logger.info(`Reset all rate limits for ${phoneNumber}`);
    }

    return true;
  }

  /**
   * 📊 STATUS: Get rate limit status for a user
   */
  public getUserStatus(phoneNumber: string): Record<RateLimitType, {
    count: number;
    limit: number;
    remaining: number;
    resetTime: number;
    blocked: boolean;
    blockedUntil?: number;
  }> {
    const status: Record<RateLimitType, {
      count: number;
      limit: number;
      remaining: number;
      resetTime: number;
      blocked: boolean;
      blockedUntil?: number;
    }> = {} as Record<RateLimitType, {
      count: number;
      limit: number;
      remaining: number;
      resetTime: number;
      blocked: boolean;
      blockedUntil?: number;
    }>;
    const phoneEntry = this.rateLimits.get(phoneNumber);
    const now = Date.now();

    for (const [limitType, config] of Object.entries(this.limitConfigs)) {
      const limitEntry = phoneEntry?.get(limitType as RateLimitType);
      
      if (!limitEntry) {
        status[limitType as RateLimitType] = {
          count: 0,
          limit: config.maxRequests,
          remaining: config.maxRequests,
          resetTime: now + config.windowMs,
          blocked: false
        };
      } else {
        const windowExpired = (now - limitEntry.firstRequest) > config.windowMs;
        const blocked = limitEntry.blockedUntil ? limitEntry.blockedUntil > now : false;
        
        status[limitType as RateLimitType] = {
          count: windowExpired ? 0 : limitEntry.count,
          limit: config.maxRequests,
          remaining: windowExpired ? config.maxRequests : Math.max(0, config.maxRequests - limitEntry.count),
          resetTime: windowExpired ? now + config.windowMs : limitEntry.firstRequest + config.windowMs,
          blocked,
          blockedUntil: blocked ? limitEntry.blockedUntil : undefined
        };
      }
    }

    return status;
  }

  /**
   * 🏠 WHITELIST: Add phone number to whitelist (bypass rate limits)
   */
  private whitelistedNumbers: Set<string> = new Set();

  public addToWhitelist(phoneNumber: string): void {
    this.whitelistedNumbers.add(phoneNumber);
    logger.info(`Added ${phoneNumber} to whitelist`);
  }

  public removeFromWhitelist(phoneNumber: string): void {
    this.whitelistedNumbers.delete(phoneNumber);
    logger.info(`Removed ${phoneNumber} from whitelist`);
  }

  public isWhitelisted(phoneNumber: string): boolean {
    return this.whitelistedNumbers.has(phoneNumber);
  }

  /**
   * 🔍 CHECK WITH WHITELIST: Check rate limit with whitelist support
   */
  public checkRateLimitWithWhitelist(phoneNumber: string, limitType: RateLimitType): RateLimitResult {
    if (this.isWhitelisted(phoneNumber)) {
      return {
        allowed: true,
        remaining: 999,
        resetTime: Date.now() + 60000,
        message: 'Whitelisted user'
      };
    }

    return this.checkRateLimit(phoneNumber, limitType);
  }

  // ===========================================
  // PRIVATE METHODS
  // ===========================================

  /**
   * Cleanup expired entries
   */
  private cleanupExpiredEntries(): void {
    const now = Date.now();
    let cleanedPhones = 0;
    let cleanedEntries = 0;

    for (const [phoneNumber, phoneEntry] of this.rateLimits.entries()) {
      const expiredTypes: RateLimitType[] = [];

      for (const [limitType, entry] of phoneEntry.entries()) {
        const config = this.limitConfigs[limitType];
        
        // Check if entry is expired (window passed and not blocked)
        const windowExpired = (now - entry.firstRequest) > config.windowMs;
        const notBlocked = !entry.blockedUntil || entry.blockedUntil <= now;
        
        if (windowExpired && notBlocked) {
          expiredTypes.push(limitType);
        }
      }

      // Remove expired entries
      for (const type of expiredTypes) {
        phoneEntry.delete(type);
        cleanedEntries++;
      }

      // Remove phone entry if empty
      if (phoneEntry.size === 0) {
        this.rateLimits.delete(phoneNumber);
        cleanedPhones++;
      }
    }

    if (cleanedEntries > 0) {
      logger.debug(`Cleaned up ${cleanedEntries} expired rate limit entries and ${cleanedPhones} empty phone entries`);
    }
  }

  /**
   * Get service statistics
   */
  public getStats(): {
    totalTrackedPhones: number;
    totalActiveEntries: number;
    whitelistedNumbers: number;
    entriesByType: Record<string, number>;
    blockedUsers: number;
    topUsers: Array<{ phoneNumber: string; totalRequests: number }>;
  } {
    const entriesByType: Record<string, number> = {};
    const userRequestCounts: Record<string, number> = {};
    let blockedUsers = 0;
    const now = Date.now();

    for (const [phoneNumber, phoneEntry] of this.rateLimits.entries()) {
      let phoneTotal = 0;
      let phoneBlocked = false;

      for (const [limitType, entry] of phoneEntry.entries()) {
        entriesByType[limitType] = (entriesByType[limitType] || 0) + 1;
        phoneTotal += entry.count;
        
        if (entry.blockedUntil && entry.blockedUntil > now) {
          phoneBlocked = true;
        }
      }

      userRequestCounts[phoneNumber] = phoneTotal;
      if (phoneBlocked) {
        blockedUsers++;
      }
    }

    // Get top users by request count
    const topUsers = Object.entries(userRequestCounts)
      .sort(([,a], [,b]) => b - a)
      .slice(0, 10)
      .map(([phoneNumber, totalRequests]) => ({ phoneNumber, totalRequests }));

    return {
      totalTrackedPhones: this.rateLimits.size,
      totalActiveEntries: Object.values(entriesByType).reduce((sum, count) => sum + count, 0),
      whitelistedNumbers: this.whitelistedNumbers.size,
      entriesByType,
      blockedUsers,
      topUsers
    };
  }

  /**
   * Update configuration (for dynamic adjustments)
   */
  public updateConfig(limitType: RateLimitType, config: Partial<RateLimitConfig>): void {
    this.limitConfigs[limitType] = { ...this.limitConfigs[limitType], ...config };
    logger.info(`Updated rate limit config for ${limitType}:`, config);
  }

  /**
   * Cleanup on service shutdown
   */
  public shutdown(): void {
    this.rateLimits.clear();
    this.whitelistedNumbers.clear();
    logger.info('WhatsApp Rate Limiter Service shut down');
  }
}

// Export singleton instance
export const whatsappRateLimiter = WhatsAppRateLimiterService.getInstance(); 