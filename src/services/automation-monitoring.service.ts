import { createLogger, format, transports } from 'winston';
import { automationAuditLogger, AuditEventType } from './automation-audit-logger.service';
// ⚠️ DEPRECATED: Removed import of deleted notification service
// import { whatsappNotificationService } from './whatsapp-notification.service';
// Use whatsapp-bot-backend for notifications instead
import { circleMemberManager } from './circle-member-manager.service';

// Create logger instance
const logger = createLogger({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  format: format.combine(
    format.timestamp(),
    format.errors({ stack: true }),
    format.printf((info) => {
      return `${info.timestamp} [${info.level.toUpperCase()}] AutomationMonitoring: ${info.message}${info.stack ? `\n${info.stack}` : ''}`;
    })
  ),
  transports: [
    new transports.Console(),
    new transports.File({ filename: '.taskmaster/logs/automation-monitoring.log' })
  ]
});

// System health status
export interface SystemHealthStatus {
  overall: 'healthy' | 'warning' | 'critical' | 'offline';
  timestamp: Date;
  components: {
    automationService: ComponentHealth;
    blockchain: ComponentHealth;
    notifications: ComponentHealth;
    database: ComponentHealth;
    performance: ComponentHealth;
  };
  uptime: number;
  version: string;
}

export interface ComponentHealth {
  status: 'healthy' | 'warning' | 'critical' | 'offline';
  lastCheck: Date;
  message?: string;
  metrics?: Record<string, number>;
  trend?: 'improving' | 'stable' | 'degrading';
}

// Real-time metrics for dashboard
export interface DashboardMetrics {
  automation: {
    isRunning: boolean;
    activeCircles: number;
    payoutsTriggered: number;
    notificationsSent: number;
    errors: number;
    successRate: number;
    averageResponseTime: number;
  };
  performance: {
    uptime: number;
    memoryUsage: number;
    cpuUsage: number;
    diskUsage: number;
    networkLatency: number;
  };
  blockchain: {
    latestBlock: number;
    transactionCount: number;
    gasUsed: number;
    networkStatus: 'connected' | 'degraded' | 'disconnected';
  };
  alerts: Array<{
    type: string;
    severity: 'low' | 'medium' | 'high' | 'critical';
    message: string;
    timestamp: Date;
  }>;
  timeRange: {
    start: Date;
    end: Date;
  };
}

// Alert configuration
export interface AlertConfiguration {
  errorRateThreshold: number;
  performanceThreshold: number;
  memoryThreshold: number;
  diskThreshold: number;
  notificationCooldown: number; // minutes
  escalationDelay: number; // minutes
  adminPhoneNumbers: string[];
  enableWhatsAppAlerts: boolean;
  enableEmailAlerts: boolean;
}

// Performance metrics type
interface PerformanceMetrics {
  memory: number;
  uptime: number;
  errors: number;
  successRate: number;
}

// System statistics type
interface SystemStatistics {
  automation: {
    isRunning: boolean;
    lastCheck: Date;
  };
  audit: {
    inMemoryLogs: number;
    activeSessions: number;
    performanceMetrics: Record<string, { count: number; average: number }>;
    uptime: number;
  };
  notifications: {
    scheduledNotifications: number;
    uptime: number;
  };
  circles: {
    cachedCircles: number;
    cacheHitRate: string;
    memoryUsage: string;
  };
  monitoring: {
    activeAlerts: number;
    healthChecks: number;
    uptime: number;
    performanceHistory: number;
  };
}

/**
 * 📊 Automation Monitoring Service
 * 
 * Comprehensive monitoring and dashboard service featuring:
 * - Real-time system health monitoring
 * - Performance metrics and analytics
 * - Automated alerting and escalation
 * - Dashboard API endpoints
 * - Historical trend analysis
 * - Admin notification system
 */
export class AutomationMonitoringService {
  private static instance: AutomationMonitoringService;
  
  // Monitoring state
  private healthStatus!: SystemHealthStatus;
  private metrics!: DashboardMetrics;
  private alertConfig!: AlertConfiguration;
  
