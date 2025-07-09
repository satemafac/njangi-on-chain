import { createLogger, format, transports, Logger } from 'winston';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';

// Audit log event types
export type AuditEventType = 
  | 'payout_triggered'
  | 'payout_failed' 
  | 'notification_sent'
  | 'notification_failed'
  | 'circle_discovered'
  | 'circle_status_changed'
  | 'health_check_passed'
  | 'health_check_failed'
  | 'emergency_stop'
  | 'system_started'
  | 'system_stopped'
  | 'retry_attempted'
  | 'admin_action'
  | 'blockchain_interaction'
  | 'performance_warning'
  | 'configuration_changed';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'critical';

// Interface for errors with code property
interface ErrorWithCode extends Error {
  code?: string;
}

// Alert types
interface Alert {
  type: 'error_rate' | 'performance' | 'system_health' | 'unusual_activity';
  severity: 'low' | 'medium' | 'high' | 'critical';
  message: string;
  details: Record<string, unknown>;
  timestamp: Date;
}



// Structured audit log entry
export interface AuditLogEntry {
  id: string;
  timestamp: Date;
  eventType: AuditEventType;
  level: LogLevel;
  source: string; // Which service/component generated this
  circleId?: string;
  userId?: string;
  transactionHash?: string;
  action: string;
  details: Record<string, unknown>;
  performance?: {
    duration?: number; // milliseconds
    memoryUsage?: number;
    blockchainCalls?: number;
  };
  context?: {
    session?: string;
    correlation?: string;
    automation?: boolean;
  };
  outcome: 'success' | 'failure' | 'warning' | 'info';
  errorDetails?: {
    message: string;
    stack?: string;
    code?: string;
    retryAttempt?: number;
  };
}

// Aggregated metrics for reporting
export interface AuditMetrics {
  totalEvents: number;
  eventsByType: Record<AuditEventType, number>;
  eventsByLevel: Record<LogLevel, number>;
  eventsByOutcome: Record<string, number>;
  timeRange: {
    start: Date;
    end: Date;
  };
  performance: {
    averageDuration: number;
    maxDuration: number;
    minDuration: number;
    totalMemoryUsage: number;
    blockchainCallsTotal: number;
  };
  errorRate: number;
  successRate: number;
}

/**
 * 📊 Automation Audit Logger Service
 * 
 * Comprehensive logging system for automation activities featuring:
 * - Structured audit trails with detailed context
 * - Categorized logging by event type and severity
 * - Performance metrics tracking and analysis
 * - Historical data aggregation and reporting
 * - Integration with monitoring and alerting systems
 */
export class AutomationAuditLoggerService {
  private static instance: AutomationAuditLoggerService;
  
  private logger!: Logger;
  private auditLogs: AuditLogEntry[] = [];
  private logsDirectory: string;
  
  // Configuration
  private readonly MAX_IN_MEMORY_LOGS = 10000; // Keep last 10k logs in memory
  private readonly LOG_ROTATION_SIZE = 50 * 1024 * 1024; // 50MB per file
  private readonly LOG_RETENTION_DAYS = 30; // Keep logs for 30 days
  
  // Performance tracking
  private performanceMetrics: Map<string, number[]> = new Map();
  private currentSessions: Map<string, { start: Date; context: Record<string, unknown> }> = new Map();

  private constructor() {
    // Create logs directory
    this.logsDirectory = join(process.cwd(), '.taskmaster', 'logs', 'automation');
    this.ensureLogDirectory();
    
    // Initialize enhanced logger
    this.initializeLogger();
    
    // Start periodic cleanup
    this.startLogMaintenance();
    
    this.logEvent('system_started', 'info', 'automation-audit-logger', 'Audit logger service initialized', {
      logsDirectory: this.logsDirectory,
      maxInMemoryLogs: this.MAX_IN_MEMORY_LOGS,
      retentionDays: this.LOG_RETENTION_DAYS
    });
  }

  public static getInstance(): AutomationAuditLoggerService {
    if (!AutomationAuditLoggerService.instance) {
      AutomationAuditLoggerService.instance = new AutomationAuditLoggerService();
    }
    return AutomationAuditLoggerService.instance;
  }

