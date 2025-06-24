import { createLogger, format, transports, Logger } from 'winston';
import { promises as fs } from 'fs';
import path from 'path';

// Audit event types
export type AuditEventType = 
  | 'authentication'
  | 'message_received' 
  | 'message_sent'
  | 'command_executed'
  | 'circle_created'
  | 'circle_joined'
  | 'contribution_made'
  | 'transaction_completed'
  | 'rate_limit_hit'
  | 'security_violation'
  | 'system_error'
  | 'admin_action'
  | 'user_blocked'
  | 'service_startup'
  | 'service_shutdown';

// Audit severity levels
export type AuditSeverity = 'info' | 'warn' | 'error' | 'critical';

// Audit event structure
export interface AuditEvent {
  id: string;
  timestamp: string;
  eventType: AuditEventType;
  severity: AuditSeverity;
  phoneNumber?: string;
  suiAddress?: string;
  circleId?: string;
  transactionHash?: string;
  command?: string;
  amount?: number;
  currency?: string;
  userAgent?: string;
  ipAddress?: string;
  sessionId?: string;
  message: string;
  details: Record<string, unknown>;
  metadata: {
    service: string;
    version: string;
    environment: string;
    requestId?: string;
  };
}

// Audit statistics
export interface AuditStats {
  totalEvents: number;
  eventsByType: Record<AuditEventType, number>;
  eventsBySeverity: Record<AuditSeverity, number>;
  lastHourEvents: number;
  last24HourEvents: number;
  criticalEvents: number;
  topUsers: Array<{ phoneNumber: string; eventCount: number }>;
  errorRate: number;
  successRate: number;
}

/**
 * 📋 WhatsApp Audit Service
 * 
 * Comprehensive audit logging system for WhatsApp operations with security focus.
 * Features:
 * - Structured JSON logging with Winston
 * - File-based storage with rotation
 * - Real-time statistics and monitoring
 * - Security event detection
 * - External service integration capabilities
 * - GDPR-compliant data handling
 */
export class WhatsAppAuditService {
  private static instance: WhatsAppAuditService;
  private logger!: Logger;
  private statsLogger!: Logger;
  
  // In-memory cache for statistics (last 24 hours)
  private recentEvents: Map<string, AuditEvent> = new Map();
  private eventCounts: Record<AuditEventType, number> = {} as Record<AuditEventType, number>;
  private severityCounts: Record<AuditSeverity, number> = {} as Record<AuditSeverity, number>;
  private userEventCounts: Map<string, number> = new Map();
  
  // Configuration
  private readonly LOG_DIR = '.taskmaster/logs/audit';
  private readonly STATS_CACHE_HOURS = 24;
  private readonly CLEANUP_INTERVAL = 60 * 60 * 1000; // 1 hour
  private readonly SERVICE_NAME = 'whatsapp-integration';
  private readonly SERVICE_VERSION = '1.0.0';
  private readonly ENVIRONMENT = process.env.NODE_ENV || 'development';

  private constructor() {
    this.initializeLoggers();
    this.initializeService();
  }

  public static getInstance(): WhatsAppAuditService {
    if (!WhatsAppAuditService.instance) {
      WhatsAppAuditService.instance = new WhatsAppAuditService();
    }
    return WhatsAppAuditService.instance;
  }

  private async initializeLoggers(): Promise<void> {
    // Ensure log directory exists
    await this.ensureLogDirectory();

    // Main audit logger
    this.logger = createLogger({
      level: 'info',
      format: format.combine(
        format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS Z' }),
        format.errors({ stack: true }),
        format.json()
      ),
      transports: [
        // Console transport for development
        new transports.Console({
          format: format.combine(
            format.colorize(),
            format.printf(({ timestamp, level, message, eventType, phoneNumber }) => {
              const phone = phoneNumber ? ` [${phoneNumber}]` : '';
              const type = eventType ? ` (${eventType})` : '';
              return `${timestamp} [${level.toUpperCase()}] WhatsApp Audit${phone}${type}: ${message}`;
            })
          )
        }),
        
        // File transport with rotation
        new transports.File({
          filename: path.join(this.LOG_DIR, 'audit.log'),
          maxsize: 10 * 1024 * 1024, // 10MB
          maxFiles: 30, // Keep 30 files (about 300MB total)
          tailable: true
        }),
        
        // Separate file for errors and critical events
        new transports.File({
          filename: path.join(this.LOG_DIR, 'audit-errors.log'),
          level: 'error',
          maxsize: 10 * 1024 * 1024,
          maxFiles: 10
        }),
        
        // Security events (separate file)
        new transports.File({
          filename: path.join(this.LOG_DIR, 'security.log'),
          format: format.combine(
            format.timestamp(),
            format.json(),
            format((info) => {
              // Only log security-related events
              const securityEvents = ['security_violation', 'rate_limit_hit', 'user_blocked', 'authentication'];
              return securityEvents.includes(String(info.eventType)) ? info : false;
            })()
          ),
          maxsize: 5 * 1024 * 1024,
          maxFiles: 20
        })
      ]
    });

    // Statistics logger (separate from main audit log)
    this.statsLogger = createLogger({
      level: 'info',
      format: format.combine(
        format.timestamp(),
        format.json()
      ),
      transports: [
        new transports.File({
          filename: path.join(this.LOG_DIR, 'statistics.log'),
          maxsize: 5 * 1024 * 1024,
          maxFiles: 5
        })
      ]
    });
  }

