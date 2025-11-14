import { whatsappSender } from './whatsapp-sender.service';
import { appLogger } from '../utils/logger';

/**
 * 📱 WhatsApp Notification Handler Service
 * 
 * Sends formatted notifications and updates to users via WhatsApp
 * This is a NOTIFICATION-ONLY channel - no command processing
 */

export interface CircleUpdateNotification {
  type: 'cycle_started' | 'contribution_received' | 'deadline_approaching' | 'payout_ready' | 'member_joined' | 'custom';
  circleId: string;
  circleName?: string;
  data?: Record<string, any>;
  customMessage?: string;
}

export class WhatsAppNotificationHandlerService {
  private static instance: WhatsAppNotificationHandlerService;

  private constructor() {}

  public static getInstance(): WhatsAppNotificationHandlerService {
    if (!WhatsAppNotificationHandlerService.instance) {
      WhatsAppNotificationHandlerService.instance = new WhatsAppNotificationHandlerService();
    }
    return WhatsAppNotificationHandlerService.instance;
  }

  /**
   * Send a circle update notification
   */
  public async sendCircleUpdate(
    phoneNumber: string,
    circleId: string,
    notification: CircleUpdateNotification
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    try {
      const message = this.buildNotificationMessage(notification);

      appLogger.info('Sending circle update notification', {
        to: phoneNumber,
        circleId,
        type: notification.type,
      });

      const result = await whatsappSender.sendMessage({
        to: phoneNumber,
        type: 'text',
        text: message,
      });

      if (result.success) {
        appLogger.info('Circle update notification sent', {
          to: phoneNumber,
          circleId,
          messageId: result.messageId,
        });
      } else {
        appLogger.warn('Failed to send circle update notification', {
          to: phoneNumber,
          error: result.error,
        });
      }

      return result;
    } catch (error) {
      appLogger.error('Error sending circle update notification', {
        error: error instanceof Error ? error.message : String(error),
        phoneNumber,
        circleId,
      });

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Send cycle started notification
   */
  public async notifyCycleStarted(
    phoneNumber: string,
    circleId: string,
    circleName: string,
    cycleNumber: number,
    dueDate: string
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    return this.sendCircleUpdate(phoneNumber, circleId, {
      type: 'cycle_started',
      circleId,
      circleName,
      data: {
        cycleNumber,
        dueDate,
      },
    });
  }

  /**
   * Send contribution received notification
   */
  public async notifyContributionReceived(
    phoneNumber: string,
    circleId: string,
    circleName: string,
    memberName: string,
    amount: string,
    currency: string
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    return this.sendCircleUpdate(phoneNumber, circleId, {
      type: 'contribution_received',
      circleId,
      circleName,
      data: {
        memberName,
        amount,
        currency,
      },
    });
  }

  /**
   * Send deadline approaching notification
   */
  public async notifyDeadlineApproaching(
    phoneNumber: string,
    circleId: string,
    circleName: string,
    hoursRemaining: number
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    return this.sendCircleUpdate(phoneNumber, circleId, {
      type: 'deadline_approaching',
      circleId,
      circleName,
      data: {
        hoursRemaining,
      },
    });
  }

  /**
   * Send payout ready notification
   */
  public async notifyPayoutReady(
    phoneNumber: string,
    circleId: string,
    circleName: string,
    recipientName: string,
    amount: string,
    currency: string
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    return this.sendCircleUpdate(phoneNumber, circleId, {
      type: 'payout_ready',
      circleId,
      circleName,
      data: {
        recipientName,
        amount,
        currency,
      },
    });
  }

  /**
   * Send member joined notification
   */
  public async notifyMemberJoined(
    phoneNumber: string,
    circleId: string,
    circleName: string,
    newMemberName: string
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    return this.sendCircleUpdate(phoneNumber, circleId, {
      type: 'member_joined',
      circleId,
      circleName,
      data: {
        newMemberName,
      },
    });
  }

  /**
   * Send custom notification
   */
  public async sendCustomNotification(
    phoneNumber: string,
    circleId: string,
    circleName: string,
    customMessage: string
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    return this.sendCircleUpdate(phoneNumber, circleId, {
      type: 'custom',
      circleId,
      circleName,
      customMessage,
    });
  }

  /**
   * Build formatted notification message
   */
  private buildNotificationMessage(notification: CircleUpdateNotification): string {
    const { type, circleName, data, customMessage } = notification;

    // Prefix with circle name if available
    const header = circleName ? `📱 *${circleName}*\n\n` : '';

    switch (type) {
      case 'cycle_started':
        return (
          `${header}🔄 *New Cycle Started!*\n\n` +
          `Cycle #${data?.cycleNumber || 'N/A'}\n` +
          `💰 Contributions due by: ${data?.dueDate || 'TBA'}\n\n` +
          `Ready to contribute? 💪`
        );

      case 'contribution_received':
        return (
          `${header}✅ *Contribution Received*\n\n` +
          `From: ${data?.memberName || 'Member'}\n` +
          `Amount: ${data?.amount || '?'} ${data?.currency || 'USD'}\n\n` +
          `Keep the momentum going! 🚀`
        );

      case 'deadline_approaching':
        return (
          `${header}⏰ *Deadline Approaching!*\n\n` +
          `${data?.hoursRemaining || '?'} hours remaining\n\n` +
          `Don't miss this cycle! Submit your contribution now. 🏃`
        );

      case 'payout_ready':
        return (
          `${header}💸 *Payout Ready!*\n\n` +
          `${data?.recipientName || 'Member'} receives: ${data?.amount || '?'} ${data?.currency || 'USD'}\n\n` +
          `Payout is being processed. 🎉`
        );

      case 'member_joined':
        return (
          `${header}👋 *New Member Joined*\n\n` +
          `Welcome to ${data?.newMemberName || 'our new member'}! 🎉\n\n` +
          `We're growing stronger together! 💪`
        );

      case 'custom':
        return customMessage || 'You have a new update from your circle.';

      default:
        return 'You have a new update from your circle.';
    }
  }

  /**
   * Send batch notifications
   */
  public async sendBatchNotifications(
    notifications: Array<{
      phoneNumber: string;
      circleId: string;
      notification: CircleUpdateNotification;
    }>
  ): Promise<Array<{ phoneNumber: string; success: boolean; messageId?: string; error?: string }>> {
    appLogger.info('Sending batch notifications', {
      count: notifications.length,
    });

    const results = await Promise.allSettled(
      notifications.map((n) => this.sendCircleUpdate(n.phoneNumber, n.circleId, n.notification))
    );

    return results.map((result, index) => ({
      phoneNumber: notifications[index].phoneNumber,
      success: result.status === 'fulfilled' ? result.value.success : false,
      messageId: result.status === 'fulfilled' ? result.value.messageId : undefined,
      error: result.status === 'rejected' ? (result.reason as Error).message : undefined,
    }));
  }

  /**
   * Get service statistics
   */
  public getStats(): Record<string, unknown> {
    return {
      initialized: true,
      type: 'notification_handler',
      supportedNotifications: [
        'cycle_started',
        'contribution_received',
        'deadline_approaching',
        'payout_ready',
        'member_joined',
        'custom',
      ],
    };
  }
}

// Export singleton instance
export const whatsappNotificationHandler = WhatsAppNotificationHandlerService.getInstance();