  /**
   * 📝 LOG EVENT: Log a structured audit event
   */
  public logEvent(
    eventType: AuditEventType,
    level: LogLevel,
    source: string,
    action: string,
    details: Record<string, unknown> = {},
    options: {
      circleId?: string;
      userId?: string;
      transactionHash?: string;
      outcome?: 'success' | 'failure' | 'warning' | 'info';
      performance?: { duration?: number; memoryUsage?: number; blockchainCalls?: number };
      context?: { session?: string; correlation?: string; automation?: boolean };
      error?: Error;
    } = {}
  ): string {
    const logId = this.generateLogId();
    
    const auditEntry: AuditLogEntry = {
      id: logId,
      timestamp: new Date(),
      eventType,
      level,
      source,
      circleId: options.circleId,
      userId: options.userId,
      transactionHash: options.transactionHash,
      action,
      details,
      performance: options.performance,
      context: options.context,
      outcome: options.outcome || (level === 'error' ? 'failure' : 'success'),
      errorDetails: options.error ? {
        message: options.error.message,
        stack: options.error.stack,
        code: (options.error as ErrorWithCode).code,
      } : undefined
    };

    // Add to in-memory collection
    this.auditLogs.push(auditEntry);
    
    // Trim in-memory logs if needed
    if (this.auditLogs.length > this.MAX_IN_MEMORY_LOGS) {
      this.auditLogs = this.auditLogs.slice(-this.MAX_IN_MEMORY_LOGS);
    }
    
    // Log to Winston (map 'critical' to 'error' since Winston doesn't have critical level)
    const winstonLevel = level === 'critical' ? 'error' : level;
    this.logger[winstonLevel](this.formatLogMessage(auditEntry), auditEntry);
    
    // Track performance metrics
    if (options.performance?.duration) {
      this.trackPerformance(eventType, options.performance.duration);
    }
    
    return logId;
  }

  /**
   * ⏱️ START SESSION: Begin a tracked operation session
   */
  public startSession(sessionId: string, context: Record<string, unknown> = {}): void {
    this.currentSessions.set(sessionId, {
      start: new Date(),
      context
    });
  }

  /**
   * ⏹️ END SESSION: Complete a tracked operation session
   */
  public endSession(
    sessionId: string, 
    eventType: AuditEventType,
    action: string,
    outcome: 'success' | 'failure' | 'warning' = 'success',
    details: Record<string, unknown> = {}
  ): string | null {
    const session = this.currentSessions.get(sessionId);
    if (!session) {
      this.logEvent('performance_warning', 'warn', 'audit-logger', 
        'Attempted to end non-existent session', { sessionId });
      return null;
    }

    const duration = Date.now() - session.start.getTime();
    const memoryUsage = process.memoryUsage().heapUsed;

    this.currentSessions.delete(sessionId);

    return this.logEvent(eventType, outcome === 'success' ? 'info' : 'error', 'session-tracker', action, {
      ...details,
      sessionDuration: duration,
      sessionContext: session.context
    }, {
      outcome,
      performance: { duration, memoryUsage },
      context: { session: sessionId, automation: true }
    });
  }

  /**
   * 🔍 QUERY LOGS: Search and filter audit logs
   */
  public queryLogs(filters: {
    eventType?: AuditEventType;
    level?: LogLevel;
    source?: string;
    circleId?: string;
    outcome?: string;
    timeRange?: { start: Date; end: Date };
    limit?: number;
  } = {}): AuditLogEntry[] {
    let filteredLogs = [...this.auditLogs];

    // Apply filters
    if (filters.eventType) {
      filteredLogs = filteredLogs.filter(log => log.eventType === filters.eventType);
    }
    
    if (filters.level) {
      filteredLogs = filteredLogs.filter(log => log.level === filters.level);
    }
    
    if (filters.source) {
      filteredLogs = filteredLogs.filter(log => log.source === filters.source);
    }
    
    if (filters.circleId) {
      filteredLogs = filteredLogs.filter(log => log.circleId === filters.circleId);
    }
    
    if (filters.outcome) {
      filteredLogs = filteredLogs.filter(log => log.outcome === filters.outcome);
    }
    
    if (filters.timeRange) {
      filteredLogs = filteredLogs.filter(log => 
        log.timestamp >= filters.timeRange!.start && 
        log.timestamp <= filters.timeRange!.end
      );
    }

    // Sort by timestamp (newest first)
    filteredLogs.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

    // Apply limit
    if (filters.limit) {
      filteredLogs = filteredLogs.slice(0, filters.limit);
    }

    return filteredLogs;
  }