  private initializeService(): void {
    // Initialize event counters
    const eventTypes: AuditEventType[] = [
      'authentication', 'message_received', 'message_sent', 'command_executed',
      'circle_created', 'circle_joined', 'contribution_made', 'transaction_completed',
      'rate_limit_hit', 'security_violation', 'system_error', 'admin_action',
      'user_blocked', 'service_startup', 'service_shutdown'
    ];
    
    const severities: AuditSeverity[] = ['info', 'warn', 'error', 'critical'];
    
    eventTypes.forEach(type => this.eventCounts[type] = 0);
    severities.forEach(severity => this.severityCounts[severity] = 0);

    // Cleanup old events from memory cache
    setInterval(() => {
      this.cleanupOldEvents();
      this.logStatistics();
    }, this.CLEANUP_INTERVAL);

    // Log service startup
    this.logEvent({
      eventType: 'service_startup',
      severity: 'info',
      message: 'WhatsApp Audit Service started',
      details: {
        logDirectory: this.LOG_DIR,
        environment: this.ENVIRONMENT,
        version: this.SERVICE_VERSION
      }
    });

    this.logger.info('WhatsApp Audit Service initialized');
  }

  /**
   * 📝 LOG EVENT: Main audit logging method
   */
  public logEvent(event: Partial<AuditEvent>): string {
    const auditEvent: AuditEvent = {
      id: this.generateEventId(),
      timestamp: new Date().toISOString(),
      eventType: event.eventType || 'system_error',
      severity: event.severity || 'info',
      phoneNumber: event.phoneNumber,
      suiAddress: event.suiAddress,
      circleId: event.circleId,
      transactionHash: event.transactionHash,
      command: event.command,
      amount: event.amount,
      currency: event.currency,
      userAgent: event.userAgent,
      ipAddress: event.ipAddress,
      sessionId: event.sessionId,
      message: event.message || 'No message provided',
      details: event.details || {},
      metadata: {
        service: this.SERVICE_NAME,
        version: this.SERVICE_VERSION,
        environment: this.ENVIRONMENT,
        requestId: event.metadata?.requestId
      }
    };

    // Log to Winston
    this.logger.log(auditEvent.severity, auditEvent.message, auditEvent);

    // Update in-memory statistics
    this.updateStatistics(auditEvent);

    // Store in memory cache for recent events
    this.recentEvents.set(auditEvent.id, auditEvent);

    return auditEvent.id;
  }

  /**
   * 🔐 SECURITY: Log security-related events
   */
  public logSecurity(
    eventType: Extract<AuditEventType, 'security_violation' | 'rate_limit_hit' | 'user_blocked'>,
    phoneNumber: string,
    message: string,
    details: Record<string, unknown> = {}
  ): string {
    return this.logEvent({
      eventType,
      severity: 'warn',
      phoneNumber,
      message,
      details: {
        ...details,
        securityFlag: true,
        timestamp: Date.now()
      }
    });
  }

  /**
   * 💰 TRANSACTION: Log financial transaction events
   */
  public logTransaction(
    phoneNumber: string,
    suiAddress: string,
    circleId: string,
    transactionHash: string,
    amount: number,
    currency: string,
    type: 'contribution' | 'withdrawal' | 'deposit',
    details: Record<string, unknown> = {}
  ): string {
    return this.logEvent({
      eventType: type === 'contribution' ? 'contribution_made' : 'transaction_completed',
      severity: 'info',
      phoneNumber,
      suiAddress,
      circleId,
      transactionHash,
      amount,
      currency,
      message: `${type} of ${amount} ${currency} in circle ${circleId}`,
      details: {
        ...details,
        transactionType: type,
        financialEvent: true
      }
    });
  }

