import { createLogger, format, transports } from 'winston';
import { automationAuditLogger } from './automation-audit-logger.service';
// ⚠️ DEPRECATED: Removed import of deleted notification service
// import { whatsappNotificationService } from './whatsapp-notification.service';
// Use whatsapp-bot-backend for notifications instead

// Create logger instance
const logger = createLogger({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  format: format.combine(
    format.timestamp(),
    format.errors({ stack: true }),
    format.printf((info) => {
      return `${info.timestamp} [${info.level.toUpperCase()}] AdminAlerts: ${info.message}${info.stack ? `\n${info.stack}` : ''}`;
    })
  ),
  transports: [
    new transports.Console(),
    new transports.File({ filename: '.taskmaster/logs/admin-alerts.log' })
  ]
});

// Alert types and severity levels
export type AlertType = 
  | 'system_failure'
  | 'performance_degradation'
  | 'high_error_rate'
  | 'automation_stopped'
  | 'blockchain_connectivity'
  | 'notification_failure'
  | 'security_incident'
  | 'data_inconsistency'
  | 'manual_intervention_required'
  | 'configuration_issue';

export type AlertSeverity = 'low' | 'medium' | 'high' | 'critical';

// Alert configuration per type
export interface AlertRule {
  type: AlertType;
  enabled: boolean;
  threshold?: number;
  timeWindow?: number; // minutes
  cooldownPeriod?: number; // minutes
  escalationDelay?: number; // minutes
  maxAlerts?: number; // per time window
  notificationMethods: ('whatsapp' | 'email' | 'webhook')[];
  adminGroups: string[]; // Groups to notify
}

// Admin contact information
export interface AdminContact {
  id: string;
  name: string;
  phoneNumber?: string;
  email?: string;
  role: 'primary' | 'secondary' | 'escalation';
  groups: string[];
  availabilityHours?: {
    start: string; // HH:MM format
    end: string;   // HH:MM format
    timezone: string;
  };
  isActive: boolean;
}

// Alert instance
export interface AlertInstance {
  id: string;
  type: AlertType;
  severity: AlertSeverity;
  title: string;
  description: string;
  details: Record<string, unknown>;
  source: string;
  timestamp: Date;
  status: 'active' | 'acknowledged' | 'resolved' | 'escalated';
  notificationsSent: number;
  lastNotificationSent?: Date;
  acknowledgedBy?: string;
  acknowledgedAt?: Date;
  resolvedBy?: string;
  resolvedAt?: Date;
  escalatedAt?: Date;
  relatedCircleId?: string;
  actionUrl?: string;
}

// Escalation workflow
export interface EscalationWorkflow {
  alertType: AlertType;
  steps: Array<{
    delayMinutes: number;
    adminGroups: string[];
    notificationMethods: ('whatsapp' | 'email')[];
    message?: string;
  }>;
}

/**
 * 🚨 Automation Admin Alerts Service
 * 
 * Manages admin alerting and escalation workflows featuring:
 * - Configurable alert rules and thresholds
 * - Multi-channel notification delivery
 * - Escalation workflows with timing
 * - Admin contact management
 * - Alert acknowledgment and resolution
 * - Comprehensive audit trails
 */
export class AutomationAdminAlertsService {
  private static instance: AutomationAdminAlertsService;
  
  // Configuration
  private alertRules: Map<AlertType, AlertRule> = new Map();
  private adminContacts: Map<string, AdminContact> = new Map();
  private escalationWorkflows: Map<AlertType, EscalationWorkflow> = new Map();
  
  // Active alert tracking
  private activeAlerts: Map<string, AlertInstance> = new Map();
  private alertHistory: AlertInstance[] = [];
  private cooldownTracker: Map<string, Date> = new Map();
  
  // Escalation timers
  private escalationTimers: Map<string, NodeJS.Timeout> = new Map();
  
  // Configuration
  private readonly MAX_ALERT_HISTORY = 1000;
  private readonly DEFAULT_COOLDOWN_MINUTES = 15;
  private readonly DEFAULT_ESCALATION_DELAY_MINUTES = 60;