  /**
   * 📊 GET METRICS: Calculate aggregated metrics
   */
  public getMetrics(timeRange?: { start: Date; end: Date }): AuditMetrics {
    const logs = timeRange ? 
      this.queryLogs({ timeRange }) : 
      this.auditLogs;

    const eventsByType = {} as Record<AuditEventType, number>;
    const eventsByLevel = {} as Record<LogLevel, number>;
    const eventsByOutcome: Record<string, number> = {};
    
    const durations: number[] = [];
    let totalMemoryUsage = 0;
    let totalBlockchainCalls = 0;
    let errorCount = 0;

    logs.forEach(log => {
      // Count by type
      eventsByType[log.eventType] = (eventsByType[log.eventType] || 0) + 1;
      
      // Count by level
      eventsByLevel[log.level] = (eventsByLevel[log.level] || 0) + 1;
      
      // Count by outcome
      eventsByOutcome[log.outcome] = (eventsByOutcome[log.outcome] || 0) + 1;
      
      // Track performance
      if (log.performance?.duration) {
        durations.push(log.performance.duration);
      }
      
      if (log.performance?.memoryUsage) {
        totalMemoryUsage += log.performance.memoryUsage;
      }
      
      if (log.performance?.blockchainCalls) {
        totalBlockchainCalls += log.performance.blockchainCalls;
      }

      // Count errors
      if (log.outcome === 'failure' || log.level === 'error') {
        errorCount++;
      }
    });

    const successCount = (eventsByOutcome.success || 0);
    const totalEvents = logs.length;

    return {
      totalEvents,
      eventsByType,
      eventsByLevel,
      eventsByOutcome,
      timeRange: timeRange || {
        start: logs[logs.length - 1]?.timestamp || new Date(),
        end: logs[0]?.timestamp || new Date()
      },
      performance: {
        averageDuration: durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0,
        maxDuration: durations.length > 0 ? Math.max(...durations) : 0,
        minDuration: durations.length > 0 ? Math.min(...durations) : 0,
        totalMemoryUsage,
        blockchainCallsTotal: totalBlockchainCalls
      },
      errorRate: totalEvents > 0 ? (errorCount / totalEvents) * 100 : 0,
      successRate: totalEvents > 0 ? (successCount / totalEvents) * 100 : 0
    };
  }

  /**
   * 🚨 GET ALERTS: Identify potential issues requiring attention
   */
  public getAlerts(): Alert[] {
    const alerts: Alert[] = [];
    const recentMetrics = this.getMetrics({
      start: new Date(Date.now() - 60 * 60 * 1000), // Last hour
      end: new Date()
    });

    // High error rate alert
    if (recentMetrics.errorRate > 20) {
      alerts.push({
        type: 'error_rate',
        severity: recentMetrics.errorRate > 50 ? 'critical' : 'high',
        message: `High error rate detected: ${recentMetrics.errorRate.toFixed(1)}%`,
        details: {
          errorRate: recentMetrics.errorRate,
          totalEvents: recentMetrics.totalEvents,
          timeRange: recentMetrics.timeRange
        },
        timestamp: new Date()
      });
    }

    // Performance degradation alert
    if (recentMetrics.performance.averageDuration > 30000) { // 30 seconds
      alerts.push({
        type: 'performance',
        severity: recentMetrics.performance.averageDuration > 60000 ? 'high' : 'medium',
        message: `Performance degradation detected: ${(recentMetrics.performance.averageDuration / 1000).toFixed(1)}s average`,
        details: {
          averageDuration: recentMetrics.performance.averageDuration,
          maxDuration: recentMetrics.performance.maxDuration,
          timeRange: recentMetrics.timeRange
        },
        timestamp: new Date()
      });
    }

    // No recent activity alert
    if (recentMetrics.totalEvents === 0) {
      alerts.push({
        type: 'system_health',
        severity: 'medium',
        message: 'No automation activity detected in the last hour',
        details: {
          timeRange: recentMetrics.timeRange,
          suggestion: 'Check if automation service is running properly'
        },
        timestamp: new Date()
      });
    }

    // Unusual pattern detection
    const payoutEvents = recentMetrics.eventsByType.payout_failed || 0;
    
    if (payoutEvents > 5) {
      alerts.push({
        type: 'unusual_activity',
        severity: 'high',
        message: `Unusual number of payout failures: ${payoutEvents}`,
        details: {
          payoutFailures: payoutEvents,
          timeRange: recentMetrics.timeRange
        },
        timestamp: new Date()
      });
    }

    return alerts;
  }

  /**
   * 💾 EXPORT LOGS: Export logs for external analysis
   */
  public exportLogs(
    format: 'json' | 'csv' = 'json',
    filters: Parameters<typeof this.queryLogs>[0] = {}
  ): string {
    const logs = this.queryLogs(filters);
    
    if (format === 'json') {
      return JSON.stringify(logs, null, 2);
    } else {
      // CSV format
      const headers = [
        'id', 'timestamp', 'eventType', 'level', 'source', 'action', 
        'outcome', 'circleId', 'duration', 'errorMessage'
      ];
      
      const rows = logs.map(log => [
        log.id,
        log.timestamp.toISOString(),
        log.eventType,
        log.level,
        log.source,
        log.action,
        log.outcome,
        log.circleId || '',
        log.performance?.duration || '',
        log.errorDetails?.message || ''
      ]);
      
      return [headers, ...rows].map(row => row.join(',')).join('\n');
    }
  }

