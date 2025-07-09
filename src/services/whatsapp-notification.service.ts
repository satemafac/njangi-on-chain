import { createLogger, format, transports } from 'winston';
import { WhatsAppService } from './whatsapp.service';
import { whatsappAuth } from './whatsapp-stateless-auth.service';

// Create logger instance
const logger = createLogger({
  level: 'info',
  format: format.combine(
    format.timestamp(),
    format.errors({ stack: true }),
    format.printf(({ timestamp, level, message, stack }) => {
      return `${timestamp} [${level.toUpperCase()}] WhatsApp Notifications: ${message}${stack ? `\n${stack}` : ''}`;
    })
  ),
  transports: [
    new transports.Console(),
    new transports.File({ filename: '.taskmaster/logs/whatsapp-notifications.log' })
  ]
});

// Notification types
export type NotificationType = 
  | 'contribution_reminder'
  | 'rotation_alert'
  | 'yield_update'
  | 'circle_invitation'
  | 'payment_confirmation'
  | 'cycle_completion'
  | 'deposit_required'
  | 'member_joined'
  | 'admin_alert'
  | 'payout_warning_24h'
  | 'payout_warning_6h'
  | 'payout_warning_1h'
  | 'automated_payout_success'
  | 'automation_failed';

// Notification data structure
export interface ScheduledNotification {
  id: string;
  phoneNumber: string;
  type: NotificationType;
  scheduledFor: Date;
  data: Record<string, unknown>;
  templateName?: string;
  retryCount: number;
  maxRetries: number;
  createdAt: Date;
}

// Template configuration
interface NotificationTemplate {
  type: NotificationType;
  templateName?: string;
  message: (data: Record<string, unknown>) => string;
  requiresAuth: boolean;
  priority: 'low' | 'medium' | 'high';
  maxRetries: number;
}

/**
 * 📱 WhatsApp Notification Service
 * 
 * Manages automated notifications for circle events, reminders, and alerts.
 * Features:
 * - In-memory scheduling with auto-cleanup
 * - Template-based message generation
 * - Retry logic with exponential backoff
 * - Authentication-aware delivery
 * - Event-driven and scheduled notifications
 */
export class WhatsAppNotificationService {
  private static instance: WhatsAppNotificationService;
  private whatsappService: WhatsAppService;
  
  // In-memory storage
  private scheduledNotifications: Map<string, ScheduledNotification> = new Map();
  private processingInterval: NodeJS.Timeout | null = null;
  
  // Configuration
  private readonly PROCESSING_INTERVAL = 60 * 1000; // 1 minute
  private readonly CLEANUP_INTERVAL = 10 * 60 * 1000; // 10 minutes
  private readonly DEFAULT_MAX_RETRIES = 3;

  private constructor() {
    this.whatsappService = WhatsAppService.getInstance();
    this.initializeService();
  }

  public static getInstance(): WhatsAppNotificationService {
    if (!WhatsAppNotificationService.instance) {
      WhatsAppNotificationService.instance = new WhatsAppNotificationService();
    }
    return WhatsAppNotificationService.instance;
  }

  private initializeService(): void {
    // Start notification processing
    this.processingInterval = setInterval(() => {
      this.processScheduledNotifications();
    }, this.PROCESSING_INTERVAL);

    // Cleanup expired notifications
    setInterval(() => {
      this.cleanupExpiredNotifications();
    }, this.CLEANUP_INTERVAL);

    logger.info('WhatsApp Notification Service initialized');
  }

  /**
   * 📅 SCHEDULE: Schedule a notification for future delivery
   */
  public scheduleNotification(
    phoneNumber: string,
    type: NotificationType,
    scheduledFor: Date,
    data: Record<string, unknown> = {},
    options: {
      templateName?: string;
      maxRetries?: number;
    } = {}
  ): string {
    const notificationId = this.generateNotificationId();
    
    const notification: ScheduledNotification = {
      id: notificationId,
      phoneNumber,
      type,
      scheduledFor,
      data,
      templateName: options.templateName,
      retryCount: 0,
      maxRetries: options.maxRetries || this.DEFAULT_MAX_RETRIES,
      createdAt: new Date()
    };

    this.scheduledNotifications.set(notificationId, notification);
    
    logger.info(`Notification scheduled: ${type} for ${phoneNumber} at ${scheduledFor.toISOString()}`);
    
    return notificationId;
  }