  private constructor() {
    // Initialize default configuration
    this.initializeDefaultConfiguration();
    
    logger.info('Admin Alerts Service initialized');
    
    automationAuditLogger.logEvent(
      'system_started',
      'info',
      'admin-alerts',
      'Admin alerts service initialized',
      {
        alertRules: this.alertRules.size,
        adminContacts: this.adminContacts.size,
        escalationWorkflows: this.escalationWorkflows.size
      }
    );
  }

  public static getInstance(): AutomationAdminAlertsService {
    if (!AutomationAdminAlertsService.instance) {
      AutomationAdminAlertsService.instance = new AutomationAdminAlertsService();
    }
    return AutomationAdminAlertsService.instance;
  }

  /**
   * 🚨 TRIGGER ALERT: Create and process a new alert
   */
  public async triggerAlert(
    type: AlertType,
    severity: AlertSeverity,
    title: string,
    description: string,
    details: Record<string, unknown> = {},
    options: {
      source?: string;
      circleId?: string;
      actionUrl?: string;
      skipCooldown?: boolean;
    } = {}
  ): Promise<string> {
    const alertId = this.generateAlertId();
    const now = new Date();
    
    // Check cooldown period
    const cooldownKey = `${type}_${severity}`;
    if (!options.skipCooldown && this.isInCooldown(cooldownKey)) {
      logger.debug(`Alert ${type} is in cooldown period, skipping`);
      return '';
    }
    
    // Check alert rule
    const rule = this.alertRules.get(type);
    if (!rule || !rule.enabled) {
      logger.debug(`Alert rule for ${type} is disabled, skipping`);
      return '';
    }
    
    // Create alert instance
    const alert: AlertInstance = {
      id: alertId,
      type,
      severity,
      title,
      description,
      details,
      source: options.source || 'automation-system',
      timestamp: now,
      status: 'active',
      notificationsSent: 0,
      relatedCircleId: options.circleId,
      actionUrl: options.actionUrl
    };
    
    // Store alert
    this.activeAlerts.set(alertId, alert);
    this.alertHistory.push({ ...alert });
    
    // Trim history if needed
    if (this.alertHistory.length > this.MAX_ALERT_HISTORY) {
      this.alertHistory = this.alertHistory.slice(-this.MAX_ALERT_HISTORY);
    }
    
    // Set cooldown
    this.cooldownTracker.set(cooldownKey, now);
    
    // Send initial notifications
    await this.sendAlertNotifications(alert, rule);
    
    // Set up escalation if configured
    this.setupEscalation(alert);
    
    // Log alert
    automationAuditLogger.logEvent(
      'admin_action',
      severity === 'critical' ? 'error' : 'warn',
      'admin-alerts',
      `Alert triggered: ${type}`,
      {
        alertId,
        severity,
        title,
        details,
        notificationMethods: rule.notificationMethods
      }
    );
    
    logger.warn(`Alert triggered: ${title}`, {
      alertId,
      type,
      severity,
      source: options.source
    });
    
    return alertId;
  }

  /**
   * ✅ ACKNOWLEDGE ALERT: Mark alert as acknowledged
   */
  public async acknowledgeAlert(alertId: string, acknowledgedBy: string): Promise<boolean> {
    const alert = this.activeAlerts.get(alertId);
    if (!alert) {
      logger.warn(`Attempted to acknowledge non-existent alert: ${alertId}`);
      return false;
    }
    
    if (alert.status !== 'active') {
      logger.warn(`Alert ${alertId} is not in active status, cannot acknowledge`);
      return false;
    }
    
    // Update alert status
    alert.status = 'acknowledged';
    alert.acknowledgedBy = acknowledgedBy;
    alert.acknowledgedAt = new Date();
    
    // Cancel escalation timer
    const escalationTimer = this.escalationTimers.get(alertId);
    if (escalationTimer) {
      clearTimeout(escalationTimer);
      this.escalationTimers.delete(alertId);
    }
    
    // Log acknowledgment
    automationAuditLogger.logEvent(
      'admin_action',
      'info',
      'admin-alerts',
      `Alert acknowledged: ${alert.type}`,
      {
        alertId,
        acknowledgedBy,
        title: alert.title
      }
    );
    
    logger.info(`Alert acknowledged: ${alert.title}`, {
      alertId,
      acknowledgedBy
    });
    
    return true;
  }

