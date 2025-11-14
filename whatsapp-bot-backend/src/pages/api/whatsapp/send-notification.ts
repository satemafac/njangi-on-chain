import type { NextApiRequest, NextApiResponse } from 'next';
import { appLogger } from '../../../utils/logger';
import { asyncHandler } from '../../../middleware/errorHandler';
import { whatsappNotificationHandler, CircleUpdateNotification } from '../../../services/whatsapp-notification-handler.service';

interface SendNotificationRequest {
  phoneNumber: string;
  circleId: string;
  circleName?: string;
  notificationType: 'cycle_started' | 'contribution_received' | 'deadline_approaching' | 'payout_ready' | 'member_joined' | 'custom';
  data?: Record<string, any>;
  customMessage?: string;
}

interface SendNotificationResponse {
  success: boolean;
  messageId?: string;
  error?: string;
}

/**
 * POST /api/whatsapp/send-notification
 * Send a circle update notification via WhatsApp
 */
export default asyncHandler(async (req: NextApiRequest, res: NextApiResponse<SendNotificationResponse>) => {
  if (req.method !== 'POST') {
    return res.status(405).json({
      success: false,
      error: 'Method not allowed. Use POST.',
    });
  }

  try {
    const {
      phoneNumber,
      circleId,
      circleName,
      notificationType,
      data,
      customMessage,
    } = req.body as SendNotificationRequest;

    // Validate required fields
    if (!phoneNumber) {
      return res.status(400).json({
        success: false,
        error: 'phoneNumber is required',
      });
    }

    if (!circleId) {
      return res.status(400).json({
        success: false,
        error: 'circleId is required',
      });
    }

    if (!notificationType) {
      return res.status(400).json({
        success: false,
        error: 'notificationType is required',
      });
    }

    appLogger.info('Sending WhatsApp notification', {
      phoneNumber,
      circleId,
      notificationType,
    });

    // Build notification object
    const notification: CircleUpdateNotification = {
      type: notificationType,
      circleId,
      circleName,
      data,
      customMessage,
    };

    // Send notification
    const result = await whatsappNotificationHandler.sendCircleUpdate(
      phoneNumber,
      circleId,
      notification
    );

    if (result.success) {
      return res.status(200).json({
        success: true,
        messageId: result.messageId,
      });
    } else {
      return res.status(500).json({
        success: false,
        error: result.error || 'Failed to send notification',
      });
    }
  } catch (error) {
    appLogger.error('Error in send-notification endpoint', {
      error: error instanceof Error ? error.message : String(error),
    });

    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Internal server error',
    });
  }
});