  /**
   * 🚀 IMMEDIATE: Send immediate notification
   */
  public async sendImmediateNotification(
    phoneNumber: string,
    type: NotificationType,
    data: Record<string, unknown> = {},
    templateName?: string
  ): Promise<boolean> {
    try {
      const template = this.getNotificationTemplate(type);
      
      // Check authentication if required
      if (template.requiresAuth && !whatsappAuth.isPhoneAuthenticated(phoneNumber)) {
        logger.warn(`Skipping notification ${type} for unauthenticated user ${phoneNumber}`);
        return false;
      }

      const message = template.message(data);
      
      if (templateName || template.templateName) {
        // Use WhatsApp template if specified
        await this.whatsappService.sendTemplateMessage(
          phoneNumber,
          templateName || template.templateName!,
          'en',
          this.extractTemplateParameters(data)
        );
      } else {
        // Use regular text message
        await this.whatsappService.sendTextMessage(phoneNumber, message);
      }

      logger.info(`Immediate notification sent: ${type} to ${phoneNumber}`);
      return true;

    } catch (error) {
      logger.error(`Failed to send immediate notification ${type} to ${phoneNumber}:`, error);
      return false;
    }
  }

  /**
   * 🔄 CIRCLE EVENTS: Handle circle-specific notifications
   */
  public async notifyCircleEvent(
    circleId: string,
    memberPhoneNumbers: string[],
    type: NotificationType,
    data: Record<string, unknown>
  ): Promise<void> {
    logger.info(`Sending circle event notification: ${type} to ${memberPhoneNumbers.length} members`);

    const promises = memberPhoneNumbers.map(phoneNumber => 
      this.sendImmediateNotification(phoneNumber, type, { ...data, circleId })
    );

    const results = await Promise.allSettled(promises);
    const successful = results.filter(r => r.status === 'fulfilled' && r.value).length;
    
    logger.info(`Circle event notification ${type}: ${successful}/${memberPhoneNumbers.length} delivered`);
  }

  /**
   * ⏰ SCHEDULE REMINDERS: Set up recurring reminders
   */
  public scheduleContributionReminders(
    phoneNumber: string,
    circleId: string,
    contributionAmount: number,
    currency: string,
    dueDate: Date
  ): string[] {
    const notificationIds: string[] = [];

    // 3 days before
    const threeDaysBefore = new Date(dueDate.getTime() - 3 * 24 * 60 * 60 * 1000);
    if (threeDaysBefore > new Date()) {
      notificationIds.push(
        this.scheduleNotification(phoneNumber, 'contribution_reminder', threeDaysBefore, {
          circleId,
          contributionAmount,
          currency,
          daysRemaining: 3,
          dueDate: dueDate.toISOString()
        })
      );
    }

    // 1 day before
    const oneDayBefore = new Date(dueDate.getTime() - 24 * 60 * 60 * 1000);
    if (oneDayBefore > new Date()) {
      notificationIds.push(
        this.scheduleNotification(phoneNumber, 'contribution_reminder', oneDayBefore, {
          circleId,
          contributionAmount,
          currency,
          daysRemaining: 1,
          dueDate: dueDate.toISOString()
        })
      );
    }

    // Day of (morning reminder)
    const dayOfMorning = new Date(dueDate);
    dayOfMorning.setHours(9, 0, 0, 0); // 9 AM on due date
    if (dayOfMorning > new Date()) {
      notificationIds.push(
        this.scheduleNotification(phoneNumber, 'contribution_reminder', dayOfMorning, {
          circleId,
          contributionAmount,
          currency,
          daysRemaining: 0,
          dueDate: dueDate.toISOString(),
          urgent: true
        })
      );
    }

    logger.info(`Scheduled ${notificationIds.length} contribution reminders for ${phoneNumber}`);
    return notificationIds;
  }