  // ===========================================
  // PRIVATE HELPER METHODS
  // ===========================================

  private ensureLogDirectory(): void {
    if (!existsSync(this.logsDirectory)) {
      mkdirSync(this.logsDirectory, { recursive: true });
    }
  }

  private initializeLogger(): void {
    this.logger = createLogger({
      level: 'debug',
      format: format.combine(
        format.timestamp(),
        format.errors({ stack: true }),
        format.json()
      ),
      transports: [
        // Console transport for development
        new transports.Console({
          level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
          format: format.combine(
            format.colorize(),
            format.printf(info => `${info.timestamp} [${info.level}] ${info.message}`)
          )
        }),
        
        // File transport for audit logs
        new transports.File({
          filename: join(this.logsDirectory, 'audit.log'),
          maxsize: this.LOG_ROTATION_SIZE,
          maxFiles: 10,
          tailable: true
        }),
        
        // Error-specific log file
        new transports.File({
          filename: join(this.logsDirectory, 'errors.log'),
          level: 'error',
          maxsize: this.LOG_ROTATION_SIZE,
          maxFiles: 5,
          tailable: true
        }),
        
        // Performance log file
        new transports.File({
          filename: join(this.logsDirectory, 'performance.log'),
          level: 'info',
          maxsize: this.LOG_ROTATION_SIZE,
          maxFiles: 5,
          tailable: true,
          format: format.combine(
            format.timestamp(),
            format.printf(info => {
              const infoObj = info as Record<string, unknown>;
              if (info.performance && typeof info.performance === 'object' && 'duration' in info.performance) {
                const performance = info.performance as { duration: number };
                const eventType = infoObj.eventType || 'UNKNOWN';
                const action = infoObj.action || 'UNKNOWN';
                return `${info.timestamp} PERF [${eventType}] ${action} - Duration: ${performance.duration}ms`;
              }
              return '';
            })
          )
        })
      ]
    });
  }

  private formatLogMessage(entry: AuditLogEntry): string {
    const parts = [
      `[${entry.eventType.toUpperCase()}]`,
      `${entry.source}:`,
      entry.action
    ];
    
    if (entry.circleId) {
      parts.push(`(Circle: ${entry.circleId})`);
    }
    
    if (entry.performance?.duration) {
      parts.push(`[${entry.performance.duration}ms]`);
    }
    
    if (entry.outcome !== 'success') {
      parts.push(`- ${entry.outcome.toUpperCase()}`);
    }
    
    return parts.join(' ');
  }

  private generateLogId(): string {
    return `audit_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private trackPerformance(eventType: AuditEventType, duration: number): void {
    if (!this.performanceMetrics.has(eventType)) {
      this.performanceMetrics.set(eventType, []);
    }
    
    const metrics = this.performanceMetrics.get(eventType)!;
    metrics.push(duration);
    
    // Keep only last 100 measurements per event type
    if (metrics.length > 100) {
      metrics.shift();
    }
  }

  private startLogMaintenance(): void {
    // Run cleanup every 6 hours
    setInterval(() => {
      this.performLogCleanup();
    }, 6 * 60 * 60 * 1000);
  }

  private performLogCleanup(): void {
    // This would implement log file rotation and cleanup
    // For now, just clean up old performance metrics
    this.performanceMetrics.clear();
    
    this.logEvent('system_started', 'info', 'audit-logger', 'Log maintenance completed', {
      inMemoryLogs: this.auditLogs.length,
      performanceMetricsCleared: true
    });
  }

  /**
   * 📊 GET STATISTICS: Get service statistics
   */
  public getStatistics(): {
    inMemoryLogs: number;
    activeSessions: number;
    performanceMetrics: Record<string, { count: number; average: number }>;
    uptime: number;
  } {
    const perfStats: Record<string, { count: number; average: number }> = {};
    
    for (const [eventType, durations] of this.performanceMetrics.entries()) {
      if (durations.length > 0) {
        perfStats[eventType] = {
          count: durations.length,
          average: durations.reduce((a, b) => a + b, 0) / durations.length
        };
      }
    }

    return {
      inMemoryLogs: this.auditLogs.length,
      activeSessions: this.currentSessions.size,
      performanceMetrics: perfStats,
      uptime: process.uptime()
    };
  }
}

// Export singleton instance
export const automationAuditLogger = AutomationAuditLoggerService.getInstance(); 