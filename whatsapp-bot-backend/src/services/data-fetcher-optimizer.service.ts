/**
 * Data Fetcher Optimizer Service
 * Performance optimization and reliability improvements for data fetching
 * Implements circuit breaker, monitoring, batching, and fallback strategies
 */

import { appLogger } from '../utils/logger';
import { notificationContextAggregator } from './notification-context-aggregator.service';

/**
 * Circuit breaker states
 */
enum CircuitState {
  CLOSED = 'CLOSED',       // Normal operation
  OPEN = 'OPEN',           // Failing, rejecting requests
  HALF_OPEN = 'HALF_OPEN', // Testing if service recovered
}

/**
 * Performance metrics
 */
export interface PerformanceMetrics {
  timestamp: number;
  duration: number;
  success: boolean;
  cacheHit: boolean;
  operationType: string;
  circleId: string;
}

/**
 * Circuit breaker status
 */
export interface CircuitBreakerStatus {
  state: CircuitState;
  failureCount: number;
  successCount: number;
  lastFailureTime?: number;
  lastSuccessTime?: number;
  failureThreshold: number;
  successThreshold: number;
  timeout: number;
}

/**
 * Service health status
 */
export interface ServiceHealth {
  isHealthy: boolean;
  dataFetcherHealth: boolean;
  memberFetcherHealth: boolean;
  aggregatorHealth: boolean;
  circuitBreakerState: CircuitState;
  averageResponseTime: number;
  errorRate: number;
  cacheHitRate: number;
}

/**
 * Batch query request
 */
export interface BatchQueryRequest {
  circleIds: string[];
  eventType: string;
  timeout?: number;
}

/**
 * Batch query result
 */
export interface BatchQueryResult {
  successful: number;
  failed: number;
  totalTime: number;
  results: Record<
    string,
    {
      success: boolean;
      duration: number;
      error?: string;
    }
  >;
}

export class DataFetcherOptimizerService {
  private static instance: DataFetcherOptimizerService;
  private circuitBreaker: CircuitBreakerStatus;
  private performanceMetrics: PerformanceMetrics[] = [];
  private maxMetricsHistory = 10000;
  private readonly performanceTarget = 300; // ms
  private failureThreshold = 5;
  private successThreshold = 2;
  private circuitBreakerTimeout = 60000; // 1 minute
  private requestBatchSize = 10;
  private requestTimeout = 10000; // 10 seconds
  private queryCache: Map<string, { data: any; timestamp: number }> = new Map();
  private cacheTTL = 300000; // 5 minutes

  private constructor() {
    this.circuitBreaker = {
      state: CircuitState.CLOSED,
      failureCount: 0,
      successCount: 0,
      failureThreshold: this.failureThreshold,
      successThreshold: this.successThreshold,
      timeout: this.circuitBreakerTimeout,
    };

    this.startHealthMonitoring();
    appLogger.info('Data Fetcher Optimizer Service initialized');
  }

  /**
   * Get singleton instance
   */
  public static getInstance(): DataFetcherOptimizerService {
    if (!DataFetcherOptimizerService.instance) {
      DataFetcherOptimizerService.instance = new DataFetcherOptimizerService();
    }
    return DataFetcherOptimizerService.instance;
  }