  /**
   * 🎯 YIELD UPDATES: Schedule yield notification
   */
  public scheduleYieldUpdate(
    phoneNumber: string,
    circleId: string,
    yieldAmount: number,
    yieldPercentage: number,
    period: string
  ): string {
    // Schedule for next day at 10 AM
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(10, 0, 0, 0);

    return this.scheduleNotification(phoneNumber, 'yield_update', tomorrow, {
      circleId,
      yieldAmount,
      yieldPercentage,
      period,
      currency: 'USDC'
    });
  }

  /**
   * 🔄 ROTATION ALERTS: Schedule rotation notifications
   */
  public scheduleRotationAlert(
    phoneNumber: string,
    circleId: string,
    recipientName: string,
    rotationDate: Date,
    totalAmount: number
  ): string {
    // Schedule 1 hour before rotation
    const alertTime = new Date(rotationDate.getTime() - 60 * 60 * 1000);

    return this.scheduleNotification(phoneNumber, 'rotation_alert', alertTime, {
      circleId,
      recipientName,
      rotationDate: rotationDate.toISOString(),
      totalAmount,
      currency: 'USDC'
    });
  }

  /**
   * 🤖 AUTOMATION: Schedule progressive payout warnings
   */
  public scheduleProgressivePayoutWarnings(
    phoneNumber: string,
    circleId: string,
    payoutTime: Date,
    contributionAmount: number,
    currency: string = 'USDC',
    allMembersContributed: boolean = false
  ): string[] {
    const notificationIds: string[] = [];
    const now = new Date();

    // Calculate time remaining
    const timeUntilPayout = payoutTime.getTime() - now.getTime();
    const hoursUntilPayout = timeUntilPayout / (1000 * 60 * 60);

    // 24 hour warning
    const warning24h = new Date(payoutTime.getTime() - 24 * 60 * 60 * 1000);
    if (warning24h > now && hoursUntilPayout > 24) {
      notificationIds.push(
        this.scheduleNotification(phoneNumber, 'payout_warning_24h', warning24h, {
          circleId,
          contributionAmount,
          currency,
          timeRemaining: '24 hours',
          allMembersContributed,
          warningLevel: 1
        })
      );
    }

    // 6 hour warning
    const warning6h = new Date(payoutTime.getTime() - 6 * 60 * 60 * 1000);
    if (warning6h > now && hoursUntilPayout > 6) {
      notificationIds.push(
        this.scheduleNotification(phoneNumber, 'payout_warning_6h', warning6h, {
          circleId,
          contributionAmount,
          currency,
          timeRemaining: '6 hours',
          allMembersContributed,
          warningLevel: 2
        })
      );
    }

    // 1 hour warning
    const warning1h = new Date(payoutTime.getTime() - 60 * 60 * 1000);
    if (warning1h > now && hoursUntilPayout > 1) {
      notificationIds.push(
        this.scheduleNotification(phoneNumber, 'payout_warning_1h', warning1h, {
          circleId,
          contributionAmount,
          currency,
          timeRemaining: '1 hour',
          allMembersContributed,
          warningLevel: 3
        })
      );
    }

    logger.info(`Scheduled ${notificationIds.length} progressive payout warnings for circle ${circleId} to ${phoneNumber}`);
    return notificationIds;
  }

  /**
   * 🤖 AUTOMATION: Send immediate payout warning based on warning level
   */
  public async sendPayoutWarning(
    phoneNumber: string,
    circleId: string,
    warningLevel: number,
    data: Record<string, unknown>
  ): Promise<boolean> {
    let notificationType: NotificationType;

    switch (warningLevel) {
      case 1:
        notificationType = 'payout_warning_24h';
        break;
      case 2:
        notificationType = 'payout_warning_6h';
        break;
      case 3:
        notificationType = 'payout_warning_1h';
        break;
      default:
        logger.warn(`Invalid warning level ${warningLevel} for circle ${circleId}`);
        return false;
    }

    return await this.sendImmediateNotification(phoneNumber, notificationType, {
      ...data,
      circleId,
      warningLevel
    });
  }

