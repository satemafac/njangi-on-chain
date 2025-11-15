/**
 * API Endpoint for Sending Command Responses
 * Handles various notification types:
 * - /help - Show help message
 * - /status - Circle status & rotation
 * - /cycle - Current cycle details
 * - /members - Circle members
 * - cycle_started - New cycle notification
 * - contribution - Member contribution
 * - deadline - Deadline reminder
 * - payout - Payout notification
 * - rotation - Rotation status update
 * - member_joined - New member alert
 * - alert - General alert/warning
 */

import { NextApiRequest, NextApiResponse } from 'next';
import { whatsappCommandHandler } from '../../../services/whatsapp-command-handler.service';
import { appLogger } from '../../../utils/logger';

interface SendCommandResponse {
  success: boolean;
  message?: string;
  messageId?: string;
  error?: string;
  timestamp: string;
}

async function handler(
  req: NextApiRequest,
  res: NextApiResponse<SendCommandResponse>
) {
  const timestamp = new Date().toISOString();

  // Only accept POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({
      success: false,
      error: 'Method not allowed',
      timestamp,
    });
  }

  try {
    const { phoneNumber, commandType, circleId, circleName, data } = req.body;

    // Validate required fields
    if (!phoneNumber || !commandType) {
      appLogger.warn('Missing required fields in command response request', {
        phoneNumber,
        commandType,
      });
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: phoneNumber, commandType',
        timestamp,
      });
    }

    appLogger.info('Processing command response', {
      phoneNumber: phoneNumber.slice(0, 10),
      commandType,
      circleId: circleId?.slice(0, 10),
    });

    let result = false;

    switch (commandType) {
      case 'help':
        result = await whatsappCommandHandler.sendHelpMessage(phoneNumber);
        break;

      case 'cycle_started':
        if (!circleName || !data?.cycleNumber) {
          return res.status(400).json({
            success: false,
            error:
              'cycle_started requires circleName and data.cycleNumber',
            timestamp,
          });
        }
        result = await whatsappCommandHandler.sendCycleStartedNotification(
          phoneNumber,
          circleId,
          circleName,
          data.cycleNumber
        );
        break;

      case 'contribution':
        if (!circleName || !data?.memberName) {
          return res.status(400).json({
            success: false,
            error:
              'contribution requires circleName and data.memberName',
            timestamp,
          });
        }
        result = await whatsappCommandHandler.sendContributionNotification(
          phoneNumber,
          circleId,
          circleName,
          data.memberName,
          data.contributionAmount || 'N/A',
          data.totalContributed || '0',
          data.targetAmount || '0'
        );
        break;

      case 'deadline':
        if (!circleName) {
          return res.status(400).json({
            success: false,
            error: 'deadline requires circleName',
            timestamp,
          });
        }
        result = await whatsappCommandHandler.sendDeadlineReminderNotification(
          phoneNumber,
          circleId,
          circleName,
          data?.hoursRemaining || 24,
          data?.targetAmount || 'N/A'
        );
        break;

      case 'payout':
        if (!circleName || !data?.beneficiary) {
          return res.status(400).json({
            success: false,
            error: 'payout requires circleName and data.beneficiary',
            timestamp,
          });
        }
        result = await whatsappCommandHandler.sendPayoutNotification(
          phoneNumber,
          circleId,
          circleName,
          data.beneficiary,
          data.payoutAmount || 'N/A',
          data.payoutDate || new Date().toISOString().split('T')[0]
        );
        break;

      case 'rotation':
        if (!circleName || data?.currentPosition === undefined) {
          return res.status(400).json({
            success: false,
            error:
              'rotation requires circleName and data.currentPosition',
            timestamp,
          });
        }
        result = await whatsappCommandHandler.sendRotationStatusUpdate(
          phoneNumber,
          circleId,
          circleName,
          data.currentBeneficiary || 'TBD',
          data.currentPosition,
          data.totalMembers || 0,
          data.cycleNumber || 1
        );
        break;

      case 'member_joined':
        if (!circleName || !data?.newMemberName) {
          return res.status(400).json({
            success: false,
            error:
              'member_joined requires circleName and data.newMemberName',
            timestamp,
          });
        }
        result = await whatsappCommandHandler.sendMemberJoinedNotification(
          phoneNumber,
          circleId,
          circleName,
          data.newMemberName,
          data.totalMembers || 0,
          data.maxMembers || 0
        );
        break;

      case 'alert':
        if (!data?.alertTitle || !data?.alertMessage) {
          return res.status(400).json({
            success: false,
            error:
              'alert requires data.alertTitle and data.alertMessage',
            timestamp,
          });
        }
        result = await whatsappCommandHandler.sendAlertNotification(
          phoneNumber,
          circleId || '',
          circleName || 'Njangi',
          data.alertTitle,
          data.alertMessage,
          data.severity || 'info'
        );
        break;

      case 'generic':
        if (!data?.title || !data?.message) {
          return res.status(400).json({
            success: false,
            error: 'generic requires data.title and data.message',
            timestamp,
          });
        }
        result = await whatsappCommandHandler.sendGenericMessage(
          phoneNumber,
          data.title,
          data.message,
          data.emoji || '📢'
        );
        break;

      default:
        appLogger.warn('Unknown command type', { commandType });
        return res.status(400).json({
          success: false,
          error: `Unknown command type: ${commandType}`,
          timestamp,
        });
    }

    if (result) {
      appLogger.info('Command response sent successfully', {
        phoneNumber: phoneNumber.slice(0, 10),
        commandType,
      });
      return res.status(200).json({
        success: true,
        message: `${commandType} notification sent successfully`,
        timestamp,
      });
    } else {
      return res.status(500).json({
        success: false,
        error: `Failed to send ${commandType} notification`,
        timestamp,
      });
    }
  } catch (error) {
    appLogger.error('Error in send-command-response endpoint', {
      error: error instanceof Error ? error.message : String(error),
      timestamp,
    });

    return res.status(500).json({
      success: false,
      error:
        error instanceof Error
          ? error.message
          : 'Internal server error',
      timestamp,
    });
  }
}

export default handler;