  /**
   * 🔧 RESOLVE ALERT: Mark alert as resolved
   */
  public async resolveAlert(alertId: string, resolvedBy: string, resolution?: string): Promise<boolean> {
    const alert = this.activeAlerts.get(alertId);
    if (!alert) {
      logger.warn(`Attempted to resolve non-existent alert: ${alertId}`);
      return false;
    }
    
    // Update alert status
    alert.status = 'resolved';
    alert.resolvedBy = resolvedBy;
    alert.resolvedAt = new Date();
    
    if (resolution) {
      alert.details.resolution = resolution;
    }
    
    // Cancel escalation timer
    const escalationTimer = this.escalationTimers.get(alertId);
    if (escalationTimer) {
      clearTimeout(escalationTimer);
      this.escalationTimers.delete(alertId);
    }
    
    // Remove from active alerts
    this.activeAlerts.delete(alertId);
    
    // Log resolution
    automationAuditLogger.logEvent(
      'admin_action',
      'info',
      'admin-alerts',
      `Alert resolved: ${alert.type}`,
      {
        alertId,
        resolvedBy,
        resolution,
        title: alert.title,
        duration: alert.resolvedAt.getTime() - alert.timestamp.getTime()
      }
    );
    
    logger.info(`Alert resolved: ${alert.title}`, {
      alertId,
      resolvedBy,
      resolution
    });
    
    return true;
  }

  /**
   * 📋 GET ACTIVE ALERTS: Get all currently active alerts
   */
  public getActiveAlerts(): AlertInstance[] {
    return Array.from(this.activeAlerts.values())
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  }

  /**
   * 📊 GET ALERT STATISTICS: Get alert statistics and metrics
   */
  public getAlertStatistics(timeRange?: { start: Date; end: Date }): {
    totalAlerts: number;
    activeAlerts: number;
    alertsByType: Record<AlertType, number>;
    alertsBySeverity: Record<AlertSeverity, number>;
    averageResolutionTime: number;
    escalationRate: number;
  } {
    const now = new Date();
    const defaultStart = new Date(now.getTime() - 24 * 60 * 60 * 1000); // Last 24 hours
    
    const start = timeRange?.start || defaultStart;
    const end = timeRange?.end || now;
    
    const filteredAlerts = this.alertHistory.filter(
      alert => alert.timestamp >= start && alert.timestamp <= end
    );
    
    const alertsByType: Record<string, number> = {};
    const alertsBySeverity: Record<string, number> = {};
    let totalResolutionTime = 0;
    let resolvedAlerts = 0;
    let escalatedAlerts = 0;
    
    filteredAlerts.forEach(alert => {
      // Count by type
      alertsByType[alert.type] = (alertsByType[alert.type] || 0) + 1;
      
      // Count by severity
      alertsBySeverity[alert.severity] = (alertsBySeverity[alert.severity] || 0) + 1;
      
      // Calculate resolution time
      if (alert.resolvedAt) {
        totalResolutionTime += alert.resolvedAt.getTime() - alert.timestamp.getTime();
        resolvedAlerts++;
      }
      
      // Count escalations
      if (alert.escalatedAt) {
        escalatedAlerts++;
      }
    });
    
    return {
      totalAlerts: filteredAlerts.length,
      activeAlerts: this.activeAlerts.size,
      alertsByType: alertsByType as Record<AlertType, number>,
      alertsBySeverity: alertsBySeverity as Record<AlertSeverity, number>,
      averageResolutionTime: resolvedAlerts > 0 ? totalResolutionTime / resolvedAlerts : 0,
      escalationRate: filteredAlerts.length > 0 ? (escalatedAlerts / filteredAlerts.length) * 100 : 0
    };
  }