  /**
   * 🤖 AUTOMATION: Send automated payout success notification
   */
  public async sendAutomatedPayoutSuccess(
    phoneNumber: string,
    circleId: string,
    payoutAmount: number,
    currency: string,
    recipientAddress: string,
    transactionHash?: string
  ): Promise<boolean> {
    return await this.sendImmediateNotification(phoneNumber, 'automated_payout_success', {
      circleId,
      payoutAmount,
      currency,
      recipientAddress,
      transactionHash,
      isAutomated: true
    });
  }

  /**
   * 🤖 AUTOMATION: Send automation failure notification
   */
  public async sendAutomationFailure(
    phoneNumber: string,
    circleId: string,
    errorType: string,
    errorDetails: string,
    retryCount: number,
    maxRetries: number
  ): Promise<boolean> {
    return await this.sendImmediateNotification(phoneNumber, 'automation_failed', {
      circleId,
      errorType,
      errorDetails,
      retryCount,
      maxRetries,
      isAutomated: true
    });
  }

  /**
   * 🗑️ CANCEL: Cancel scheduled notification
   */
  public cancelNotification(notificationId: string): boolean {
    const deleted = this.scheduledNotifications.delete(notificationId);
    if (deleted) {
      logger.info(`Cancelled notification: ${notificationId}`);
    }
    return deleted;
  }

  /**
   * 🗑️ CANCEL ALL: Cancel all notifications for a phone number
   */
  public cancelAllNotifications(phoneNumber: string): number {
    let cancelledCount = 0;
    
    for (const [id, notification] of this.scheduledNotifications.entries()) {
      if (notification.phoneNumber === phoneNumber) {
        this.scheduledNotifications.delete(id);
        cancelledCount++;
      }
    }

    logger.info(`Cancelled ${cancelledCount} notifications for ${phoneNumber}`);
    return cancelledCount;
  }

  // ===========================================
  // PRIVATE METHODS
  // ===========================================

  /**
   * Process scheduled notifications
   */
  private async processScheduledNotifications(): Promise<void> {
    const now = new Date();
    const dueNotifications: ScheduledNotification[] = [];

    // Find notifications that are due
    for (const notification of this.scheduledNotifications.values()) {
      if (notification.scheduledFor <= now) {
        dueNotifications.push(notification);
      }
    }

    if (dueNotifications.length === 0) {
      return;
    }

    logger.info(`Processing ${dueNotifications.length} due notifications`);

    // Process each notification
    for (const notification of dueNotifications) {
      await this.processNotification(notification);
    }
  }

  /**
   * Process individual notification
   */
  private async processNotification(notification: ScheduledNotification): Promise<void> {
    try {
      const success = await this.sendImmediateNotification(
        notification.phoneNumber,
        notification.type,
        notification.data,
        notification.templateName
      );

      if (success) {
        // Remove successful notification
        this.scheduledNotifications.delete(notification.id);
        logger.info(`Notification processed successfully: ${notification.id}`);
      } else {
        // Handle retry logic
        await this.handleNotificationRetry(notification);
      }

    } catch (error) {
      logger.error(`Error processing notification ${notification.id}:`, error);
      await this.handleNotificationRetry(notification);
    }
  }

  /**
   * Handle notification retry logic
   */
  private async handleNotificationRetry(notification: ScheduledNotification): Promise<void> {
    notification.retryCount++;

    if (notification.retryCount >= notification.maxRetries) {
      // Max retries reached, remove notification
      this.scheduledNotifications.delete(notification.id);
      logger.warn(`Notification ${notification.id} failed after ${notification.maxRetries} attempts`);
    } else {
      // Schedule retry with exponential backoff
      const retryDelay = Math.pow(2, notification.retryCount) * 60 * 1000; // 2^n minutes
      notification.scheduledFor = new Date(Date.now() + retryDelay);
      
      logger.info(`Notification ${notification.id} scheduled for retry ${notification.retryCount}/${notification.maxRetries} in ${retryDelay/1000/60} minutes`);
    }
  }