  // Alert tracking
  private activeAlerts: Map<string, { lastSent: Date; count: number }> = new Map();
  private alertHistory: Array<{ id: string; type: string; message: string; timestamp: Date; resolved?: Date }> = [];
  
  // Performance tracking
  private performanceHistory: Array<{ timestamp: Date; metrics: PerformanceMetrics }> = [];
  private readonly PERFORMANCE_HISTORY_LIMIT = 1440; // 24 hours of minute-by-minute data
  
  // Monitoring intervals
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private alertCheckInterval: NodeJS.Timeout | null = null;
  private metricsCollectionInterval: NodeJS.Timeout | null = null;
  
  // Configuration
  private readonly HEALTH_CHECK_INTERVAL = 60 * 1000; // 1 minute
  private readonly ALERT_CHECK_INTERVAL = 30 * 1000; // 30 seconds
  private readonly METRICS_COLLECTION_INTERVAL = 60 * 1000; // 1 minute

  private constructor() {
    // Initialize default configuration
    this.initializeDefaultConfig();
    
    // Initialize monitoring state
    this.initializeMonitoringState();
    
    // Start monitoring
    this.startMonitoring();
    
    logger.info('Automation Monitoring Service initialized');
    
    // Log initialization event
    automationAuditLogger.logEvent(
      'system_started',
      'info',
      'automation-monitoring',
      'Monitoring service initialized',
      {
        healthCheckInterval: this.HEALTH_CHECK_INTERVAL,
        alertCheckInterval: this.ALERT_CHECK_INTERVAL,
        metricsCollectionInterval: this.METRICS_COLLECTION_INTERVAL
      }
    );
  }

  public static getInstance(): AutomationMonitoringService {
    if (!AutomationMonitoringService.instance) {
      AutomationMonitoringService.instance = new AutomationMonitoringService();
    }
    return AutomationMonitoringService.instance;
  }

  /**
   * 🏥 GET HEALTH STATUS: Get current system health
   */
  public getHealthStatus(): SystemHealthStatus {
    return { ...this.healthStatus };
  }

  /**
   * 📊 GET DASHBOARD METRICS: Get real-time metrics for dashboard
   */
  public getDashboardMetrics(timeRange?: { start: Date; end: Date }): DashboardMetrics {
    // Update metrics before returning
    this.collectCurrentMetrics();
    
    // Filter alerts by time range if provided
    let alerts = this.metrics.alerts;
    if (timeRange) {
      alerts = alerts.filter(alert => 
        alert.timestamp >= timeRange.start && alert.timestamp <= timeRange.end
      );
    }
    
    return {
      ...this.metrics,
      alerts,
      timeRange: timeRange || {
        start: new Date(Date.now() - 60 * 60 * 1000), // Last hour
        end: new Date()
      }
    };
  }

  /**
   * 📈 GET PERFORMANCE HISTORY: Get historical performance data
   */
  public getPerformanceHistory(hours: number = 24): Array<{ timestamp: Date; metrics: PerformanceMetrics }> {
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
    return this.performanceHistory.filter(entry => entry.timestamp >= cutoff);
  }

  /**
   * 🚨 GET ACTIVE ALERTS: Get currently active alerts
   */
  public getActiveAlerts(): Array<{
    id: string;
    type: string;
    severity: 'low' | 'medium' | 'high' | 'critical';
    message: string;
    timestamp: Date;
    count: number;
  }> {
    const activeAlerts: Array<{
      id: string;
      type: string;
      severity: 'low' | 'medium' | 'high' | 'critical';
      message: string;
      timestamp: Date;
      count: number;
    }> = [];
    
    // Get alerts from audit logger
    const systemAlerts = automationAuditLogger.getAlerts();
    
    for (const alert of systemAlerts) {
      const alertId = `${alert.type}_${alert.severity}`;
      const tracking = this.activeAlerts.get(alertId);
      
      activeAlerts.push({
        id: alertId,
        type: alert.type,
        severity: alert.severity,
        message: alert.message,
        timestamp: alert.timestamp,
        count: tracking?.count || 1
      });
    }
    
    return activeAlerts;
  }