  /**
   * 📱 MESSAGE: Log WhatsApp message events
   */
  public logMessage(
    direction: 'received' | 'sent',
    phoneNumber: string,
    messageContent: string,
    messageType: 'text' | 'interactive' | 'template' = 'text',
    details: Record<string, unknown> = {}
  ): string {
    return this.logEvent({
      eventType: direction === 'received' ? 'message_received' : 'message_sent',
      severity: 'info',
      phoneNumber,
      message: `WhatsApp message ${direction}: ${messageType}`,
      details: {
        ...details,
        messageContent: this.sanitizeMessageContent(messageContent),
        messageType,
        direction,
        messageLength: messageContent.length
      }
    });
  }

  /**
   * ⚙️ COMMAND: Log command execution
   */
  public logCommand(
    phoneNumber: string,
    command: string,
    success: boolean,
    executionTimeMs?: number,
    details: Record<string, unknown> = {}
  ): string {
    return this.logEvent({
      eventType: 'command_executed',
      severity: success ? 'info' : 'warn',
      phoneNumber,
      command,
      message: `Command ${command} ${success ? 'executed successfully' : 'failed'}`,
      details: {
        ...details,
        success,
        executionTimeMs,
        commandLength: command.length
      }
    });
  }

  /**
   * 🏠 CIRCLE: Log circle-related events
   */
  public logCircleEvent(
    eventType: Extract<AuditEventType, 'circle_created' | 'circle_joined'>,
    phoneNumber: string,
    suiAddress: string,
    circleId: string,
    details: Record<string, unknown> = {}
  ): string {
    return this.logEvent({
      eventType,
      severity: 'info',
      phoneNumber,
      suiAddress,
      circleId,
      message: `Circle ${eventType.replace('circle_', '')} - ${circleId}`,
      details: {
        ...details,
        circleEvent: true
      }
    });
  }

  /**
   * ❌ ERROR: Log system errors
   */
  public logError(
    error: Error,
    context: string,
    phoneNumber?: string,
    details: Record<string, unknown> = {}
  ): string {
    return this.logEvent({
      eventType: 'system_error',
      severity: 'error',
      phoneNumber,
      message: `Error in ${context}: ${error.message}`,
      details: {
        ...details,
        errorName: error.name,
        errorStack: error.stack,
        context,
        timestamp: Date.now()
      }
    });
  }

  /**
   * 👮 ADMIN: Log administrative actions
   */
  public logAdminAction(
    adminIdentifier: string,
    action: string,
    targetPhoneNumber?: string,
    details: Record<string, unknown> = {}
  ): string {
    return this.logEvent({
      eventType: 'admin_action',
      severity: 'info',
      phoneNumber: targetPhoneNumber,
      message: `Admin action by ${adminIdentifier}: ${action}`,
      details: {
        ...details,
        adminIdentifier,
        action,
        adminEvent: true
      }
    });
  }

  /**
   * 📊 STATISTICS: Get audit statistics
   */
  public getStatistics(): AuditStats {
    const now = Date.now();
    const oneHour = 60 * 60 * 1000;
    const twentyFourHours = 24 * 60 * 60 * 1000;

    let lastHourEvents = 0;
    let last24HourEvents = 0;
    let criticalEvents = 0;
    let totalSuccessful = 0;
    let totalErrors = 0;

    // Count recent events
    for (const event of this.recentEvents.values()) {
      const eventTime = new Date(event.timestamp).getTime();
      
      if (now - eventTime <= oneHour) {
        lastHourEvents++;
      }
      if (now - eventTime <= twentyFourHours) {
        last24HourEvents++;
      }
      if (event.severity === 'critical') {
        criticalEvents++;
      }
      if (event.severity === 'error') {
        totalErrors++;
      } else {
        totalSuccessful++;
      }
    }

    // Get top users
    const topUsers = Array.from(this.userEventCounts.entries())
      .sort(([,a], [,b]) => b - a)
      .slice(0, 10)
      .map(([phoneNumber, eventCount]) => ({ phoneNumber, eventCount }));

    const totalEvents = totalSuccessful + totalErrors;
    
    return {
      totalEvents: this.recentEvents.size,
      eventsByType: { ...this.eventCounts },
      eventsBySeverity: { ...this.severityCounts },
      lastHourEvents,
      last24HourEvents,
      criticalEvents,
      topUsers,
      errorRate: totalEvents > 0 ? (totalErrors / totalEvents) * 100 : 0,
      successRate: totalEvents > 0 ? (totalSuccessful / totalEvents) * 100 : 0
    };
  }