  /**
   * ⚙️ UPDATE ALERT RULE: Update configuration for an alert type
   */
  public updateAlertRule(type: AlertType, rule: Partial<AlertRule>): void {
    const existingRule = this.alertRules.get(type);
    if (!existingRule) {
      logger.warn(`Attempted to update non-existent alert rule: ${type}`);
      return;
    }
    
    const updatedRule = { ...existingRule, ...rule };
    this.alertRules.set(type, updatedRule);
    
    automationAuditLogger.logEvent(
      'configuration_changed',
      'info',
      'admin-alerts',
      `Alert rule updated: ${type}`,
      { type, updatedFields: Object.keys(rule), newRule: updatedRule }
    );
    
    logger.info(`Alert rule updated: ${type}`, { updatedFields: Object.keys(rule) });
  }

  /**
   * 👤 ADD ADMIN CONTACT: Add or update admin contact information
   */
  public addAdminContact(contact: AdminContact): void {
    this.adminContacts.set(contact.id, contact);
    
    automationAuditLogger.logEvent(
      'configuration_changed',
      'info',
      'admin-alerts',
      'Admin contact added/updated',
      { contactId: contact.id, name: contact.name, role: contact.role, groups: contact.groups }
    );
    
    logger.info(`Admin contact added/updated: ${contact.name}`, {
      contactId: contact.id,
      role: contact.role
    });
  }

  /**
   * 🧪 SEND TEST ALERT: Send test alert to verify notification system
   */
  public async sendTestAlert(
    severity: AlertSeverity = 'medium',
    targetGroup?: string
  ): Promise<string> {
    return await this.triggerAlert(
      'manual_intervention_required',
      severity,
      'Test Alert - System Verification',
      `This is a test alert to verify the admin notification system. Triggered at ${new Date().toISOString()}`,
      {
        test: true,
        targetGroup,
        triggeredBy: 'admin',
        timestamp: new Date().toISOString()
      },
      {
        source: 'admin-test',
        skipCooldown: true
      }
    );
  }

  // ===========================================
  // PRIVATE HELPER METHODS
  // ===========================================

  private initializeDefaultConfiguration(): void {
    // Default alert rules
    const defaultRules: Array<[AlertType, AlertRule]> = [
      ['system_failure', {
        type: 'system_failure',
        enabled: true,
        cooldownPeriod: 30,
        escalationDelay: 15,
        maxAlerts: 5,
        notificationMethods: ['whatsapp'],
        adminGroups: ['primary', 'escalation']
      }],
      ['high_error_rate', {
        type: 'high_error_rate',
        enabled: true,
        threshold: 20, // 20% error rate
        timeWindow: 60,
        cooldownPeriod: 15,
        escalationDelay: 30,
        maxAlerts: 3,
        notificationMethods: ['whatsapp'],
        adminGroups: ['primary']
      }],
      ['automation_stopped', {
        type: 'automation_stopped',
        enabled: true,
        cooldownPeriod: 10,
        escalationDelay: 20,
        maxAlerts: 10,
        notificationMethods: ['whatsapp'],
        adminGroups: ['primary', 'escalation']
      }],
      ['performance_degradation', {
        type: 'performance_degradation',
        enabled: true,
        threshold: 30000, // 30 seconds
        timeWindow: 30,
        cooldownPeriod: 20,
        escalationDelay: 45,
        maxAlerts: 3,
        notificationMethods: ['whatsapp'],
        adminGroups: ['primary']
      }]
    ];
    
    defaultRules.forEach(([type, rule]) => {
      this.alertRules.set(type, rule);
    });
    
    // Default escalation workflows
    this.escalationWorkflows.set('system_failure', {
      alertType: 'system_failure',
      steps: [
        {
          delayMinutes: 0,
          adminGroups: ['primary'],
          notificationMethods: ['whatsapp']
        },
        {
          delayMinutes: 15,
          adminGroups: ['escalation'],
          notificationMethods: ['whatsapp'],
          message: 'ESCALATED: System failure alert has not been acknowledged'
        }
      ]
    });
  }

  private isInCooldown(cooldownKey: string): boolean {
    const lastSent = this.cooldownTracker.get(cooldownKey);
    if (!lastSent) return false;
    
    const cooldownMs = this.DEFAULT_COOLDOWN_MINUTES * 60 * 1000;
    return Date.now() - lastSent.getTime() < cooldownMs;
  }