  /**
   * Cleanup expired notifications
   */
  private cleanupExpiredNotifications(): void {
    const now = new Date();
    const expiredThreshold = new Date(now.getTime() - 24 * 60 * 60 * 1000); // 24 hours ago
    let cleanedCount = 0;

    for (const [id, notification] of this.scheduledNotifications.entries()) {
      if (notification.createdAt < expiredThreshold && notification.retryCount >= notification.maxRetries) {
        this.scheduledNotifications.delete(id);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      logger.info(`Cleaned up ${cleanedCount} expired notifications`);
    }
  }

  /**
   * Get notification template
   */
  private getNotificationTemplate(type: NotificationType): NotificationTemplate {
    const templates: Record<NotificationType, NotificationTemplate> = {
      contribution_reminder: {
        type: 'contribution_reminder',
        message: (data) => {
          const { contributionAmount, currency, daysRemaining, urgent } = data;
          const urgentText = urgent ? '⚠️ **URGENT** ' : '';
          const dayText = daysRemaining === 0 ? 'today' : 
                        daysRemaining === 1 ? 'tomorrow' : 
                        `in ${daysRemaining} days`;
          
          return `${urgentText}💰 **Contribution Reminder**\n\n` +
            `Your contribution of ${contributionAmount} ${currency} is due ${dayText}.\n\n` +
            `Send /contribute ${contributionAmount} ${currency} to make your payment.\n\n` +
            `Questions? Send /help or /status for more info.`;
        },
        requiresAuth: true,
        priority: 'high',
        maxRetries: 3
      },

      rotation_alert: {
        type: 'rotation_alert',
        message: (data) => {
          const { recipientName, totalAmount, currency } = data;
          return `🎉 **Rotation Alert**\n\n` +
            `It's ${recipientName}'s turn to receive the pot!\n\n` +
            `💰 Amount: ${totalAmount} ${currency}\n` +
            `⏰ Happening soon\n\n` +
            `The funds will be distributed automatically. Check /status for updates.`;
        },
        requiresAuth: true,
        priority: 'high',
        maxRetries: 2
      },

      yield_update: {
        type: 'yield_update',
        message: (data) => {
          const { yieldAmount, yieldPercentage, period, currency } = data;
          return `📈 **Yield Update**\n\n` +
            `Your circle earned ${yieldAmount} ${currency} (${yieldPercentage}%) ${period}!\n\n` +
            `🌱 DeFi yield is automatically compounded\n` +
            `📊 Check /status for detailed breakdown\n\n` +
            `Keep contributing to maximize returns! 🚀`;
        },
        requiresAuth: true,
        priority: 'medium',
        maxRetries: 2
      },

      circle_invitation: {
        type: 'circle_invitation',
        message: (data) => {
          const { circleName, inviterName } = data;
          return `👥 **Circle Invitation**\n\n` +
            `${inviterName} invited you to join "${circleName}"!\n\n` +
            `🚀 Start saving together with automated rotations\n` +
            `💰 Earn DeFi yield on pooled funds\n` +
            `🔒 Secure blockchain technology\n\n` +
            `Ready to join? Send /auth to get started!`;
        },
        requiresAuth: false,
        priority: 'medium',
        maxRetries: 2
      },

      payment_confirmation: {
        type: 'payment_confirmation',
        message: (data) => {
          const { amount, currency, type, transactionHash } = data;
          const paymentType = type === 'deposit' ? 'Security Deposit' : 'Contribution';
          const hashString = String(transactionHash || '');
          const displayHash = hashString.length > 16 
            ? `${hashString.slice(0, 8)}...${hashString.slice(-8)}`
            : hashString;
          
          return `✅ **Payment Confirmed**\n\n` +
            `${paymentType}: ${amount} ${currency}\n` +
            `Transaction: ${displayHash}\n\n` +
            `Your payment has been recorded on the blockchain.\n\n` +
            `Send /status to view your updated circle information.`;
        },
        requiresAuth: true,
        priority: 'high',
        maxRetries: 3
      },

      cycle_completion: {
        type: 'cycle_completion',
        message: (data) => {
          const { cycleName, totalContributions, yieldEarned } = data;
          return `🎊 **Cycle Complete!**\n\n` +
            `"${cycleName}" cycle has finished successfully!\n\n` +
            `📊 Total Contributions: ${totalContributions}\n` +
            `🌱 Yield Earned: ${yieldEarned}\n\n` +
            `Ready for the next cycle? Your circle admin will set up the next rotation.\n\n` +
            `Send /circles to view all your circles.`;
        },
        requiresAuth: true,
        priority: 'medium',
        maxRetries: 2
      },

      deposit_required: {
        type: 'deposit_required',
        message: (data) => {
          const { depositAmount, currency, circleName } = data;
          return `🔐 **Security Deposit Required**\n\n` +
            `To complete joining "${circleName}", please pay your security deposit:\n\n` +
            `💰 Amount: ${depositAmount} ${currency}\n` +
            `🔒 Fully refundable when leaving in good standing\n\n` +
            `Send /contribute ${depositAmount} ${currency} to pay your deposit.\n\n` +
            `Questions? Send /help for assistance.`;
        },
        requiresAuth: true,
        priority: 'high',
        maxRetries: 3
      },

      member_joined: {
        type: 'member_joined',
        message: (data) => {
          const { memberName, circleName, currentMembers, maxMembers } = data;
          return `👋 **New Member Joined**\n\n` +
            `${memberName} just joined "${circleName}"!\n\n` +
            `👥 Members: ${currentMembers}/${maxMembers}\n\n` +
            `Welcome to the circle! 🎉`;
        },
        requiresAuth: true,
        priority: 'low',
        maxRetries: 1
      },

      admin_alert: {
        type: 'admin_alert',
        message: (data) => {
          const { alertType, circleName, details } = data;
          return `⚠️ **Admin Alert**\n\n` +
            `${alertType} in "${circleName}"\n\n` +
            `Details: ${details}\n\n` +
            `Please review and take action if needed.\n\n` +
            `Send /status for more information.`;
        },
        requiresAuth: true,
        priority: 'high',
        maxRetries: 3
      },

      // Automation-specific notification templates
      payout_warning_24h: {
        type: 'payout_warning_24h',
        message: (data) => {
          const { circleId, contributionAmount, currency, timeRemaining, allMembersContributed } = data;
          const contributionStatus = allMembersContributed ? 
            '✅ All members have contributed!' : 
            '⏰ Still waiting for some contributions';
          
          return `📅 **24 Hour Payout Notice**\n\n` +
            `Your Njangi circle payout is scheduled in 24 hours!\n\n` +
            `🏦 Circle: ${circleId}\n` +
            `💰 Expected Amount: ${contributionAmount} ${currency}\n` +
            `⏱️ Time Remaining: ${timeRemaining}\n\n` +
            `${contributionStatus}\n\n` +
            `The payout will be processed automatically when the deadline arrives. ` +
            `Make sure all contributions are complete!\n\n` +
            `Send /status for current details.`;
        },
        requiresAuth: true,
        priority: 'medium',
        maxRetries: 2
      },

      payout_warning_6h: {
        type: 'payout_warning_6h',
        message: (data) => {
          const { circleId, contributionAmount, currency, timeRemaining, allMembersContributed } = data;
          const urgencyMessage = allMembersContributed ? 
            '🎉 All set! Payout will process automatically.' : 
            '⚠️ URGENT: Missing contributions may delay payout!';
          
          return `⏰ **6 Hour Payout Warning**\n\n` +
            `Your Njangi circle payout is coming up soon!\n\n` +
            `🏦 Circle: ${circleId}\n` +
            `💰 Amount: ${contributionAmount} ${currency}\n` +
            `⏱️ Time Left: ${timeRemaining}\n\n` +
            `${urgencyMessage}\n\n` +
            `Automated payout will trigger when the deadline arrives. ` +
            `Contact your circle admin if you have concerns.\n\n` +
            `Send /status to check contribution status.`;
        },
        requiresAuth: true,
        priority: 'high',
        maxRetries: 3
      },

      payout_warning_1h: {
        type: 'payout_warning_1h',
        message: (data) => {
          const { circleId, contributionAmount, currency, timeRemaining, allMembersContributed } = data;
          const finalWarning = allMembersContributed ? 
            '✅ All contributions complete - payout ready!' : 
            '🚨 FINAL WARNING: Incomplete contributions detected!';
          
          return `🚨 **FINAL HOUR - Payout Imminent**\n\n` +
            `Your Njangi circle payout is in the final hour!\n\n` +
            `🏦 Circle: ${circleId}\n` +
            `💰 Amount: ${contributionAmount} ${currency}\n` +
            `⏱️ Time Left: ${timeRemaining}\n\n` +
            `${finalWarning}\n\n` +
            `🤖 Automated payout will execute at the deadline regardless of contribution status. ` +
            `This is your last chance to make any needed contributions.\n\n` +
            `Send /status for immediate status check.`;
        },
        requiresAuth: true,
        priority: 'high',
        maxRetries: 3
      },

      automated_payout_success: {
        type: 'automated_payout_success',
        message: (data) => {
          const { circleId, payoutAmount, currency, recipientAddress, transactionHash } = data;
          const hashString = String(transactionHash || '');
          const displayHash = hashString ? `${hashString.substring(0, 8)}...` : 'Processing';
          
          return `🎉 **Automated Payout Complete!**\n\n` +
            `Your Njangi circle payout has been successfully processed!\n\n` +
            `🏦 Circle: ${circleId}\n` +
            `💰 Amount: ${payoutAmount} ${currency}\n` +
            `📍 Recipient: ${recipientAddress}\n` +
            `🔗 Transaction: ${displayHash}\n\n` +
            `🤖 This payout was automatically triggered by our smart contract system. ` +
            `Funds have been distributed according to your circle's rotation schedule.\n\n` +
            `Send /circles to view your updated circle status.`;
        },
        requiresAuth: true,
        priority: 'high',
        maxRetries: 2
      },

      automation_failed: {
        type: 'automation_failed',
        message: (data) => {
          const { circleId, errorType, errorDetails, retryCount, maxRetries } = data;
          const retryCountNum = Number(retryCount) || 0;
          const maxRetriesNum = Number(maxRetries) || 3;
          const retryMessage = retryCountNum < maxRetriesNum ? 
            `⏳ Retry ${retryCountNum}/${maxRetriesNum} will be attempted automatically.` :
            `❌ Max retries reached. Manual intervention required.`;
          
          return `🚨 **Automation Failure Alert**\n\n` +
            `An automated process failed for your circle:\n\n` +
            `🏦 Circle: ${circleId}\n` +
            `❌ Error: ${errorType}\n` +
            `📋 Details: ${errorDetails}\n\n` +
            `${retryMessage}\n\n` +
            `If this issue persists, please contact your circle admin or support team. ` +
            `Your funds remain secure on the blockchain.\n\n` +
            `Send /status to check current circle status.`;
        },
        requiresAuth: true,
        priority: 'high',
        maxRetries: 2
      }
    };

    return templates[type];
  }

  /**
   * Extract template parameters for WhatsApp templates
   */
  private extractTemplateParameters(data: Record<string, unknown>): Array<{ type: 'text'; text: string }> {
    // Convert data to template parameters
    const params: Array<{ type: 'text'; text: string }> = [];
    
    // Add common parameters
    if (data.contributionAmount) {
      params.push({ type: 'text', text: String(data.contributionAmount) });
    }
    if (data.currency) {
      params.push({ type: 'text', text: String(data.currency) });
    }
    if (data.circleName) {
      params.push({ type: 'text', text: String(data.circleName) });
    }

    return params;
  }

  /**
   * Generate unique notification ID
   */
  private generateNotificationId(): string {
    return `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Get service statistics
   */
  public getStats(): {
    scheduledNotifications: number;
    notificationsByType: Record<string, number>;
    uptime: number;
    processingInterval: number;
  } {
    const notificationsByType: Record<string, number> = {};
    
    for (const notification of this.scheduledNotifications.values()) {
      notificationsByType[notification.type] = (notificationsByType[notification.type] || 0) + 1;
    }

    return {
      scheduledNotifications: this.scheduledNotifications.size,
      notificationsByType,
      uptime: process.uptime(),
      processingInterval: this.PROCESSING_INTERVAL
    };
  }

  /**
   * Cleanup on service shutdown
   */
  public shutdown(): void {
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = null;
    }
    logger.info('WhatsApp Notification Service shut down');
  }
}

// Export singleton instance
export const whatsappNotificationService = WhatsAppNotificationService.getInstance(); 