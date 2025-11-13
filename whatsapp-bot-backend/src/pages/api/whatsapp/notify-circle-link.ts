import { NextApiRequest, NextApiResponse } from 'next';
import { whatsappSender } from '../../../services/whatsapp-sender.service';
import { appLogger } from '../../../utils/logger';

// ============================================================================
// NOTIFY CIRCLE LINK ENDPOINT
// ============================================================================

interface NotifyRequest {
  phoneNumber: string;
  circleId: string;
  adminAddress: string;
  type?: 'confirmation' | 'members'; // confirmation = admin only, members = circle members
}

interface NotifyResponse {
  success: boolean;
  message?: string;
  error?: string;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<NotifyResponse>
) {
  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({
      success: false,
      error: 'Method not allowed. Use POST.',
    });
  }

  try {
    const { phoneNumber, circleId, adminAddress, type = 'confirmation' } = req.body as NotifyRequest;

    // Validate required fields
    if (!phoneNumber || !circleId || !adminAddress) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: phoneNumber, circleId, adminAddress',
      });
    }

    appLogger.info('Sending circle link notification', {
      phoneNumber,
      circleId,
      type,
    });

    if (type === 'confirmation') {
      // Send confirmation to admin
      const confirmationMessage = `✅ *WhatsApp Linked Successfully!*

Your circle has been successfully linked to WhatsApp. You will now receive notifications for:
• New cycle started
• Member contributions
• Deadline reminders  
• Payout notifications

Circle ID: ${circleId.slice(0, 10)}...
Admin: ${adminAddress.slice(0, 10)}...

Type *help* for more information.`;

      const result = await whatsappSender.sendMessage({
        to: phoneNumber,
        type: 'text',
        text: confirmationMessage,
      });

      if (result.success) {
        appLogger.info('Link confirmation sent', {
          phoneNumber,
          messageId: result.messageId,
        });

        return res.status(200).json({
          success: true,
          message: `Confirmation message sent to ${phoneNumber}`,
        });
      } else {
        appLogger.error('Failed to send confirmation', {
          phoneNumber,
          error: result.error,
        });

        return res.status(500).json({
          success: false,
          error: result.error || 'Failed to send confirmation message',
        });
      }
    }

    if (type === 'members') {
      // Send notification to members (placeholder for future implementation)
      const memberMessage = `📢 *Circle Update*

Your circle admin has successfully linked this circle to WhatsApp! 

You will now receive real-time notifications for all circle updates.

Circle ID: ${circleId.slice(0, 10)}...`;

      appLogger.info('Member notification prepared', {
        circleId,
        memberMessage,
      });

      return res.status(200).json({
        success: true,
        message: 'Member notification prepared (actual sending requires member list)',
      });
    }

    return res.status(400).json({
      success: false,
      error: `Unknown notification type: ${type}`,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    appLogger.error('Error sending circle link notification', {
      error: errorMessage,
    });

    return res.status(500).json({
      success: false,
      error: errorMessage,
    });
  }
}