  private async sendAlertNotifications(alert: AlertInstance, rule: AlertRule): Promise<void> {
    const promises: Promise<boolean>[] = [];
    
    // Get admins to notify
    const adminsToNotify = this.getAdminsToNotify(rule.adminGroups);
    
    if (rule.notificationMethods.includes('whatsapp')) {
      for (const admin of adminsToNotify) {
        if (admin.phoneNumber && admin.isActive) {
          promises.push(this.sendWhatsAppAlert(admin, alert));
        }
      }
    }
    
    // Send notifications
    const results = await Promise.allSettled(promises);
    const successful = results.filter(r => r.status === 'fulfilled' && r.value).length;
    
    alert.notificationsSent = successful;
    alert.lastNotificationSent = new Date();
    
    logger.info(`Alert notifications sent: ${successful}/${promises.length}`, {
      alertId: alert.id,
      type: alert.type
    });
  }

  private async sendWhatsAppAlert(admin: AdminContact, alert: AlertInstance): Promise<boolean> {
    try {
      // ⚠️ DEPRECATED: WhatsApp notification service removed
      // Use bot backend send-notification endpoint instead
      // 
      // For now, just log instead of sending
      logger.info(`Alert notification (WhatsApp disabled): ${alert.title} to ${admin.name}`);
      
      // TODO: Call bot backend /api/whatsapp/send-notification endpoint
      // const response = await fetch('https://bot-backend-url/api/whatsapp/send-notification', {
      //   method: 'POST',
      //   headers: { 'Content-Type': 'application/json' },
      //   body: JSON.stringify({
      //     phoneNumber: admin.phoneNumber,
      //     circleId: alert.relatedCircleId,
      //     circleName: 'Admin Alert',
      //     notificationType: 'custom',
      //     customMessage: alert.description
      //   })
      // });
      
      return false; // Currently disabled
    } catch (error) {
      logger.error(`Failed to send WhatsApp alert to ${admin.name}:`, error);
      return false;
    }
  }

  private getAdminsToNotify(groups: string[]): AdminContact[] {
    return Array.from(this.adminContacts.values())
      .filter(admin => 
        admin.isActive && 
        groups.some(group => admin.groups.includes(group))
      );
  }

  private setupEscalation(alert: AlertInstance): void {
    const workflow = this.escalationWorkflows.get(alert.type);
    if (!workflow) return;
    
    // Set up escalation steps
    workflow.steps.forEach((step, index) => {
      if (index === 0) return; // Skip immediate notification step
      
      const timer = setTimeout(async () => {
        // Check if alert is still active
        const currentAlert = this.activeAlerts.get(alert.id);
        if (!currentAlert || currentAlert.status !== 'active') {
          return;
        }
        
        // Mark as escalated
        currentAlert.status = 'escalated';
        currentAlert.escalatedAt = new Date();
        
        // Send escalation notifications
        const rule: AlertRule = {
          type: alert.type,
          enabled: true,
          notificationMethods: step.notificationMethods,
          adminGroups: step.adminGroups
        };
        
        await this.sendAlertNotifications(currentAlert, rule);
        
        logger.warn(`Alert escalated: ${alert.title}`, {
          alertId: alert.id,
          escalationStep: index
        });
        
      }, step.delayMinutes * 60 * 1000);
      
      this.escalationTimers.set(`${alert.id}_${index}`, timer);
    });
  }

  private generateAlertId(): string {
    return `alert_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * 🛑 SHUTDOWN: Stop the admin alerts service
   */
  public shutdown(): void {
    // Clear all escalation timers
    for (const timer of this.escalationTimers.values()) {
      clearTimeout(timer);
    }
    this.escalationTimers.clear();
    
    logger.info('Admin Alerts Service shut down');
    
    automationAuditLogger.logEvent(
      'system_stopped',
      'info',
      'admin-alerts',
      'Admin alerts service shut down',
      { activeAlerts: this.activeAlerts.size }
    );
  }
}

// Export singleton instance
export const automationAdminAlertsService = AutomationAdminAlertsService.getInstance(); 