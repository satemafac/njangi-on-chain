/**
 * WhatsApp Command Handler Service
 * Handles user commands and generates appropriate WhatsApp responses
 * Provides help, circle status, rotation info, and cycle details
 */

import { SuiClient } from '@mysten/sui/client';
import { appLogger } from '../utils/logger';
import { getConfig } from '../config';
import { whatsappSender, WhatsAppTemplate } from './whatsapp-sender.service';

// ============================================================================
// TYPES & INTERFACES
// ============================================================================

export interface CircleStatusData {
  circleId: string;
  circleName?: string;
  currentCycle: number;
  currentBeneficiary?: string;
  nextPayoutTime?: number;
  totalMembers?: number;
  membersContributedThisCycle?: number;
  rotationPosition?: number;
  isActive?: boolean;
}

// ============================================================================
// WHATSAPP COMMAND HANDLER SERVICE
// ============================================================================

export class WhatsAppCommandHandlerService {
  private suiClient: SuiClient;

  constructor() {
    const config = getConfig();
    this.suiClient = new SuiClient({ url: config.sui.testnetRpcUrl });
  }

  /**
   * Send help message with available commands and features
   */
  public async sendHelpMessage(phoneNumber: string): Promise<boolean> {
    try {
      const helpText = `
📱 *Njangi WhatsApp Bot*

You will receive automated updates about your circles:

✅ *Notifications you'll receive:*
• 🔄 New cycle started
• 💰 Member contributions
• ⏰ Deadline reminders
• 💸 Payout notifications
• 👥 Rotation status updates
• ⚠️ Important alerts

🔗 *View your circle:*
Open the link in any message to see full details and manage your circle on our app.

*Commands:*
/status - Circle status & rotation
/cycle - Current cycle details
/members - Circle members
/help - Show this message

Type or reply OK to confirm you understand.
      `.trim();

      const result = await whatsappSender.sendMessage({
        to: phoneNumber,
        type: 'text',
        text: helpText,
      });

      if (result.success) {
        appLogger.info('Help message sent', {
          phoneNumber,
          messageId: result.messageId,
        });
        return true;
      } else {
        appLogger.error('Failed to send help message', {
          phoneNumber,
          error: result.error,
        });
        return false;
      }
    } catch (error) {
      appLogger.error('Error sending help message', {
        phoneNumber,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Send a notification for cycle started
   */
  public async sendCycleStartedNotification(
    phoneNumber: string,
    circleId: string,
    circleName: string,
    cycleNumber: number
  ): Promise<boolean> {
    try {
      const result = await whatsappSender.sendMessage({
        to: phoneNumber,
        type: 'text',
        text: `🔄 *Cycle #${cycleNumber} Started*\n\nYour circle "${circleName}" has started a new cycle!\n\nView details: https://njangionchain.com/circle/${circleId}`,
      });

      if (result.success) {
        appLogger.info('Cycle started notification sent', {
          phoneNumber,
          circleId,
          cycleNumber,
        });
        return true;
      } else {
        throw new Error(result.error || 'Failed to send');
      }
    } catch (error) {
      appLogger.error('Error sending cycle started notification', {
        phoneNumber,
        circleId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Send a notification for member contribution
   */
  public async sendContributionNotification(
    phoneNumber: string,
    circleId: string,
    circleName: string,
    memberName: string,
    contributionAmount: string,
    totalContributed: string,
    targetAmount: string
  ): Promise<boolean> {
    try {
      const progressPercent = Math.round(
        (parseFloat(totalContributed) / parseFloat(targetAmount)) * 100
      );

      const result = await whatsappSender.sendMessage({
        to: phoneNumber,
        type: 'text',
        text: `💰 *New Contribution Received*\n\n${memberName} contributed ${contributionAmount} to "${circleName}"\n\n📊 Cycle Progress: ${progressPercent}% (${totalContributed}/${targetAmount})`,
      });

      if (result.success) {
        appLogger.info('Contribution notification sent', {
          phoneNumber,
          circleId,
          memberName,
        });
        return true;
      } else {
        throw new Error(result.error || 'Failed to send');
      }
    } catch (error) {
      appLogger.error('Error sending contribution notification', {
        phoneNumber,
        circleId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Send a deadline reminder notification
   */
  public async sendDeadlineReminderNotification(
    phoneNumber: string,
    circleId: string,
    circleName: string,
    hoursRemaining: number,
    targetAmount: string
  ): Promise<boolean> {
    try {
      const timeText =
        hoursRemaining < 1
          ? 'Few minutes remaining'
          : `${hoursRemaining} hours remaining`;

      const result = await whatsappSender.sendMessage({
        to: phoneNumber,
        type: 'text',
        text: `⏰ *Contribution Deadline Reminder*\n\n"${circleName}" contribution deadline:\n\n${timeText}\n\nTarget: ${targetAmount}\n\nView circle: https://njangionchain.com/circle/${circleId}`,
      });

      if (result.success) {
        appLogger.info('Deadline reminder sent', {
          phoneNumber,
          circleId,
          hoursRemaining,
        });
        return true;
      } else {
        throw new Error(result.error || 'Failed to send');
      }
    } catch (error) {
      appLogger.error('Error sending deadline reminder', {
        phoneNumber,
        circleId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Send a payout notification
   */
  public async sendPayoutNotification(
    phoneNumber: string,
    circleId: string,
    circleName: string,
    beneficiary: string,
    payoutAmount: string,
    payoutDate: string
  ): Promise<boolean> {
    try {
      const result = await whatsappSender.sendMessage({
        to: phoneNumber,
        type: 'text',
        text: `💸 *Payout Processed*\n\n"${circleName}" - Cycle Payout\n\n👤 Beneficiary: ${beneficiary}\n💰 Amount: ${payoutAmount}\n📅 Date: ${payoutDate}\n\nView details: https://njangionchain.com/circle/${circleId}`,
      });

      if (result.success) {
        appLogger.info('Payout notification sent', {
          phoneNumber,
          circleId,
          beneficiary,
        });
        return true;
      } else {
        throw new Error(result.error || 'Failed to send');
      }
    } catch (error) {
      appLogger.error('Error sending payout notification', {
        phoneNumber,
        circleId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Send rotation status update (who is current beneficiary, cycle progression)
   */
  public async sendRotationStatusUpdate(
    phoneNumber: string,
    circleId: string,
    circleName: string,
    currentBeneficiary: string,
    currentPosition: number,
    totalMembers: number,
    cycleNumber: number
  ): Promise<boolean> {
    try {
      const positionText = `Position ${currentPosition + 1} of ${totalMembers}`;

      const result = await whatsappSender.sendMessage({
        to: phoneNumber,
        type: 'text',
        text: `🔄 *Rotation Status Update*\n\n"${circleName}" - Cycle #${cycleNumber}\n\n👑 Current Beneficiary:\n${currentBeneficiary}\n\n📊 Rotation: ${positionText}\n\nView full details: https://njangionchain.com/circle/${circleId}`,
      });

      if (result.success) {
        appLogger.info('Rotation status update sent', {
          phoneNumber,
          circleId,
          currentPosition,
        });
        return true;
      } else {
        throw new Error(result.error || 'Failed to send');
      }
    } catch (error) {
      appLogger.error('Error sending rotation status update', {
        phoneNumber,
        circleId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Send member joined notification
   */
  public async sendMemberJoinedNotification(
    phoneNumber: string,
    circleId: string,
    circleName: string,
    newMemberName: string,
    totalMembers: number,
    maxMembers: number
  ): Promise<boolean> {
    try {
      const capacityText = `${totalMembers}/${maxMembers} members`;

      const result = await whatsappSender.sendMessage({
        to: phoneNumber,
        type: 'text',
        text: `👥 *New Member Joined*\n\n"${circleName}"\n\n✨ ${newMemberName} has joined!\n\n📈 Circle Size: ${capacityText}\n\nView circle: https://njangionchain.com/circle/${circleId}`,
      });

      if (result.success) {
        appLogger.info('Member joined notification sent', {
          phoneNumber,
          circleId,
          newMemberName,
        });
        return true;
      } else {
        throw new Error(result.error || 'Failed to send');
      }
    } catch (error) {
      appLogger.error('Error sending member joined notification', {
        phoneNumber,
        circleId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Send important alert/warning notification
   */
  public async sendAlertNotification(
    phoneNumber: string,
    circleId: string,
    circleName: string,
    alertTitle: string,
    alertMessage: string,
    severity: 'info' | 'warning' | 'critical'
  ): Promise<boolean> {
    try {
      const emoji =
        severity === 'critical'
          ? '🚨'
          : severity === 'warning'
            ? '⚠️'
            : 'ℹ️';

      const result = await whatsappSender.sendMessage({
        to: phoneNumber,
        type: 'text',
        text: `${emoji} *${alertTitle}*\n\n"${circleName}"\n\n${alertMessage}\n\nView circle: https://njangionchain.com/circle/${circleId}`,
      });

      if (result.success) {
        appLogger.info('Alert notification sent', {
          phoneNumber,
          circleId,
          alertTitle,
          severity,
        });
        return true;
      } else {
        throw new Error(result.error || 'Failed to send');
      }
    } catch (error) {
      appLogger.error('Error sending alert notification', {
        phoneNumber,
        circleId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Send generic message
   */
  public async sendGenericMessage(
    phoneNumber: string,
    title: string,
    message: string,
    emoji: string = '📢'
  ): Promise<boolean> {
    try {
      const result = await whatsappSender.sendMessage({
        to: phoneNumber,
        type: 'text',
        text: `${emoji} *${title}*\n\n${message}`,
      });

      if (result.success) {
        appLogger.info('Generic message sent', {
          phoneNumber,
          title,
        });
        return true;
      } else {
        throw new Error(result.error || 'Failed to send');
      }
    } catch (error) {
      appLogger.error('Error sending generic message', {
        phoneNumber,
        title,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }
}

export const whatsappCommandHandler = new WhatsAppCommandHandlerService();