  /**
   * 🔍 SEARCH: Search audit events
   */
  public searchEvents(
    filters: {
      phoneNumber?: string;
      eventType?: AuditEventType;
      severity?: AuditSeverity;
      fromDate?: Date;
      toDate?: Date;
      limit?: number;
    } = {}
  ): AuditEvent[] {
    const results: AuditEvent[] = [];
    const limit = filters.limit || 100;

    for (const event of this.recentEvents.values()) {
      // Apply filters
      if (filters.phoneNumber && event.phoneNumber !== filters.phoneNumber) continue;
      if (filters.eventType && event.eventType !== filters.eventType) continue;
      if (filters.severity && event.severity !== filters.severity) continue;
      
      const eventDate = new Date(event.timestamp);
      if (filters.fromDate && eventDate < filters.fromDate) continue;
      if (filters.toDate && eventDate > filters.toDate) continue;

      results.push(event);
      
      if (results.length >= limit) break;
    }

    // Sort by timestamp (newest first)
    return results.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  }

  /**
   * 📤 EXPORT: Export audit logs for compliance
   */
  public async exportLogs(
    fromDate: Date,
    toDate: Date,
    format: 'json' | 'csv' = 'json'
  ): Promise<string> {
    const events = this.searchEvents({
      fromDate,
      toDate,
      limit: 10000
    });

    if (format === 'json') {
      return JSON.stringify(events, null, 2);
    } else {
      // CSV format
      const headers = 'timestamp,eventType,severity,phoneNumber,message,details\n';
      const rows = events.map(event => 
        `"${event.timestamp}","${event.eventType}","${event.severity}","${event.phoneNumber || ''}","${event.message}","${JSON.stringify(event.details).replace(/"/g, '""')}"`
      ).join('\n');
      return headers + rows;
    }
  }

  // ===========================================
  // PRIVATE METHODS
  // ===========================================

  private async ensureLogDirectory(): Promise<void> {
    try {
      await fs.mkdir(this.LOG_DIR, { recursive: true });
    } catch (error) {
      console.error('Failed to create log directory:', error);
    }
  }

  private updateStatistics(event: AuditEvent): void {
    // Update event type counts
    this.eventCounts[event.eventType]++;
    
    // Update severity counts
    this.severityCounts[event.severity]++;
    
    // Update user event counts
    if (event.phoneNumber) {
      const currentCount = this.userEventCounts.get(event.phoneNumber) || 0;
      this.userEventCounts.set(event.phoneNumber, currentCount + 1);
    }
  }

  private cleanupOldEvents(): void {
    const cutoffTime = Date.now() - (this.STATS_CACHE_HOURS * 60 * 60 * 1000);
    let cleanedCount = 0;

    for (const [id, event] of this.recentEvents.entries()) {
      const eventTime = new Date(event.timestamp).getTime();
      if (eventTime < cutoffTime) {
        this.recentEvents.delete(id);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      this.logger.debug(`Cleaned up ${cleanedCount} old audit events from memory cache`);
    }
  }

  private logStatistics(): void {
    const stats = this.getStatistics();
    this.statsLogger.info('Hourly statistics', {
      timestamp: new Date().toISOString(),
      statistics: stats
    });
  }

  private sanitizeMessageContent(content: string): string {
    // Remove potential sensitive data (phone numbers, addresses, etc.)
    return content
      .replace(/\+\d{10,15}/g, '[PHONE]') // Phone numbers
      .replace(/0x[a-fA-F0-9]{40,}/g, '[ADDRESS]') // Blockchain addresses
      .replace(/[A-Za-z0-9]{40,}/g, '[HASH]') // Transaction hashes
      .substring(0, 500); // Limit length
  }

  private generateEventId(): string {
    return `audit_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Shutdown cleanup
   */
  public async shutdown(): Promise<void> {
    // Log service shutdown
    this.logEvent({
      eventType: 'service_shutdown',
      severity: 'info',
      message: 'WhatsApp Audit Service shutting down',
      details: {
        totalEventsLogged: this.recentEvents.size,
        uptime: process.uptime()
      }
    });

    // Wait for logs to flush
    await new Promise(resolve => {
      this.logger.end();
      this.statsLogger.end();
      setTimeout(resolve, 1000);
    });

    this.recentEvents.clear();
    this.userEventCounts.clear();
  }
}

// Export singleton instance
export const whatsappAudit = WhatsAppAuditService.getInstance(); 