  /**
   * 📋 GET AUDIT SUMMARY: Get summary of recent audit events
   */
  public getAuditSummary(hours: number = 24): {
    totalEvents: number;
    errorRate: number;
    topEventTypes: Array<{ type: AuditEventType; count: number }>;
    recentErrors: Array<{ timestamp: Date; message: string; source: string }>;
  } {
    const timeRange = {
      start: new Date(Date.now() - hours * 60 * 60 * 1000),
      end: new Date()
    };
    
    const metrics = automationAuditLogger.getMetrics(timeRange);
    const errorLogs = automationAuditLogger.queryLogs({
      level: 'error',
      timeRange,
      limit: 10
    });
    
    // Get top event types
    const topEventTypes = Object.entries(metrics.eventsByType)
      .map(([type, count]) => ({ type: type as AuditEventType, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
    
    // Get recent errors
    const recentErrors = errorLogs.map(log => ({
      timestamp: log.timestamp,
      message: log.errorDetails?.message || log.action,
      source: log.source
    }));
    
    return {
      totalEvents: metrics.totalEvents,
      errorRate: metrics.errorRate,
      topEventTypes,
      recentErrors
    };
  }

  /**
   * ⚙️ UPDATE ALERT CONFIG: Update alerting configuration
   */
  public updateAlertConfiguration(config: Partial<AlertConfiguration>): void {
    this.alertConfig = { ...this.alertConfig, ...config };
    
    logger.info('Alert configuration updated', config);
    
    automationAuditLogger.logEvent(
      'configuration_changed',
      'info',
      'automation-monitoring',
      'Alert configuration updated',
      { updatedFields: Object.keys(config), newConfig: this.alertConfig }
    );
  }

  /**
   * 🧪 TRIGGER TEST ALERT: Send test alert to verify alerting system
   */
  public async triggerTestAlert(severity: 'low' | 'medium' | 'high' | 'critical' = 'medium'): Promise<boolean> {
    try {
      const testAlert = {
        type: 'admin_action',
        severity,
        message: `Test alert triggered at ${new Date().toISOString()}`,
        details: { test: true, triggeredBy: 'admin', timestamp: new Date() },
        timestamp: new Date()
      };
      
      await this.processAlert(testAlert);
      
      logger.info('Test alert triggered successfully', { severity });
      
      automationAuditLogger.logEvent(
        'admin_action',
        'info',
        'automation-monitoring',
        'Test alert triggered',
        { severity, success: true }
      );
      
      return true;
    } catch (error) {
      logger.error('Failed to trigger test alert:', error);
      return false;
    }
  }

  /**
   * 📊 GET SYSTEM STATISTICS: Get comprehensive system statistics
   */
  public getSystemStatistics(): SystemStatistics {
    // Get statistics from various services
    const auditStats = automationAuditLogger.getStatistics();
    // ⚠️ DEPRECATED: WhatsApp notification service removed
    // const notificationStats = whatsappNotificationService.getStats();
    const notificationStats = null;
    const circleStats = circleMemberManager.getCacheStats();
    
    return {
      automation: {
        // Would get this from automation service if it were running
        isRunning: false,
        lastCheck: this.healthStatus.timestamp
      },
      audit: auditStats,
      notifications: notificationStats,
      circles: circleStats,
      monitoring: {
        activeAlerts: this.activeAlerts.size,
        healthChecks: this.performanceHistory.length,
        uptime: process.uptime(),
        performanceHistory: this.performanceHistory.length
      }
    };
  }

  // ===========================================
  // PRIVATE MONITORING METHODS
  // ===========================================

  private initializeDefaultConfig(): void {
    this.alertConfig = {
      errorRateThreshold: 20, // 20% error rate
      performanceThreshold: 30000, // 30 seconds
      memoryThreshold: 80, // 80% memory usage
      diskThreshold: 90, // 90% disk usage
      notificationCooldown: 15, // 15 minutes
      escalationDelay: 60, // 1 hour
      adminPhoneNumbers: [], // No default admin numbers
      enableWhatsAppAlerts: true,
      enableEmailAlerts: false
    };
  }

  private initializeMonitoringState(): void {
    const now = new Date();
    
    this.healthStatus = {
      overall: 'healthy',
      timestamp: now,
      components: {
        automationService: { status: 'healthy', lastCheck: now },
        blockchain: { status: 'healthy', lastCheck: now },
        notifications: { status: 'healthy', lastCheck: now },
        database: { status: 'healthy', lastCheck: now },
        performance: { status: 'healthy', lastCheck: now }
      },
      uptime: process.uptime(),
      version: '1.0.0'
    };
    
    this.metrics = {
      automation: {
        isRunning: false,
        activeCircles: 0,
        payoutsTriggered: 0,
        notificationsSent: 0,
        errors: 0,
        successRate: 100,
        averageResponseTime: 0
      },
      performance: {
        uptime: process.uptime(),
        memoryUsage: process.memoryUsage().heapUsed,
        cpuUsage: 0,
        diskUsage: 0,
        networkLatency: 0
      },
      blockchain: {
        latestBlock: 0,
        transactionCount: 0,
        gasUsed: 0,
        networkStatus: 'connected'
      },
      alerts: [],
      timeRange: {
        start: new Date(Date.now() - 60 * 60 * 1000),
        end: now
      }
    };
  }

  private startMonitoring(): void {
    // Health check interval
    this.healthCheckInterval = setInterval(() => {
      this.performHealthCheck().catch(error => {
        logger.error('Health check failed:', error);
      });
    }, this.HEALTH_CHECK_INTERVAL);

    // Alert check interval
    this.alertCheckInterval = setInterval(() => {
      this.checkAndProcessAlerts().catch(error => {
        logger.error('Alert check failed:', error);
      });
    }, this.ALERT_CHECK_INTERVAL);

    // Metrics collection interval
    this.metricsCollectionInterval = setInterval(() => {
      this.collectAndStoreMetrics();
    }, this.METRICS_COLLECTION_INTERVAL);

    logger.info('Monitoring intervals started');
  }

  private async performHealthCheck(): Promise<void> {
    const now = new Date();
    
    try {
      // Check automation service health
      this.healthStatus.components.automationService = await this.checkAutomationService();
      
      // Check notification service health
      this.healthStatus.components.notifications = await this.checkNotificationService();
      
      // Check performance health
      this.healthStatus.components.performance = await this.checkPerformanceHealth();
      
      // Determine overall health
      const componentStatuses = Object.values(this.healthStatus.components).map(c => c.status);
      
      if (componentStatuses.includes('critical') || componentStatuses.includes('offline')) {
        this.healthStatus.overall = 'critical';
      } else if (componentStatuses.includes('warning')) {
        this.healthStatus.overall = 'warning';
      } else {
        this.healthStatus.overall = 'healthy';
      }
      
      this.healthStatus.timestamp = now;
      this.healthStatus.uptime = process.uptime();
      
      // Log health check
      automationAuditLogger.logEvent(
        'health_check_passed',
        this.healthStatus.overall === 'healthy' ? 'info' : 'warn',
        'automation-monitoring',
        'System health check completed',
        {
          overall: this.healthStatus.overall,
          components: this.healthStatus.components
        }
      );
      
    } catch (error) {
      logger.error('Health check failed:', error);
      
      this.healthStatus.overall = 'critical';
      this.healthStatus.timestamp = now;
      
      automationAuditLogger.logEvent(
        'health_check_failed',
        'error',
        'automation-monitoring',
        'System health check failed',
        { error: error instanceof Error ? error.message : String(error) },
        { error: error instanceof Error ? error : undefined }
      );
    }
  }

  private async checkAutomationService(): Promise<ComponentHealth> {
    // This would check if the automation service is running and healthy
    // For now, return a basic health check
    return {
      status: 'healthy',
      lastCheck: new Date(),
      message: 'Service monitoring not yet implemented',
      metrics: {
        activeCircles: 0,
        payoutsProcessed: 0
      }
    };
  }

  private async checkNotificationService(): Promise<ComponentHealth> {
    try {
      // ⚠️ DEPRECATED: WhatsApp notification service removed
      // const stats = whatsappNotificationService.getStats();
      const stats = null;
      
      return {
        status: 'healthy',
        lastCheck: new Date(),
        message: 'Notification service operational',
        metrics: {
          scheduledNotifications: stats.scheduledNotifications,
          uptime: stats.uptime
        }
      };
    } catch (error) {
      return {
        status: 'warning',
        lastCheck: new Date(),
        message: `Notification service check failed: ${error}`
      };
    }
  }

  private async checkPerformanceHealth(): Promise<ComponentHealth> {
    const memUsage = process.memoryUsage();
    const memUsagePercent = (memUsage.heapUsed / memUsage.heapTotal) * 100;
    
    let status: ComponentHealth['status'] = 'healthy';
    let message = 'Performance within normal parameters';
    
    if (memUsagePercent > this.alertConfig.memoryThreshold) {
      status = 'warning';
      message = `High memory usage: ${memUsagePercent.toFixed(1)}%`;
    }
    
    return {
      status,
      lastCheck: new Date(),
      message,
      metrics: {
        memoryUsagePercent: memUsagePercent,
        heapUsed: memUsage.heapUsed,
        heapTotal: memUsage.heapTotal,
        uptime: process.uptime()
      }
    };
  }

  private async checkAndProcessAlerts(): Promise<void> {
    try {
      // Get alerts from audit logger
      const systemAlerts = automationAuditLogger.getAlerts();
      
      for (const alert of systemAlerts) {
        await this.processAlert(alert);
      }
      
      // Clean up old alerts
      this.cleanupOldAlerts();
      
    } catch (error) {
      logger.error('Alert processing failed:', error);
    }
  }

  private async processAlert(alert: {
    type: string;
    severity: 'low' | 'medium' | 'high' | 'critical';
    message: string;
    details?: Record<string, unknown>;
    timestamp: Date;
  }): Promise<void> {
    const alertId = `${alert.type}_${alert.severity}`;
    const now = new Date();
    
    // Check if we've already sent this alert recently
    const existing = this.activeAlerts.get(alertId);
    if (existing) {
      const cooldownMs = this.alertConfig.notificationCooldown * 60 * 1000;
      if (now.getTime() - existing.lastSent.getTime() < cooldownMs) {
        // Still in cooldown period
        existing.count++;
        return;
      }
    }
    
    // Send alert notification
    if (this.alertConfig.enableWhatsAppAlerts && this.alertConfig.adminPhoneNumbers.length > 0) {
      await this.sendAlertNotification(alert);
    }
    
    // Track alert
    this.activeAlerts.set(alertId, {
      lastSent: now,
      count: (existing?.count || 0) + 1
    });
    
    // Add to alert history
    this.alertHistory.push({
      id: alertId,
      type: alert.type,
      message: alert.message,
      timestamp: alert.timestamp
    });
    
    // Add to current metrics
    this.metrics.alerts.push({
      type: alert.type,
      severity: alert.severity,
      message: alert.message,
      timestamp: alert.timestamp
    });
    
    // Trim alerts list
    if (this.metrics.alerts.length > 50) {
      this.metrics.alerts = this.metrics.alerts.slice(-50);
    }
    
    logger.warn(`Alert processed: ${alert.type} - ${alert.message}`, { 
      severity: alert.severity,
      alertId 
    });
  }

  private async sendAlertNotification(alert: {
    type: string;
    severity: 'low' | 'medium' | 'high' | 'critical';
    message: string;
    timestamp: Date;
  }): Promise<void> {
    try {
      const severityEmoji = {
        low: 'ℹ️',
        medium: '⚠️',
        high: '🚨',
        critical: '🔴'
      };
      
      const alertMessage = `${severityEmoji[alert.severity]} **NJANGI AUTOMATION ALERT**\n\n` +
        `**Type:** ${alert.type}\n` +
        `**Severity:** ${alert.severity.toUpperCase()}\n` +
        `**Message:** ${alert.message}\n` +
        `**Time:** ${alert.timestamp.toISOString()}\n\n` +
        `Please check the automation system immediately.`;
      
      // ⚠️ DEPRECATED: WhatsApp notification service removed
      // Send to all admin phone numbers (now disabled)
      // const promises = this.alertConfig.adminPhoneNumbers.map(phoneNumber =>
      //   whatsappNotificationService.sendImmediateNotification(
      //     phoneNumber,
      //     'admin_alert',
      //     {
      //       alertType: alert.type,
      //       severity: alert.severity,
      //       message: alertMessage,
      //       timestamp: alert.timestamp.toISOString()
      //     }
      //   )
      // );
      //
      // const results = await Promise.allSettled(promises);
      // const successful = results.filter(r => r.status === 'fulfilled' && r.value).length;
      
      const successful = 0; // Disabled
      
      logger.info(`Alert notification sent to ${successful}/${this.alertConfig.adminPhoneNumbers.length} admins`);
      
    } catch (error) {
      logger.error('Failed to send alert notification:', error);
    }
  }

  private collectCurrentMetrics(): void {
    const memUsage = process.memoryUsage();
    
    this.metrics.performance = {
      uptime: process.uptime(),
      memoryUsage: memUsage.heapUsed,
      cpuUsage: 0, // Would implement CPU monitoring
      diskUsage: 0, // Would implement disk monitoring
      networkLatency: 0 // Would implement network monitoring
    };
    
    // Update automation metrics from audit logs
    const recentMetrics = automationAuditLogger.getMetrics({
      start: new Date(Date.now() - 60 * 60 * 1000), // Last hour
      end: new Date()
    });
    
    this.metrics.automation = {
      isRunning: false, // Would check automation service status
      activeCircles: 0, // Would get from automation service
      payoutsTriggered: recentMetrics.eventsByType.payout_triggered || 0,
      notificationsSent: recentMetrics.eventsByType.notification_sent || 0,
      errors: recentMetrics.eventsByLevel.error || 0,
      successRate: recentMetrics.successRate,
      averageResponseTime: recentMetrics.performance.averageDuration
    };
  }

  private collectAndStoreMetrics(): void {
    this.collectCurrentMetrics();
    
    // Store in performance history
    this.performanceHistory.push({
      timestamp: new Date(),
      metrics: {
        memory: this.metrics.performance.memoryUsage,
        uptime: this.metrics.performance.uptime,
        errors: this.metrics.automation.errors,
        successRate: this.metrics.automation.successRate
      }
    });
    
    // Trim history
    if (this.performanceHistory.length > this.PERFORMANCE_HISTORY_LIMIT) {
      this.performanceHistory = this.performanceHistory.slice(-this.PERFORMANCE_HISTORY_LIMIT);
    }
  }

  private cleanupOldAlerts(): void {
    const now = new Date();
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours
    
    // Clean up active alerts
    for (const [alertId, tracking] of this.activeAlerts.entries()) {
      if (now.getTime() - tracking.lastSent.getTime() > maxAge) {
        this.activeAlerts.delete(alertId);
      }
    }
    
    // Clean up alert history
    this.alertHistory = this.alertHistory.filter(
      alert => now.getTime() - alert.timestamp.getTime() <= maxAge
    );
    
    // Clean up metrics alerts
    this.metrics.alerts = this.metrics.alerts.filter(
      alert => now.getTime() - alert.timestamp.getTime() <= maxAge
    );
  }

  /**
   * 🛑 SHUTDOWN: Stop monitoring service
   */
  public shutdown(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    
    if (this.alertCheckInterval) {
      clearInterval(this.alertCheckInterval);
      this.alertCheckInterval = null;
    }
    
    if (this.metricsCollectionInterval) {
      clearInterval(this.metricsCollectionInterval);
      this.metricsCollectionInterval = null;
    }
    
    logger.info('Automation Monitoring Service shut down');
    
    automationAuditLogger.logEvent(
      'system_stopped',
      'info',
      'automation-monitoring',
      'Monitoring service shut down',
      { uptime: process.uptime() }
    );
  }
}

// Export singleton instance
export const automationMonitoringService = AutomationMonitoringService.getInstance(); 