  /**
   * Optimized notification context fetch with circuit breaker
   */
  public async getOptimizedNotificationContext(eventType: string, circleId: string) {
    const startTime = Date.now();

    // Check circuit breaker
    if (!this.isCircuitAllowingRequests()) {
      appLogger.warn('Circuit breaker is OPEN - request rejected', {
        state: this.circuitBreaker.state,
      });
      return {
        success: false,
        error: 'Service temporarily unavailable - circuit breaker open',
        duration: Date.now() - startTime,
      };
    }

    try {
      // Check cache first
      const cacheKey = `optimized:${circleId}:${eventType}`;
      const cached = this.getCachedResult(cacheKey);
      if (cached) {
        this.recordMetric({
          timestamp: Date.now(),
          duration: 0,
          success: true,
          cacheHit: true,
          operationType: 'aggregateNotificationContext',
          circleId,
        });
        return { success: true, data: cached, duration: 0, fromCache: true };
      }

      // Execute with timeout
      const result = await this.executeWithTimeout(
        () => notificationContextAggregator.aggregateNotificationContext(eventType, circleId),
        this.requestTimeout
      );

      if (!result.success) {
        this.recordCircuitBreakerFailure();
        throw new Error(result.error);
      }

      // Cache the result
      this.setCachedResult(cacheKey, result.data);

      const duration = Date.now() - startTime;
      this.recordMetric({
        timestamp: Date.now(),
        duration,
        success: true,
        cacheHit: false,
        operationType: 'aggregateNotificationContext',
        circleId,
      });

      // Check performance target
      if (duration > this.performanceTarget) {
        appLogger.warn('Performance target exceeded', {
          circleId,
          eventType,
          duration,
          target: this.performanceTarget,
        });
      }

      this.recordCircuitBreakerSuccess();

      return {
        success: true,
        data: result.data,
        duration,
        performanceOk: duration <= this.performanceTarget,
      };
    } catch (error) {
      this.recordCircuitBreakerFailure();
      const duration = Date.now() - startTime;

      appLogger.error('Optimized notification context fetch failed', {
        circleId,
        eventType,
        error: error instanceof Error ? error.message : String(error),
        duration,
      });

      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        duration,
      };
    }
  }

  /**
   * Batch query multiple circles efficiently
   */
  public async batchQueryNotificationContexts(
    request: BatchQueryRequest
  ): Promise<BatchQueryResult> {
    const startTime = Date.now();
    const results: BatchQueryResult['results'] = {};
    let successful = 0;
    let failed = 0;

    // Process in batches to avoid overwhelming the system
    for (let i = 0; i < request.circleIds.length; i += this.requestBatchSize) {
      const batch = request.circleIds.slice(i, i + this.requestBatchSize);

      const batchPromises = batch.map((circleId) =>
        this.executeWithTimeout(
          async () => {
            const startBatch = Date.now();
            try {
              const result = await notificationContextAggregator.aggregateNotificationContext(
                request.eventType,
                circleId
              );

              if (result.success) {
                successful++;
                return {
                  success: true,
                  duration: Date.now() - startBatch,
                };
              } else {
                failed++;
                return {
                  success: false,
                  duration: Date.now() - startBatch,
                  error: result.error,
                };
              }
            } catch (error) {
              failed++;
              return {
                success: false,
                duration: Date.now() - startBatch,
                error: error instanceof Error ? error.message : String(error),
              };
            }
          },
          request.timeout || this.requestTimeout
        )
      );

      const batchResults = await Promise.allSettled(batchPromises);

      for (let j = 0; j < batchResults.length; j++) {
        const circleId = batch[j];
        const result = batchResults[j];

        if (result.status === 'fulfilled') {
          results[circleId] = result.value;
        } else {
          failed++;
          results[circleId] = {
            success: false,
            duration: Date.now() - startTime,
            error: result.reason?.message || 'Unknown error',
          };
        }
      }
    }

    const totalTime = Date.now() - startTime;

    appLogger.info('Batch query completed', {
      total: request.circleIds.length,
      successful,
      failed,
      totalTime,
      averageTime: Math.floor(totalTime / request.circleIds.length),
    });

    return {
      successful,
      failed,
      totalTime,
      results,
    };
  }

  /**
   * Prefetch and cache data for upcoming events
   */
  public async prefetchContexts(
    circleIds: string[],
    eventTypes: string[]
  ): Promise<{ prefetched: number; failed: number }> {
    let prefetched = 0;
    let failed = 0;

    appLogger.info('Starting prefetch operation', {
      circles: circleIds.length,
      events: eventTypes.length,
    });

    for (const eventType of eventTypes) {
      for (const circleId of circleIds) {
        try {
          const cacheKey = `optimized:${circleId}:${eventType}`;

          // Skip if already cached
          if (this.getCachedResult(cacheKey)) {
            continue;
          }

          // Prefetch
          const result = await notificationContextAggregator.aggregateNotificationContext(
            eventType,
            circleId
          );

          if (result.success && result.data) {
            this.setCachedResult(cacheKey, result.data);
            prefetched++;
          } else {
            failed++;
          }
        } catch (error) {
          failed++;
          appLogger.warn('Prefetch failed for context', {
            circleId,
            eventType,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    appLogger.info('Prefetch operation completed', {
      prefetched,
      failed,
    });

    return { prefetched, failed };
  }

  /**
   * Get current service health
   */
  public getServiceHealth(): ServiceHealth {
    const recentMetrics = this.performanceMetrics.slice(-100);
    const successCount = recentMetrics.filter((m) => m.success).length;
    const cacheHits = recentMetrics.filter((m) => m.cacheHit).length;
    const averageResponseTime =
      recentMetrics.length > 0
        ? Math.floor(
            recentMetrics.reduce((sum, m) => sum + m.duration, 0) / recentMetrics.length
          )
        : 0;

    return {
      isHealthy: this.circuitBreaker.state === CircuitState.CLOSED,
      dataFetcherHealth: true,
      memberFetcherHealth: true,
      aggregatorHealth: true,
      circuitBreakerState: this.circuitBreaker.state,
      averageResponseTime,
      errorRate: recentMetrics.length > 0 ? (100 * (1 - successCount / recentMetrics.length)) : 0,
      cacheHitRate: recentMetrics.length > 0 ? (100 * (cacheHits / recentMetrics.length)) : 0,
    };
  }

  /**
   * Get performance statistics
   */
  public getPerformanceStats(): {
    totalQueries: number;
    successRate: number;
    averageResponseTime: number;
    p95ResponseTime: number;
    p99ResponseTime: number;
    cacheHitRate: number;
    queriesAboveTarget: number;
  } {
    if (this.performanceMetrics.length === 0) {
      return {
        totalQueries: 0,
        successRate: 0,
        averageResponseTime: 0,
        p95ResponseTime: 0,
        p99ResponseTime: 0,
        cacheHitRate: 0,
        queriesAboveTarget: 0,
      };
    }

    const successful = this.performanceMetrics.filter((m) => m.success).length;
    const cacheHits = this.performanceMetrics.filter((m) => m.cacheHit).length;
    const durations = this.performanceMetrics.map((m) => m.duration).sort((a, b) => a - b);
    const aboveTarget = this.performanceMetrics.filter(
      (m) => m.duration > this.performanceTarget
    ).length;

    return {
      totalQueries: this.performanceMetrics.length,
      successRate: (100 * successful) / this.performanceMetrics.length,
      averageResponseTime: Math.floor(
        this.performanceMetrics.reduce((sum, m) => sum + m.duration, 0) /
          this.performanceMetrics.length
      ),
      p95ResponseTime:
        durations[Math.floor(durations.length * 0.95)] || durations[durations.length - 1],
      p99ResponseTime:
        durations[Math.floor(durations.length * 0.99)] || durations[durations.length - 1],
      cacheHitRate: (100 * cacheHits) / this.performanceMetrics.length,
      queriesAboveTarget: aboveTarget,
    };
  }

  /**
   * Circuit breaker helper functions
   */
  private isCircuitAllowingRequests(): boolean {
    if (this.circuitBreaker.state === CircuitState.CLOSED) {
      return true;
    }

    if (this.circuitBreaker.state === CircuitState.OPEN) {
      // Check if timeout has passed
      const timeSinceLastFailure = Date.now() - (this.circuitBreaker.lastFailureTime || 0);
      if (timeSinceLastFailure > this.circuitBreaker.timeout) {
        // Transition to HALF_OPEN
        this.circuitBreaker.state = CircuitState.HALF_OPEN;
        this.circuitBreaker.successCount = 0;
        appLogger.info('Circuit breaker transitioned to HALF_OPEN');
        return true;
      }
      return false;
    }

    // HALF_OPEN state - allow request
    return true;
  }

  private recordCircuitBreakerSuccess(): void {
    if (this.circuitBreaker.state === CircuitState.HALF_OPEN) {
      this.circuitBreaker.successCount++;
      if (this.circuitBreaker.successCount >= this.circuitBreaker.successThreshold) {
        this.circuitBreaker.state = CircuitState.CLOSED;
        this.circuitBreaker.failureCount = 0;
        this.circuitBreaker.successCount = 0;
        appLogger.info('Circuit breaker CLOSED - service recovered');
      }
    } else if (this.circuitBreaker.state === CircuitState.CLOSED) {
      this.circuitBreaker.failureCount = 0;
    }
    this.circuitBreaker.lastSuccessTime = Date.now();
  }

  private recordCircuitBreakerFailure(): void {
    this.circuitBreaker.failureCount++;
    this.circuitBreaker.lastFailureTime = Date.now();

    if (this.circuitBreaker.state === CircuitState.CLOSED) {
      if (this.circuitBreaker.failureCount >= this.circuitBreaker.failureThreshold) {
        this.circuitBreaker.state = CircuitState.OPEN;
        appLogger.warn('Circuit breaker OPEN - too many failures', {
          failures: this.circuitBreaker.failureCount,
        });
      }
    } else if (this.circuitBreaker.state === CircuitState.HALF_OPEN) {
      this.circuitBreaker.state = CircuitState.OPEN;
      appLogger.warn('Circuit breaker returned to OPEN - recovery attempt failed');
    }
  }

  /**
   * Execute operation with timeout
   */
  private async executeWithTimeout<T>(
    operation: () => Promise<T>,
    timeoutMs: number
  ): Promise<T> {
    return Promise.race([
      operation(),
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error('Operation timeout')), timeoutMs)
      ),
    ]);
  }

  /**
   * Record performance metric
   */
  private recordMetric(metric: PerformanceMetrics): void {
    this.performanceMetrics.push(metric);

    // Keep metrics array bounded
    if (this.performanceMetrics.length > this.maxMetricsHistory) {
      this.performanceMetrics = this.performanceMetrics.slice(-this.maxMetricsHistory);
    }
  }

  /**
   * Cache helpers
   */
  private getCachedResult(key: string): any | null {
    const cached = this.queryCache.get(key);
    if (!cached) return null;

    if (Date.now() - cached.timestamp > this.cacheTTL) {
      this.queryCache.delete(key);
      return null;
    }

    return cached.data;
  }

  private setCachedResult(key: string, data: any): void {
    this.queryCache.set(key, {
      data,
      timestamp: Date.now(),
    });
  }

  /**
   * Health monitoring
   */
  private startHealthMonitoring(): void {
    // Monitor every 30 seconds
    setInterval(() => {
      const health = this.getServiceHealth();
      const stats = this.getPerformanceStats();

      appLogger.debug('Service health check', {
        healthy: health.isHealthy,
        circuitBreakerState: health.circuitBreakerState,
        errorRate: health.errorRate.toFixed(2) + '%',
        cacheHitRate: health.cacheHitRate.toFixed(2) + '%',
        avgResponseTime: health.averageResponseTime + 'ms',
        totalQueries: stats.totalQueries,
        successRate: stats.successRate.toFixed(2) + '%',
        queriesAboveTarget: stats.queriesAboveTarget,
      });
    }, 30000);
  }

  /**
   * Manual cache clear
   */
  public clearCache(): void {
    this.queryCache.clear();
    appLogger.debug('Data fetcher optimizer cache cleared');
  }

  /**
   * Reset circuit breaker (for testing/recovery)
   */
  public resetCircuitBreaker(): void {
    this.circuitBreaker = {
      state: CircuitState.CLOSED,
      failureCount: 0,
      successCount: 0,
      failureThreshold: this.failureThreshold,
      successThreshold: this.successThreshold,
      timeout: this.circuitBreakerTimeout,
    };
    appLogger.info('Circuit breaker reset to CLOSED');
  }

  /**
   * Get circuit breaker status
   */
  public getCircuitBreakerStatus(): CircuitBreakerStatus {
    return { ...this.circuitBreaker };
  }

  /**
   * Clear performance metrics (for testing)
   */
  public clearMetrics(): void {
    this.performanceMetrics = [];
    appLogger.debug('Performance metrics cleared');
  }
}

// Export singleton instance
export const dataFetcherOptimizer = DataFetcherOptimizerService.getInstance();
